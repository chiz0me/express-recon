"use strict";

const { walk } = require("./walk");
const { scan } = require("./static/scan");
const { classify } = require("./classify");
const { reconcile } = require("./reconcile");

/**
 * Produce a raw route inventory — routes, middleware chains, and source
 * locations, with no security judgment attached. This is the atomic primitive:
 * `audit()` is a lens over it.
 *
 * @param {object} opts
 * @param {"static"|"runtime"|"hybrid"} opts.mode
 * @param {string} [opts.src]  repo root (static/hybrid)
 * @param {object} [opts.app]  loaded Express app (runtime/hybrid)
 * @returns {{routes: object[], globalMiddleware: object[]}}
 */
function inventory(opts) {
  const { mode } = opts;
  if (mode === "runtime") return walk(requireApp(opts));
  if (mode === "static") return scan(requireSrc(opts));
  if (mode === "hybrid") return reconcile(scan(requireSrc(opts)), walk(requireApp(opts)));
  throw new Error(`inventory: unknown mode "${mode}"`);
}

/**
 * Classify an inventory against an auth allowlist (adds `authStatus`/`tags`).
 *
 * @param {object} opts  same shape as `inventory`
 * @param {{authMiddleware?: Record<string,string>}} [config]
 * @returns {{routes: object[], globalMiddleware: object[]}}
 */
function audit(opts, config) {
  const cfg = config || {};
  const { mode } = opts;
  if (mode === "hybrid") {
    const staticReg = classify(scan(requireSrc(opts)), cfg);
    const runtimeReg = classify(walk(requireApp(opts)), cfg);
    return reconcile(staticReg, runtimeReg);
  }
  return classify(inventory(opts), cfg);
}

function requireSrc(opts) {
  if (!opts.src) throw new Error(`mode "${opts.mode}" requires a source directory`);
  return opts.src;
}

function requireApp(opts) {
  if (!opts.app) throw new Error(`mode "${opts.mode}" requires a loaded Express app`);
  return opts.app;
}

module.exports = { inventory, audit };
