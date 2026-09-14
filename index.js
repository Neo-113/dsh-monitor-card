/**
 * dsh-monitor-card — Host half.
 *
 * Mounts GET /dsh-monitor-card/status on the DSH web server (same origin,
 * :3080 — no new port) behind a module-owned sampler:
 *   - GPU:  nvidia-smi dual query (gpu-pulse design: parallel stats+name,
 *           4s timeout, 5min reprobe circuit after failure)
 *   - host: /proc/stat diff on a 1s latched tick, /proc/meminfo, /proc/loadavg
 *   - engine: SGLang :18080/metrics (1.5s timeout, degrades to online:false,
 *             never throws)
 *
 * Plugin contract (dsh 0.1.x, Cordis loader):
 *   - `inject = []`: webServer is fetched lazily via ctx.inject, so a
 *     headless profile without a web server still loads this plugin (the
 *     sampler tick lives inside the webServer effect and stops with it).
 *   - `Config` is the Schemastery schema for the entry config. The Cordis
 *     runtime validates entry config against it at fiber start
 *     (resolveConfig → Config["~standard"].validate, cordis lib/index.js:955);
 *     a misconfig throws ValidationError and fails this row loudly. So
 *     `apply` uses `config` as-is (validated, defaults applied) and must not
 *     parse it by hand (schemastery 3.x has no .parse method).
 *   - effect(...) owns all lifecycle: route unregistration and sampler stop
 *     are both effect cleanups, nothing manual.
 *
 * Engine metric mapping — FROZEN from a live scrape of
 * 127.0.0.1:18080/metrics on 2026-09-14 (a local sglang 0.5.x build, 106 unique
 * metric names; all carry the `sglang:` prefix):
 *   tokPerSec = sglang:gen_throughput            (gauge, first series)
 *               fallback: 1s delta of sglang:generation_tokens_total
 *               (sum over is_streaming, guarded against counter reset)
 *   kvPct     = sglang:token_usage * 100         (gauge 0..1, first series)
 *               fallback: Σ sglang:num_used_tokens / Σ sglang:max_total_num_tokens
 *   queue     = sglang:num_queue_reqs            (first series)
 *   running   = sglang:num_running_reqs          (first series)
 *   Notes: gpu-pulse's `generation_throughput` / `num_used_tokens total`
 *   formulas do not exist in this build variant; the names above are the
 *   real ones. Gauges are per-engine (same value on each tp_rank) so the
 *   first series is read; max_total_num_tokens is per-rank, so its
 *   fallback is summed.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

import Schema from '@deepseek-ai/schemastery';

export const name = 'dsh-monitor-card';

/** No hard required services; webServer is injected lazily inside apply. */
export const inject = [];

export const Config = Schema.object({
  pollMs: Schema.natural().min(500).default(1000),
  showPower: Schema.boolean().default(false),
  engineUrl: Schema.string().default('http://127.0.0.1:18080/metrics'),
  smiPath: Schema.string().default('nvidia-smi'),
});

/* ── internal constants (NOT tunable from cordis.yml) ─────────────────── */

const STATUS_PATH = '/dsh-monitor-card/status';
const TTL_MS = 800;              // collect cache: multiple tabs share one shot
const SMI_TIMEOUT_MS = 4000;
const ENGINE_TIMEOUT_MS = 1500;
const CPU_TICK_MS = 1000;
const REPROBE_MS = 5 * 60 * 1000; // circuit: reprobe smi after a failure
const SELFTEST_NOGPU = process.env.DMC_SELFTEST_NOGPU === '1'; // doc: machines/session where nvidia-smi is unavailable (e.g. a host dsh.service with a private /dev): skip the GPU field checks; GPU parsing is still exercised in the self-test output (ok:false + reason) and the route-level behavior is covered by Gate D's curl

/* ── process helpers ──────────────────────────────────────────────────── */

function runCmd(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const settle = (err, out = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ err, out });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      settle(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => settle(err));
    child.on('close', (code) => settle(
      code === 0
        ? null
        : new Error(`${cmd} exited ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}`),
      stdout,
    ));
  });
}

function splitCsvFirst(line) {
  // "0, NVIDIA GeForce RTX 3080" — a name may itself contain commas, so
  // split on the FIRST comma only.
  const cut = line.indexOf(',');
  return cut < 0
    ? [line.trim()]
    : [line.slice(0, cut).trim(), line.slice(cut + 1).trim()];
}

function readCpuTimes() {
  // /proc/stat line: "cpu  user nice system idle iowait irq softirq steal ..."
  const fields = readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/);
  const nums = fields.slice(1).map(Number);
  const idle = (nums[3] ?? 0) + (nums[4] ?? 0); // idle + iowait
  const total = nums.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return { idle, total };
}

function readMem() {
  const txt = readFileSync('/proc/meminfo', 'utf8');
  const kiB = (key) => {
    const m = txt.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
    return m ? Number(m[1]) : 0;
  };
  return { totalKiB: kiB('MemTotal'), availKiB: kiB('MemAvailable') };
}

function readLoad1() {
  return Number(readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/)[0]) || 0;
}

/* ── GPU (nvidia-smi dual query, gpu-pulse design) ───────────────────── */

const SMI_GPU_FIELDS = [
  'index',
  'utilization.gpu',
  'memory.used',
  'memory.total',
  'temperature.gpu',
  'power.draw',
];

async function collectGpuShot(cfg) {
  const q = (args) => runCmd(cfg.smiPath, args, SMI_TIMEOUT_MS);
  const [statsRes, nameRes] = await Promise.all([
    q(['--query-gpu', SMI_GPU_FIELDS.join(','), '--format=csv,noheader,nounits']),
    q(['--query-gpu', 'index,name', '--format=csv,noheader']),
  ]);
  if (statsRes.err || nameRes.err) {
    return { ok: false, reason: (statsRes.err || nameRes.err).message, gpus: [] };
  }
  const names = new Map();
  for (const line of nameRes.out.split('\n')) {
    if (!line.trim()) continue;
    const [idx, nm] = splitCsvFirst(line);
    if (idx !== undefined && nm !== undefined) names.set(idx, nm);
  }
  const num = (c) => {
    const v = Number(c);
    return Number.isFinite(v) ? v : null;
  };
  const gpus = [];
  for (const line of statsRes.out.split('\n')) {
    if (!line.trim()) continue;
    const cells = line.split(',').map((c) => c.trim());
    if (cells.length < 6) continue;
    gpus.push({
      index: Number(cells[0]),
      name: names.get(cells[0]) ?? `GPU ${cells[0]}`,
      util: num(cells[1]) ?? 0,
      memMiB: num(cells[2]) ?? 0,
      memTotalMiB: num(cells[3]) ?? 0,
      temp: num(cells[4]) ?? 0,
      powerW: num(cells[5]) ?? 0,
    });
  }
  if (!gpus.length) {
    return { ok: false, reason: 'nvidia-smi returned no GPU rows', gpus };
  }
  return { ok: true, reason: undefined, gpus };
}

/* Circuit: after a failure, do not re-run smi (each attempt can cost up to
 * the 4s timeout) before the reprobe instant; report the last reason. */
const gpuCircuit = { nextAt: 0, reason: null };

async function collectGpu(cfg) {
  const now = Date.now();
  if (gpuCircuit.nextAt > now) {
    return { ok: false, reason: gpuCircuit.reason, gpus: [] };
  }
  const shot = await collectGpuShot(cfg);
  if (!shot.ok) {
    gpuCircuit.nextAt = now + REPROBE_MS;
    gpuCircuit.reason = shot.reason;
  } else {
    gpuCircuit.nextAt = 0;
    gpuCircuit.reason = null;
  }
  return shot;
}

/* ── SGLang /metrics (frozen mapping, see header) ────────────────────── */

function metricValue(text, metric, { sum = false } = {}) {
  // First non-NaN value across series (default) or Σ over all series (sum).
  const prefix = `sglang:${metric}{`;
  let acc = 0;
  let count = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith(prefix)) continue;
    const end = line.indexOf('}');
    if (end < 0) continue;
    const value = Number(line.slice(end + 1).trim());
    if (!Number.isFinite(value)) continue;
    if (sum) {
      acc += value;
      count += 1;
    } else {
      return value;
    }
  }
  return sum ? (count ? acc : null) : null;
}

const engineState = { prevGen: null, prevGenTs: 0 };

async function collectEngine(cfg) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ENGINE_TIMEOUT_MS);
    let text;
    try {
      const res = await fetch(cfg.engineUrl, { signal: ctl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`http ${res.status}`);
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
    // tok/s: prefer the gen_throughput gauge; fall back to the
    // generation_tokens_total counter 1s delta (counter-reset guarded).
    let tokPerSec = metricValue(text, 'gen_throughput');
    const genTotal = metricValue(text, 'generation_tokens_total', { sum: true });
    if (tokPerSec === null && genTotal !== null && engineState.prevGen !== null) {
      const dt = Math.max(1, (Date.now() - engineState.prevGenTs) / 1000);
      const delta = genTotal - engineState.prevGen;
      tokPerSec = delta > 0 ? delta / dt : 0;
    }
    engineState.prevGen = genTotal;
    engineState.prevGenTs = Date.now();
    // KV occupancy: token_usage gauge (0..1); fallback used/capacity (summed).
    let kv = metricValue(text, 'token_usage');
    if (kv === null) {
      const used = metricValue(text, 'num_used_tokens', { sum: true }) ?? 0;
      const cap = metricValue(text, 'max_total_num_tokens', { sum: true });
      kv = cap ? used / cap : 0;
    }
    const toInt = (v) => (v === null || v === undefined ? 0 : Math.max(0, Math.round(v)));
    return {
      online: true,
      tokPerSec: tokPerSec === null ? 0 : Math.max(0, Math.round(tokPerSec * 10) / 10),
      kvPct: Math.round(Math.min(1, Math.max(0, kv)) * 100),
      queue: toInt(metricValue(text, 'num_queue_reqs')),
      running: toInt(metricValue(text, 'num_running_reqs')),
    };
  } catch {
    // Engine down/slow → degrade the row, never break the payload.
    return { online: false, tokPerSec: 0, kvPct: 0, queue: 0, running: 0 };
  }
}

/* ── sampler (CPU diff tick + collect cache) ─────────────────────────── */

let S = null; // module singleton, only live while the webServer effect is up

function startSampler() {
  if (S) return stop;
  const state = {
    lastCpu: null,   // { t, idle, total } — first tick sets the baseline
    cpuPct: null,    // unknown ≠ zero: null until the second diff exists
    cache: null,     // { ts, payload }
    inflight: null,  // Promise: concurrent polls share one collect
  };
  S = state;

  const tick = () => {
    const now = Date.now();
    try {
      const cur = readCpuTimes();
      if (state.lastCpu) {
        const dt = now - state.lastCpu.t;
        const dTotal = cur.total - state.lastCpu.total;
        const dIdle = cur.idle - state.lastCpu.idle;
        if (dt > 0 && dTotal > 0) {
          const pct = ((dTotal - dIdle) / dTotal) * 100;
          state.cpuPct = Math.round(Math.min(100, Math.max(0, pct)));
        }
      }
      state.lastCpu = { t: now, idle: cur.idle, total: cur.total };
    } catch {
      // /proc hiccup: keep the previous value
    }
  };
  tick();
  const timer = setInterval(tick, CPU_TICK_MS);

  function stop() {
    if (!S) return;
    clearInterval(timer);
    S = null;
  }
  return stop;
}

async function collectOnce(cfg) {
  const [gpu, engine] = await Promise.all([collectGpu(cfg), collectEngine(cfg)]);
  let mem = null;
  let load1 = null;
  try { mem = readMem(); } catch { /* host row degrades field by field */ }
  try { load1 = readLoad1(); } catch { /* ditto */ }
  return {
    ok: true,
    ts: Date.now(),
    gpu: gpu.ok ? { ok: true } : { ok: false, reason: gpu.reason },
    gpus: gpu.gpus,
    host: {
      cpuPct: stateOrNull(S)?.cpuPct ?? null,
      memPct: mem ? Math.round((1 - mem.availKiB / mem.totalKiB) * 100) : null,
      memUsedGiB: mem
        ? Math.round(((mem.totalKiB - mem.availKiB) / 1048576) * 10) / 10
        : null,
      memTotalGiB: mem ? Math.round((mem.totalKiB / 1048576) * 10) / 10 : null,
      load1,
    },
    engine,
    config: { pollMs: cfg.pollMs, showPower: cfg.showPower },
  };
}

function stateOrNull(s) {
  return s;
}

function collect(cfg) {
  if (!S) return collectOnce(cfg);
  if (S.cache && Date.now() - S.cache.ts < TTL_MS) return Promise.resolve(S.cache.payload);
  if (S.inflight) return S.inflight;
  S.inflight = collectOnce(cfg).then((payload) => {
    S.inflight = null;
    S.cache = { ts: Date.now(), payload };
    return payload;
  });
  return S.inflight;
}

/* ── route ────────────────────────────────────────────────────────────── */

function sendJson(res, status, obj, { head = false } = {}) {
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  if (head) {
    res.setHeader('content-length', Buffer.byteLength(body));
    res.end();
    return;
  }
  res.end(body);
}

async function handleStatus(cfg, req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    try {
      const payload = await collect(cfg);
      sendJson(res, 200, payload, { head: req.method === 'HEAD' });
    } catch (err) {
      // Defense in depth: collect() already degrades everything to typed
      // fields; this is the last line only.
      sendJson(
        res,
        500,
        { ok: false, error: String(err && err.message || err) },
        { head: req.method === 'HEAD' },
      );
    }
    return;
  }
  res.setHeader('allow', 'GET, HEAD');
  sendJson(res, 405, { ok: false, error: 'method not allowed' }, { head: req.method === 'HEAD' });
}

/* ── plugin entry ─────────────────────────────────────────────────────── */

/**
 * @param ctx codis plugin context
 * @param config validated entry config (Cordis `resolveConfig` applied our
 *   `Config` at fiber start; defaults are here — read, do not re-validate)
 */
export function apply(ctx, config) {
  const cfg = config;
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const stop = startSampler();
      const disposeRoute = host.webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: (req, res) => {
          handleStatus(cfg, req, res);
        },
      });
      return () => {
        disposeRoute();
        stop();
      };
    }, 'dsh-monitor-card: status route');
  });
}

/* ── selftest (DMC_SELFTEST=1, Gate C) ───────────────────────────────── */

if (process.env.DMC_SELFTEST === '1') {
  (async () => {
    let failures = 0;
    const fail = (msg) => {
      failures += 1;
      console.error(`[selftest] FAIL: ${msg}`);
    };
    const cfg = Config({}); // callable schema: applies defaults
    const stop = startSampler();
    await new Promise((r) => setTimeout(r, 1300)); // 1st CPU tick = baseline
    const payload = await collect(cfg);
    console.log(JSON.stringify(payload, null, 2));
    if (payload.host.cpuPct === null) fail('host.cpuPct is null on the second tick (sampler did not get a diff)');
    if (payload.host.memPct === null || payload.host.memTotalGiB === null) fail('host memory fields null');
    if (payload.host.load1 === null) fail('host.load1 null');
    if (!payload.gpu.ok && !SELFTEST_NOGPU) fail(`GPU source unavailable: ${payload.gpu.reason}`);
    if (!payload.gpu.ok && SELFTEST_NOGPU) console.error(`[selftest] note: GPU skipped (DMC_SELFTEST_NOGPU; ${payload.gpu.reason}) — real data is asserted post-install in the live dsh web (outside the session sandbox)`);
    for (const g of payload.gpus) {
      if (!(g.util >= 0 && g.util <= 100)) fail(`gpu ${g.index} util out of range: ${g.util}`);
      if (!(g.temp >= 0 && g.temp <= 125)) fail(`gpu ${g.index} temp out of range: ${g.temp}`);
      if (g.memMiB < 0 || g.memMiB > g.memTotalMiB) fail(`gpu ${g.index} mem beyond total`);
    }
    if (payload.engine.online && !(payload.engine.kvPct >= 0 && payload.engine.kvPct <= 100)) fail('engine.kvPct out of range');
    if (!payload.engine.online) console.error('[selftest] note: engine offline (allowed — sglang may be down)');
    stop();
    if (failures) {
      console.error(`[selftest] ${failures} check(s) failed`);
      process.exit(1);
    }
    console.log('[selftest] OK — compare the fields above against `nvidia-smi` / `top -bn1` right now');
    process.exit(0);
  })().catch((err) => {
    console.error('[selftest] crashed:', err);
    process.exit(1);
  });
}
