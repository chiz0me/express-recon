"use strict";

const MOUNT_KEY = "__routeRegistryMountPath";
const SOURCE_KEY = "__routeRegistrySource";
const PATCHED = Symbol.for("express-recon.instrumented");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "all"];

/**
 * Tag every layer added by a `use()` call with its original mount-path string.
 *
 * Express 5 compiles mount paths into path-to-regexp matcher closures and keeps
 * no recoverable copy of the source string on the layer, so a post-hoc walk
 * can't reconstruct `app.use("/admin", router)` prefixes. Capturing the raw
 * `path` argument at registration time is the only reliable way, and it works
 * uniformly across Express 4 and 5.
 *
 * Must be called on the SAME express module instance the app uses, BEFORE the
 * app registers its routes. Idempotent.
 *
 * @param {Function} express  the express module (`require("express")`)
 * @returns {Function} express  the same instance, for chaining
 */
function instrument(express) {
  if (express[PATCHED]) return express;
  // Express 5's Router() chains instance → per-call Router object → shared
  // Router.prototype; patching the immediate prototype would only affect the
  // probe instance. Walk to the object that actually OWNS the methods (also
  // correct on Express 4, where it's the module-level proto singleton).
  const routerProto = ownerOf(express.Router(), "route");
  const targets = [
    { proto: express.application, getStack: appStack },
    { proto: routerProto, getStack: (r) => r.stack },
  ];
  for (const { proto, getStack } of targets) wrapUse(proto, getStack);
  // Every verb registration (`app.get`, `router.get`, `.route().get()`) funnels
  // through the Route prototype, reachable only via a constructed instance.
  wrapRouteVerbs(Object.getPrototypeOf(express.Router().route("/__recon-probe")));
  // Wrapped AFTER the probe `.route()` call above, so the probe router itself
  // is never captured.
  wrapRoute(routerProto);
  express[PATCHED] = true;
  return express;
}

/**
 * Apps and routers seen registering routes/middleware, so a boot that throws
 * AFTER wiring can still be walked (`harvestApp`) instead of yielding nothing.
 * Process-global, like the prototype patches — callers reset per boot.
 */
const capturedRoots = new Set();

/** Nearest object in `obj`'s prototype chain that owns `prop`. */
function ownerOf(obj, prop) {
  let p = obj;
  while (p !== null && !Object.prototype.hasOwnProperty.call(p, prop)) {
    p = Object.getPrototypeOf(p);
  }
  return p;
}

function resetCapture() {
  capturedRoots.clear();
}

/**
 * Every verb registration reaches its router through `Router#route`; capture
 * `this` there (the Route-proto verb wrappers see a Route, which isn't
 * walkable).
 */
function wrapRoute(routerProto) {
  const original = routerProto.route;
  routerProto.route = function instrumentedRoute(...args) {
    capturedRoots.add(this);
    return original.apply(this, args);
  };
}

function stackOf(candidate) {
  if (!candidate) return null;
  if (Array.isArray(candidate.stack)) return candidate.stack;
  return appStack(candidate);
}

/** Express 4's deprecated `app.router` getter throws, so `_router` comes first. */
function appRouter(app) {
  if (!app) return null;
  if (app._router && Array.isArray(app._router.stack)) return app._router;
  try {
    if (app.router && Array.isArray(app.router.stack)) return app.router;
  } catch {
    // Express 4 app.router; no usable router exists if _router was absent.
  }
  return null;
}

function collectNested(root, nested, seen) {
  const stack = stackOf(root);
  if (!stack) return;
  for (const layer of stack) {
    const handle = layer.handle;
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    nested.add(handle);
    const inner = appRouter(handle);
    if (inner) nested.add(inner);
    collectNested(handle, nested, seen);
  }
}

/**
 * Top-level captured candidates: sub-routers reachable from another captured
 * entry's stack are dropped (they'd double-count), as is an app's own internal
 * router when the app itself was captured. Apps sort before bare routers.
 */
function getCapturedRoots() {
  const roots = [...capturedRoots];
  const nested = new Set();
  const seen = new Set();
  for (const root of roots) {
    collectNested(root, nested, seen);
    const inner = appRouter(root);
    if (inner) nested.add(inner);
  }
  const isApp = (c) => (typeof c.set === "function" && appStack(c) ? 1 : 0);
  return roots.filter((r) => !nested.has(r)).sort((a, b) => isApp(b) - isApp(a));
}

/**
 * Merge captured roots into one walkable host. Multiple disjoint roots (a boot
 * that died before wiring them together) become a synthetic root router; each
 * layer keeps its MOUNT_KEY prefix, and the `use` no-op satisfies walk()'s
 * app-or-Router guard.
 */
function harvestApp(roots) {
  if (roots.length === 1) return roots[0];
  const stack = [];
  for (const root of roots) {
    const s = stackOf(root);
    if (s) stack.push(...s);
  }
  return { stack, use() {} };
}

/**
 * First stack frame that is app code: not node internals, not express (or any
 * other package under node_modules), and not this module.
 */
function callSite(err) {
  const lines = (err.stack || "").split("\n").slice(1);
  for (const frame of lines) {
    const match = frame.match(/\(?([^()\s]+):(\d+):\d+\)?$/);
    if (!match) continue;
    const file = match[1];
    if (file.startsWith("node:") || file.includes("node_modules") || file === __filename) continue;
    return { file, line: Number(match[2]) };
  }
  return null;
}

/**
 * Tag every layer a verb registration appends with its call site, so runtime
 * routes get a `source: {file, line}` like static ones — and reconcile can
 * match static↔runtime routes by registration site instead of guessing by
 * path suffix.
 */
function wrapRouteVerbs(routeProto) {
  for (const method of HTTP_METHODS) {
    const original = routeProto[method];
    if (typeof original !== "function") continue;
    const wrapper = function instrumentedVerb(...args) {
      const err = {};
      Error.captureStackTrace(err, wrapper);
      const before = this.stack ? this.stack.length : 0;
      const result = original.apply(this, args);
      const source = callSite(err);
      if (source && this.stack) {
        for (let i = before; i < this.stack.length; i++) {
          if (this.stack[i][SOURCE_KEY] === undefined) this.stack[i][SOURCE_KEY] = source;
        }
      }
      return result;
    };
    routeProto[method] = wrapper;
  }
}

function appStack(app) {
  const router = appRouter(app);
  return router ? router.stack : null;
}

function isPathArg(arg) {
  if (typeof arg === "string") return true;
  return Array.isArray(arg) && arg.length > 0 && arg.every((p) => typeof p === "string");
}

function wrapUse(proto, getStack) {
  const original = proto.use;
  proto.use = function instrumentedUse(...args) {
    capturedRoots.add(this);
    const path = isPathArg(args[0]) ? args[0] : null;
    const before = getStack(this) ? getStack(this).length : 0;
    const result = original.apply(this, args);
    const stack = getStack(this);
    if (stack && path !== null) {
      for (let i = before; i < stack.length; i++) {
        if (stack[i][MOUNT_KEY] === undefined) stack[i][MOUNT_KEY] = path;
      }
    }
    return result;
  };
}

module.exports = {
  instrument,
  resetCapture,
  getCapturedRoots,
  harvestApp,
  MOUNT_KEY,
  SOURCE_KEY,
};
