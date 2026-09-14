/**
 * dsh-monitor-card — Client half.
 *
 * Hand-written zero-build CJS bundle. Loader contract:
 *   window.__ModuleLoader__.load({ id, factory })  (dsh-client-modules;
 *   factory takes the loader's single-arg `require`; the platform seed table
 *   — react, react-dom/client, @deepseek-ai/cordis — resolves there,
 *   anything else throws).
 *
 * Exports contract:
 *   exports.name   = "dsh-monitor-card"
 *   exports.inject = ["slots"]   (effective client-side declaration; the
 *                                  package-level dsh.client.inject stays [])
 *   exports.apply  = (ctx) => { … }
 *
 * Data channel: fetch('/dsh-monitor-card/status') — the host's own web
 * server, same origin. connection.rpc is deliberately NOT used (silent
 * 405 bug for plugin-registered RPC in this dsh generation, guide #14).
 */
window.__ModuleLoader__.load({
  id: "dsh-monitor-card",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const PATH = "/dsh-monitor-card/status";
    const MIN_POLL_MS = 500;
    const STALE_MS = 30000;
    const LS_POS = "dsh-monitor-card:pos";
    const LS_SIZE = "dsh-monitor-card:size";
    const LS_HIDDEN = "dsh-monitor-card:hidden";
    const WIDTH = 340;
    const MIN_W = 280;
    const MIN_H = 112;
    const RESIZE_GAP = 12;

    /* yellow/red thresholds (two steps each, >= semantics);
       memMiB = absolute MiB (20G cards on this host) */
    const TH = {
      temp: [70, 80],
      memMiB: [19000, 19600],
      util: [60, 85],
      cpuPct: [80, 95],
      mem: [85, 95],
      kv: [80, 90],
    };
    const tone = ([w, r], v) =>
      v === null || v === undefined ? "ok" : v >= r ? "err" : v >= w ? "warn" : "ok";
    const worst = (...tones) =>
      tones.includes("err") ? "err" : tones.includes("warn") ? "warn" : "ok";
    const suf = (t) =>
      t === "warn" ? " warn" : t === "err" ? " err" : t === "off" ? " off" : "";
    const cls = (base, t) => base + suf(t);
    const fmtClock = (ts) => {
      const d = new Date(ts);
      const p = (x) => String(x).padStart(2, "0");
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };

    /* ── injected stylesheet (claim by data-plugin; removed on unmount) ── */
    const CSS = `
.dmc-card{position:fixed;box-sizing:border-box;width:${WIDTH}px;min-width:280px;min-height:112px;
  background:var(--dsw-alias-bg-layer-2,rgba(20,24,32,0.96));
  border:1px solid var(--dsw-alias-border-l2,#2b3342);
  border-radius:10px;
  box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.45));
  color:var(--dsw-alias-label-primary,#e7eaef);
  font:12px/1.5 var(--dsw-font-family,system-ui,sans-serif);
  pointer-events:auto;user-select:none;touch-action:none;
  overflow:auto;resize:both;z-index:2147483000;}
.dmc-row{display:flex;align-items:center;gap:7px;row-gap:3px;flex-wrap:wrap;padding:4px 12px;}
.dmc-dot{width:8px;height:8px;border-radius:50%;flex:none;
  background:var(--dsw-alias-state-success-primary,#22c55e);}
.dmc-dot.warn{background:var(--dsw-alias-state-warn-primary,#f59e0b);}
.dmc-dot.err{background:var(--dsw-alias-state-error-primary,#ef4444);}
.dmc-dot.off{background:var(--dsw-alias-label-tertiary,#8a93a6);}
.dmc-label{flex:none;white-space:nowrap;
  color:var(--dsw-alias-label-secondary,#c3c9d5);}
.dmc-sp{flex:1;}
.dmc-toggle-dot{width:10px;height:10px;border-radius:50%;flex:none;cursor:pointer;
  background:var(--dsw-alias-state-busin-primary,#3b82f6);}
.dmc-toggle-dot--floating{position:fixed;background:transparent;
  border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.6);z-index:2147483000;}
.dmc-val{white-space:nowrap;}
.dmc-val.warn{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#f59e0b));font-weight:500;}
.dmc-val.err{color:var(--dsw-alias-state-error-primary,#ef4444);font-weight:500;}
.dmc-val.off{color:var(--dsw-alias-label-tertiary,#8a93a6);}
.dmc-foot{display:flex;gap:10px;align-items:center;padding:5px 12px 7px;margin-top:3px;
  border-top:1px solid var(--dsw-alias-border-l1,#232a37);
  font-size:11px;color:var(--dsw-alias-label-tertiary,#8a93a6);}
.dmc-foot.stale{color:var(--dsw-alias-state-warn-primary,#f59e0b);}
`;

    /* ── position & size (drag + persist + reset) ─────────────────── */
    const defaultPos = () => ({
      left: Math.max(8, window.innerWidth - 16 - WIDTH),
      top: Math.max(8, window.innerHeight - 16 - 220),
    });
    const loadPos = () => {
      try {
        const raw = localStorage.getItem(LS_POS);
        if (raw) {
          const p = JSON.parse(raw);
          if (typeof p.left === "number" && typeof p.top === "number") {
            return {
              left: Math.min(Math.max(0, p.left), Math.max(0, window.innerWidth - 300)),
              top: Math.min(Math.max(0, p.top), Math.max(0, window.innerHeight - 80)),
            };
          }
        }
      } catch {
        /* private mode / corrupted value: fall through to default */
      }
      return defaultPos();
    };
    const defaultSize = () => ({ w: WIDTH, h: null });
    const loadSize = () => {
      try {
        const raw = localStorage.getItem(LS_SIZE);
        if (raw) {
          const s = JSON.parse(raw);
          const w = Math.round(Number(s.w));
          if (Number.isFinite(w) && w >= MIN_W) {
            const h = Math.round(Number(s.h));
            return { w, h: Number.isFinite(h) && h > 0 ? h : null };
          }
        }
      } catch {
        /* private mode / corrupted value: fall through to default */
      }
      return defaultSize();
    };
    const loadHidden = () => {
      try {
        return localStorage.getItem(LS_HIDDEN) === "1";
      } catch {
        /* private mode / corrupted value: fall through to visible */
      }
      return false;
    };

    /* ── presentational pieces ─────────────────────────────────────── */
    const Dot = ({ t }) => h("span", { className: cls("dmc-dot", t) });
    const Val = ({ t, children }) => h("span", { className: cls("dmc-val", t) }, children);
    const Row = ({ label, tip, t, children }) =>
      h(
        "div",
        { className: "dmc-row" },
        h(Dot, { t }),
        h("span", { className: "dmc-label", title: tip || label }, label),
        h("span", { className: "dmc-sp" }),
        children,
      );

    const gpuRow = (g, showPower) => {
      const t = worst(tone(TH.temp, g.temp), tone(TH.memMiB, g.memMiB), tone(TH.util, g.util));
      return h(
        Row,
        { label: `GPU ${g.index}`, tip: g.name, t, key: g.index },
        h(Val, { t: tone(TH.temp, g.temp) }, `${g.temp}°C`),
        h(Val, { t: tone(TH.util, g.util) }, `${g.util}%`),
        h(
          Val,
          { t: tone(TH.memMiB, g.memMiB) },
          `${g.memMiB}/${g.memTotalMiB} MiB`,
        ),
        showPower
          ? h(Val, { t: "ok" }, `${Math.round(g.powerW)}W`)
          : null,
      );
    };

    function MonitorCard() {
      const [data, setData] = useState(null); // last payload; null until first ok
      const [lastOkAt, setLastOkAt] = useState(0);
      const [now, setNow] = useState(Date.now());
      const [pos, setPos] = useState(loadPos);
      const [size, setSize] = useState(loadSize);
      const [hidden, setHidden] = useState(loadHidden);
      const [dotPos, setDotPos] = useState({ left: 24, top: 24 });
      const cardRef = useRef(null);
      const posRef = useRef(pos);
      const sizeRef = useRef(size);
      const pollRef = useRef(1000);
      pollRef.current = data ? Math.max(MIN_POLL_MS, Number(data.config && data.config.pollMs) || 0) : 1000;
      posRef.current = pos;
      sizeRef.current = size;

      /* 1) stylesheet injection (idempotent; removed on unmount) */
      useEffect(() => {
        if (document.head.querySelector('style[data-plugin="dsh-monitor-card"]')) return undefined;
        const el = document.createElement("style");
        el.setAttribute("data-plugin", "dsh-monitor-card");
        el.textContent = CSS;
        document.head.appendChild(el);
        return () => el.remove();
      }, []);

      /* 2) raise the overlay layer's z-index (gpu-pulse 1.0.1 fix):
             first ancestor with position:absolute && pointer-events:none
             is the click-through overlay; put us above the side cards
             (z 25/40/42) without blocking clicks. */
      useEffect(() => {
        let el = cardRef.current;
        while (el) {
          const st = window.getComputedStyle(el);
          if (st.position === "absolute" && st.pointerEvents === "none") {
            el.style.zIndex = "2147483000";
            break;
          }
          el = el.parentElement;
        }
      }, []);

      /* 3) polling: in-flight guard (reschedule in 200ms), keep the last
             frame on failure, pollMs comes from the response config. */
      useEffect(() => {
        let stopped = false;
        let inflight = false;
        let timer = 0;
        const loop = async () => {
          if (stopped) return;
          if (hidden) {
            /* card hidden: park the loop (no fetch) until shown again */
            timer = setTimeout(loop, 1000);
            return;
          }
          if (inflight) {
            timer = setTimeout(loop, 200);
            return;
          }
          inflight = true;
          try {
            const resp = await fetch(PATH, { cache: "no-store" });
            if (resp.ok) {
              const payload = await resp.json();
              if (payload && payload.ok) {
                setData(payload);
                setLastOkAt(Date.now());
              }
            }
            /* non-ok: keep the last frame */
          } catch {
            /* network failure: keep the last frame */
          }
          inflight = false;
          if (!stopped) timer = setTimeout(loop, pollRef.current);
        };
        loop();
        const staleTimer = setInterval(() => setNow(Date.now()), 5000);
        return () => {
          stopped = true;
          clearTimeout(timer);
          clearInterval(staleTimer);
        };
      }, [hidden]);

      /* 4) drag (button 0), clamped to the window; commit on mouseup. */
      const onDragStart = useCallback(
        (e) => {
          if (e.button !== 0) return;
          const card = cardRef.current;
          if (!card) return;
          /* bottom-right corner = native resize grip (CSS resize:both).
             The custom drag must not start within RESIZE_GAP of the corner,
             otherwise it swallows the browser's native resize gesture. */
          const r = card.getBoundingClientRect();
          if (e.clientX >= r.right - RESIZE_GAP && e.clientY >= r.bottom - RESIZE_GAP) {
            return;
          }
          e.preventDefault();
          const startX = e.clientX;
          const startY = e.clientY;
          const start = { ...posRef.current };
          const move = (ev) => {
            const w = card.offsetWidth || WIDTH;
            const hEl = card.offsetHeight || 220;
            const nl = Math.min(
              Math.max(0, start.left + (ev.clientX - startX)),
              Math.max(0, window.innerWidth - w),
            );
            const nt = Math.min(
              Math.max(0, start.top + (ev.clientY - startY)),
              Math.max(0, window.innerHeight - hEl),
            );
            setPos({ left: nl, top: nt });
          };
          const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            try {
              localStorage.setItem(LS_POS, JSON.stringify(posRef.current));
            } catch {
              /* private mode: silent */
            }
          };
          window.addEventListener("mousemove", move);
          window.addEventListener("mouseup", up);
        },
        [],
      );

      const onReset = useCallback(() => {
        try {
          localStorage.removeItem(LS_POS);
          localStorage.removeItem(LS_SIZE);
        } catch {
          /* silent */
        }
        setPos(defaultPos());
        setSize(defaultSize());
      }, []);

      /* 5b) hide/show toggle: the footer dot hides the card; a floating
             white ring stays at the footer-left spot to bring it back. */
      const toggleHide = useCallback(() => {
        setHidden((h) => {
          if (!h && cardRef.current) {
            const r = cardRef.current.getBoundingClientRect();
            setDotPos({ left: r.left + 12, top: r.bottom - 20 });
          }
          return !h;
        });
      }, []);
      useEffect(() => {
        try {
          localStorage.setItem(LS_HIDDEN, hidden ? "1" : "0");
        } catch {
          /* private mode: silent */
        }
      }, [hidden]);

      /* 5) re-clamp when the window shrinks (position + user-set size) */
      useEffect(() => {
        const onWinResize = () => {
          const card = cardRef.current;
          const p = posRef.current;
          const s = sizeRef.current;
          const wNow = card && card.offsetWidth ? card.offsetWidth : s.w || WIDTH;
          const hNow = card && card.offsetHeight ? card.offsetHeight : s.h || 220;
          const w = Math.min(wNow, Math.max(8, window.innerWidth - 8));
          const hEl = Math.min(hNow, Math.max(8, window.innerHeight - 8));
          const nl = Math.min(p.left, Math.max(0, window.innerWidth - w));
          const nt = Math.min(p.top, Math.max(0, window.innerHeight - hEl));
          if (nl !== p.left || nt !== p.top) setPos({ left: nl, top: nt });
          if ((s.w && wNow > window.innerWidth - 8) || (s.h && hNow > window.innerHeight - 8)) {
            const nextW = s.w ? Math.max(MIN_W, Math.min(s.w, window.innerWidth - 8)) : s.w;
            const nextH = s.h ? Math.max(MIN_H, Math.min(s.h, window.innerHeight - 8)) : s.h;
            setSize({ w: nextW, h: nextH });
            try {
              localStorage.setItem(LS_SIZE, JSON.stringify({ w: nextW, h: nextH }));
            } catch {
              /* silent */
            }
          }
        };
        window.addEventListener("resize", onWinResize);
        return () => window.removeEventListener("resize", onWinResize);
      }, []);

      /* 6) native resize corner: persist the user's manual width/height.
             Uses ResizeObserver instead of the element's `resize` event:
             the engine's event emission on a CSS-resizable corner is flaky,
             while the RO fires on every box change. Re-runs on [hidden]
             because the hide/show cycle replaces the card element, which
             would otherwise be left unobserved after the first toggle. */
      useEffect(() => {
        const card = cardRef.current;
        if (!card) return undefined;
        const onCardResize = () => {
          const w = card.offsetWidth;
          const hEl = card.offsetHeight;
          const s = sizeRef.current;
          if (!w || !hEl || (w === s.w && hEl === s.h)) return;
          setSize({ w, h: hEl });
          try {
            localStorage.setItem(LS_SIZE, JSON.stringify({ w, h: hEl }));
          } catch {
            /* silent */
          }
        };
        const ro = new ResizeObserver(onCardResize);
        ro.observe(card);
        return () => ro.disconnect();
      }, [hidden]);

      const stale = lastOkAt > 0 && now - lastOkAt > STALE_MS;
      const showPower = !!(data && data.config && data.config.showPower);
      const rows = [];
      if (!data) {
        rows.push(
          h(Row, { label: "等待首帧", t: "off", key: "wait" }, h(Val, { t: "off" }, "…")),
        );
      } else {
        if (data.gpu && data.gpu.ok) {
          for (const g of data.gpus) rows.push(gpuRow(g, showPower));
        } else {
          rows.push(
            h(
              Row,
              { label: "GPU", t: "off", key: "gpu-off" },
              h(Val, { t: "off" }, `不可用${data.gpu && data.gpu.reason ? ` · ${String(data.gpu.reason).slice(0, 24)}` : ""}`),
            ),
          );
        }
        const hv = data.host || {};
        rows.push(
          h(
            Row,
            { label: "主机", t: worst(tone(TH.cpuPct, hv.cpuPct), tone(TH.mem, hv.memPct)), key: "host" },
            h(Val, { t: tone(TH.cpuPct, hv.cpuPct) }, `CPU ${hv.cpuPct === null ? "–" : hv.cpuPct + "%"}`),
            h(Val, { t: tone(TH.mem, hv.memPct) }, `内存 ${hv.memPct === null ? "–" : hv.memPct + "%"}`),
            h(Val, { t: "ok" }, `load ${hv.load1 === null ? "–" : hv.load1}`),
          ),
        );
        if (data.engine && data.engine.online) {
          const qTone = data.engine.queue > 10 ? "err" : data.engine.queue > 0 ? "warn" : "ok";
          rows.push(
            h(
              Row,
              {
                label: "引擎",
                t: worst(tone(TH.kv, data.engine.kvPct), qTone),
                key: "engine",
              },
              h(Val, { t: "ok" }, `${data.engine.tokPerSec} tok/s`),
              h(Val, { t: tone(TH.kv, data.engine.kvPct) }, `KV ${data.engine.kvPct}%`),
              h(Val, { t: qTone }, `排队 ${data.engine.queue} / 在跑 ${data.engine.running}`),
            ),
          );
        } else {
          rows.push(
            h(Row, { label: "引擎", t: "off", key: "engine-off" }, h(Val, { t: "off" }, "引擎离线")),
          );
        }
      }

      if (hidden) {
        return h(
          "div",
          {
            className: "dmc-toggle-dot dmc-toggle-dot--floating",
            style: { left: dotPos.left, top: dotPos.top },
            title: "点一下恢复悬浮卡",
            onClick: (e) => {
              e.stopPropagation();
              toggleHide();
            },
          },
        );
      }

      return h(
        "div",
        {
          ref: cardRef,
          className: "dmc-card",
          style: {
            left: pos.left,
            top: pos.top,
            width: size.w,
            height: size.h ? size.h : undefined,
          },
          onMouseDown: onDragStart,
          onDoubleClick: (e) => {
            e.preventDefault();
            onReset();
          },
          title: "拖动移动 · 右下角拉角调尺寸 · 双击复位",
        },
        rows,
        h(
          "div",
          { className: stale || !data ? "dmc-foot stale" : "dmc-foot" },
          h("span", {
            className: "dmc-toggle-dot",
            title: "点一下隐藏悬浮卡",
            onMouseDown: (e) => e.stopPropagation(),
            onClick: (e) => {
              e.stopPropagation();
              toggleHide();
            },
          }),
          h("span", null, "dsh-monitor-card"),
          h("span", { className: "dmc-sp" }),
          h("span", null, data ? `采样 ${fmtClock(data.ts)}` : "等待首帧"),
        ),
      );
    }

    /* ── plugin entry (client) ─────────────────────────────────────── */
    function apply(ctx) {
      /* R2 fallback runs unconditionally — it is the last resort precisely
         when ctx.slots (or the shell.overlay slot) is missing. The shell
         overlay slot is confirmed to exist in source; if it ever becomes
         absent, at 10s (if our card is still not in the document) we
         direct-mount via createRoot on the [data-shell-overlay] container —
         the workbench client is the live implementation of this path. */
      const t0 = Date.now();
      let booted = false;
      const check = setInterval(() => {
        if (booted) return;
        if (document.querySelector(".dmc-card")) {
          booted = true;
          clearInterval(check);
          return;
        }
        if (Date.now() - t0 > 10000) {
          clearInterval(check);
          const overlay = document.querySelector("[data-shell-overlay]");
          if (overlay && !overlay.querySelector(".dmc-card")) {
            try {
              const RDC = require("react-dom/client");
              const root = RDC.createRoot(overlay);
              root.render(h(MonitorCard, null));
              console.warn("[dsh-monitor-card] shell.overlay slot absent; R2 direct mount");
            } catch (e) {
              console.warn("[dsh-monitor-card] R2 fallback failed:", e);
            }
          } else if (!overlay) {
            console.warn("[dsh-monitor-card] no [data-shell-overlay] container; not mounted");
          }
        }
      }, 1000);

      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") {
        console.warn("[dsh-monitor-card] ctx.slots missing; relying on the R2 direct-mount fallback (see plan R2)");
        return;
      }
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          {
            name: "shell.overlay",
            id: "dsh-monitor-card",
            order: 50,
            label: () => "机器状态",
          },
          () => {
            booted = true;
            return h(MonitorCard, null);
          },
        ),
      );
    }

    exports.name = "dsh-monitor-card";
    exports.inject = ["slots"];
    exports.apply = apply;
    return module.exports;
  },
});
