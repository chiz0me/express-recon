"use strict";

const { walk } = require("./walk");
const { scan } = require("./static/scan");
const { classify } = require("./classify");
const { reconcile } = require("./reconcile");
const { evaluatePolicies } = require("./policies");

/**
 * Produce a raw route inventory — routes, middleware chains, and source
 * locations, with no security judgment attached. This is the atomic primitive:
 * `audit()` is a lens over it.
 *
 * @param {object} opts
 * @param {"static"|"runtime"|"hybrid"} opts.mode
 * @param {string} [opts.src]  repo root (static/hybrid)
 * @param {object} [opts.app]  loaded Express app (runtime/hybrid library use)
 * @param {object} [opts.runtimeRegistry] serialized worker result (runtime/hybrid CLI use)
 * @returns {{routes: object[], globalMiddleware: object[]}}
 */
function inventory(opts) {
  const { mode } = opts;
  const scanOpts = scanOptions(opts);
  if (mode === "runtime") return runtimeInventory(opts);
  if (mode === "static") return scan(requireSrc(opts), scanOpts);
  if (mode === "hybrid") return reconcile(scan(requireSrc(opts), scanOpts), runtimeInventory(opts));
  throw new Error(`inventory: unknown mode "${mode}"`);
}

/**
 * Classify an inventory against an auth allowlist (adds `authStatus`/`tags`).
 *
 * @param {object} opts  same shape as `inventory`
 * @param {{authMiddleware?: Record<string,string|object>, authWrappers?: string[], acceptedPublic?: string[], policies?: object[]}} [config]
 * @returns {{routes: object[], globalMiddleware: object[]}}
 */
function audit(opts, config) {
  const cfg = config || {};
  const { mode } = opts;
  if (mode === "hybrid") {
    const staticReg = classify(scan(requireSrc(opts), scanOptions(opts)), cfg);
    const runtimeReg = classify(runtimeInventory(opts), cfg);
    return evaluatePolicies(reconcile(staticReg, runtimeReg), cfg.policies);
  }
  return evaluatePolicies(classify(inventory(opts), cfg), cfg.policies);
}

function scanOptions(opts) {
  return {
    includeTests: opts.includeTests,
    include: opts.include,
    exclude: opts.exclude,
    ignoreFile: opts.ignoreFile,
  };
}

function runtimeInventory(opts) {
  if (opts.runtimeRegistry) return opts.runtimeRegistry;
  return walk(requireApp(opts));
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
