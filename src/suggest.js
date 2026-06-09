"use strict";

const AUTH_HINT =
  /auth|login|token|session|verify|verifier|guard|require|permit|acl|jwt|passport|signature|hmac|oauth|bearer|csrf|tenant|role|scope/i;

/**
 * Propose auth-middleware allowlist candidates from an inventory. Lets an agent
 * pointed at an unfamiliar repo bootstrap a config instead of needing one up
 * front: list every distinct middleware seen on a route, ranked so likely guards
 * (name hints, applied to a subset of routes) surface first.
 *
 * @param {{routes: object[]}} registry
 * @returns {{candidates: object[]}}
 */
function suggestAuth(registry) {
  const total = registry.routes.length;
  const byName = new Map();
  for (const route of registry.routes) {
    for (const mw of route.middlewares) {
      if (mw.name === "<anonymous>") continue;
      const acc = byName.get(mw.name) || { name: mw.name, kind: mw.kind, paths: new Set() };
      acc.paths.add(`${route.method} ${route.path}`);
      byName.set(mw.name, acc);
    }
  }
  const candidates = [...byName.values()].map((c) => ({
    name: c.name,
    kind: c.kind,
    routeCount: c.paths.size,
    appliesToAll: c.paths.size === total && total > 0,
    likelyAuth: AUTH_HINT.test(c.name),
    sampleRoutes: [...c.paths].slice(0, 3),
  }));
  candidates.sort(rankCandidate);
  return { totalRoutes: total, candidates };
}

/** Likely-auth first, then partial-coverage (a subset smells like a guard) first. */
function rankCandidate(a, b) {
  if (a.likelyAuth !== b.likelyAuth) return a.likelyAuth ? -1 : 1;
  if (a.appliesToAll !== b.appliesToAll) return a.appliesToAll ? 1 : -1;
  if (a.routeCount !== b.routeCount) return a.routeCount - b.routeCount;
  return a.name.localeCompare(b.name);
}

module.exports = { suggestAuth };
