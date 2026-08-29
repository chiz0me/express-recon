"use strict";

const path = require("node:path");
const { walk } = require("./walk");
const { scan } = require("./static/scan");
const { classify } = require("./classify");
const { reconcile } = require("./reconcile");
const { evaluatePolicies } = require("./policies");
const { validateConfig } = require("./config");

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
  if (mode === "hybrid") {
    const staticRegistry = scan(requireSrc(opts), scanOpts);
    return reconcile(staticRegistry, hybridRuntimeInventory(opts, staticRegistry));
  }
  throw new Error(`inventory: unknown mode "${mode}"`);
}

/**
 * Classify an inventory against an auth allowlist (adds `authStatus`/`tags`).
 *
 * @param {object} opts  same shape as `inventory`
 * @param {{authMiddleware?: Record<string,string|object>, authWrappers?: string[], acceptedPublic?: (string|{applicationId:string,method:string,path:string})[], policies?: object[]}} [config]
 * @returns {{routes: object[], globalMiddleware: object[]}}
 */
function audit(opts, config) {
  const cfg = validateConfig(config || {});
  const { mode } = opts;
  if (mode === "hybrid") {
    const staticInventory = scan(requireSrc(opts), scanOptions(opts));
    const staticReg = classify(staticInventory, cfg);
    const runtimeReg = classify(hybridRuntimeInventory(opts, staticInventory), cfg);
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
    maxFiles: opts.maxFiles,
    maxFileBytes: opts.maxFileBytes,
    maxTotalBytes: opts.maxTotalBytes,
    timeoutMs: opts.timeoutMs,
  };
}

function runtimeInventory(opts) {
  if (opts.runtimeRegistry) return opts.runtimeRegistry;
  return walk(requireApp(opts));
}

function hybridApplicationId(opts, staticRegistry) {
  const ids = new Set((staticRegistry.applications || []).map((application) => application.id));
  if (opts.applicationId) {
    if (!ids.has(opts.applicationId)) {
      throw new Error(
        `hybrid applicationId ${JSON.stringify(opts.applicationId)} was not found by static discovery`,
      );
    }
    return opts.applicationId;
  }
  if (!opts.runtimeEntry) return null;
  const entry = path.resolve(opts.runtimeEntry);
  const matches = (staticRegistry.applications || []).filter(
    (application) => application.source?.file && path.resolve(application.source.file) === entry,
  );
  return matches.length === 1 ? matches[0].id : null;
}

function hybridRuntimeInventory(opts, staticRegistry) {
  const registry = runtimeInventory(opts);
  const applicationId = hybridApplicationId(opts, staticRegistry);
  if (!applicationId) return registry;
  return {
    ...registry,
    routes: registry.routes.map((route) => ({ ...route, applicationId })),
    applications: [
      {
        ...(registry.applications?.[0] || {
          name: "runtime application",
          source: null,
          globalMiddleware: registry.globalMiddleware || [],
        }),
        id: applicationId,
        routeCount: registry.routes.length,
      },
    ],
  };
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
