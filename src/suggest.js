"use strict";

const AUTH_HINT =
  /auth|login|token|session|verify|verifier|guard|require|permit|acl|jwt|passport|signature|hmac|bearer|csrf|tenant|role|scope|permission|rbac|api[-_]?key|protect|admin|sso|saml|oidc/i;

/** Plumbing middleware that is never an auth guard — ranked last, never hinted. */
const KNOWN_NON_AUTH = new Set([
  "express.json",
  "express.urlencoded",
  "express.raw",
  "express.text",
  "express.static",
  "bodyParser.json",
  "bodyParser.urlencoded",
  "cors",
  "helmet",
  "morgan",
  "compression",
  "cookieParser",
  "serveStatic",
  "favicon",
]);

/**
 * Propose auth-middleware allowlist candidates from an inventory. Lets an agent
 * pointed at an unfamiliar repo bootstrap a config instead of needing one up
 * front: list every distinct middleware seen on a route (including names inside
 * wrapper calls like `asyncHandler(requireAuth)`), ranked so likely guards
 * (name hints, applied to a subset of routes) surface first.
 *
 * @param {{routes: object[]}} registry
 * @returns {{candidates: object[]}}
 */
function suggestAuth(registry) {
  const total = registry.routes.length;
  const byName = new Map();
  const record = (name, kind, route) => {
    if (name === "<anonymous>") return;
    const acc = byName.get(name) || { name, kind, paths: new Set() };
    acc.paths.add(`${route.method} ${route.path}`);
    byName.set(name, acc);
  };
  for (const route of registry.routes) {
    for (const mw of route.middlewares) {
      record(mw.name, mw.kind, route);
      for (const inner of mw.inner || []) record(inner, "identifier", route);
    }
  }
  const candidates = [...byName.values()].map((c) => ({
    name: c.name,
    kind: c.kind,
    routeCount: c.paths.size,
    appliesToAll: c.paths.size === total && total > 0,
    likelyAuth: !KNOWN_NON_AUTH.has(c.name) && AUTH_HINT.test(c.name),
    knownNonAuth: KNOWN_NON_AUTH.has(c.name),
    sampleRoutes: [...c.paths].slice(0, 3),
  }));
  candidates.sort(rankCandidate);
  return { totalRoutes: total, candidates };
}

/** Likely-auth first, known plumbing last, partial-coverage before applies-to-all. */
function rankCandidate(a, b) {
  if (a.likelyAuth !== b.likelyAuth) return a.likelyAuth ? -1 : 1;
  if (a.knownNonAuth !== b.knownNonAuth) return a.knownNonAuth ? 1 : -1;
  if (a.appliesToAll !== b.appliesToAll) return a.appliesToAll ? 1 : -1;
  if (a.routeCount !== b.routeCount) return a.routeCount - b.routeCount;
  return a.name.localeCompare(b.name);
}

module.exports = { suggestAuth };
