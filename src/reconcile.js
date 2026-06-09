"use strict";

function key(route) {
  return `${route.method} ${route.path}`;
}

/**
 * Merge a static and a runtime registry into one, tagging each route with how
 * it was observed. Static routes carry source file/line; runtime-only routes
 * (e.g. dynamically registered ones static analysis can't see) are surfaced so
 * the audit doesn't miss them.
 *
 * @param {{routes: object[], globalMiddleware: object[]}} staticReg
 * @param {{routes: object[], globalMiddleware: object[]}} runtimeReg
 * @returns {{routes: object[], globalMiddleware: object[]}}
 */
function reconcile(staticReg, runtimeReg) {
  const runtimeKeys = new Set(runtimeReg.routes.map(key));
  const staticKeys = new Set(staticReg.routes.map(key));
  const routes = [];
  for (const route of staticReg.routes) {
    routes.push({ ...route, presence: runtimeKeys.has(key(route)) ? "both" : "static-only" });
  }
  for (const route of runtimeReg.routes) {
    if (!staticKeys.has(key(route))) routes.push({ ...route, presence: "runtime-only" });
  }
  return { routes, globalMiddleware: staticReg.globalMiddleware };
}

module.exports = { reconcile };
