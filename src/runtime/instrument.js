"use strict";

const MOUNT_KEY = "__routeRegistryMountPath";
const PATCHED = Symbol.for("express-recon.instrumented");

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
  express[PATCHED] = true;
  return express;
}

function appStack(app) {
  return (app.router && app.router.stack) || (app._router && app._router.stack) || null;
}

function wrapUse(proto, getStack) {
  const original = proto.use;
  proto.use = function instrumentedUse(...args) {
    const path = typeof args[0] === "string" ? args[0] : null;
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

module.exports = { instrument, MOUNT_KEY };
