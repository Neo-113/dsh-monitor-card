#!/usr/bin/env node
/**
 * Gate B — client half stub-loader assertions (node side; NOT shipped in the
 * tgz). Verifies, without a browser:
 *   1. the bundle calls window.__ModuleLoader__.load exactly once, correct id;
 *   2. the factory executes without exception (seed requires only "react");
 *   3. exports contract: name / inject=["slots"] / apply is a function;
 *   4. apply(ctx) with a stub ctx.slots: inject("shell.overlay") fires and the
 *      captured register options are correct; the component factory returns a
 *      React element.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");

/* minimal React stub — just enough for the bundle's factory scope */
const h = (type, props, ...children) => ({
  type,
  props: props || {},
  children: children.length === 1 ? children[0] : children,
});
const reactStub = {
  createElement: h,
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn,
};

/* minimal window: only __ModuleLoader__ is touched at bundle load time */
let loaded = null;
global.window = {
  __ModuleLoader__: {
    load: (mod) => {
      if (loaded) throw new Error("load called more than once");
      loaded = mod;
    },
  },
};

const bundle = fs.readFileSync(path.join(__dirname, "client.js"), "utf8");
const requireSeed = (name) => {
  if (name === "react") return reactStub;
  if (name === "react-dom/client") {
    return { createRoot: () => ({ render: () => {}, unmount: () => {} }) };
  }
  throw new Error("unexpected require: " + name);
};

eval(bundle); // bundle top level registers the module (factory not run yet)

assert(loaded, "window.__ModuleLoader__.load was not called");
assert.strictEqual(loaded.id, "dsh-monitor-card");
assert.strictEqual(typeof loaded.factory, "function");

const mod = loaded.factory(requireSeed);
assert.strictEqual(mod.name, "dsh-monitor-card");
assert.deepStrictEqual(mod.inject, ["slots"]);
assert.strictEqual(typeof mod.apply, "function");

let injectedKey = null;
let registered = null;
const ctx = {
  slots: {
    inject: (key, fn) => {
      injectedKey = key;
      fn();
      return () => {};
    },
    register: (opts, comp) => {
      registered = { opts, comp };
      return () => {};
    },
  },
};
mod.apply(ctx);

assert.strictEqual(injectedKey, "shell.overlay");
assert(registered, "register was not called");
assert.strictEqual(registered.opts.id, "dsh-monitor-card");
assert.strictEqual(registered.opts.name, "shell.overlay");
assert.strictEqual(typeof registered.opts.label(), "string");
const el = registered.comp();
assert(el && el.type, "component factory did not return a react element");

console.log("Gate B OK: load x1 / factory / exports / apply->inject->register all pass");
process.exit(0);
