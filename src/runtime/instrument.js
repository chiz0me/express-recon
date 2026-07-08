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
  const targets = [
    { proto: express.application, getStack: appStack },
    { proto: Object.getPrototypeOf(express.Router()), getStack: (r) => r.stack },
  ];
  for (const { proto, getStack } of targets) wrapUse(proto, getStack);
  // Every verb registration (`app.get`, `router.get`, `.route().get()`) funnels
  // through the Route prototype, reachable only via a constructed instance.
  wrapRouteVerbs(Object.getPrototypeOf(express.Router().route("/__recon-probe")));
  express[PATCHED] = true;
  return express;
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
  return (app.router && app.router.stack) || (app._router && app._router.stack) || null;
}

function isPathArg(arg) {
  if (typeof arg === "string") return true;
  return Array.isArray(arg) && arg.length > 0 && arg.every((p) => typeof p === "string");
}

function wrapUse(proto, getStack) {
  const original = proto.use;
  proto.use = function instrumentedUse(...args) {
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

module.exports = { instrument, MOUNT_KEY, SOURCE_KEY };
