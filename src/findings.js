"use strict";

const { inconsistentPaths } = require("./classify");

function publicFindings(routes) {
  return routes
    .filter((r) => r.authStatus === "public" && !r.accepted)
    .map((r) => ({
      id: "public-route",
      severity: "high",
      method: r.method,
      path: r.path,
      source: r.source || null,
      detail: "No recognised auth middleware guards this route.",
    }));
}

/**
 * Flag baseline entries (`acceptedPublic`) that no longer match a public route —
 * the route was removed or is now guarded — so the accepted list can be pruned
 * and doesn't silently keep suppressing a key that will match a future route.
 */
function staleBaselineFindings(routes, acceptedPublic) {
  if (!acceptedPublic || acceptedPublic.length === 0) return [];
  const activePublic = new Set(
    routes.filter((r) => r.authStatus === "public").map((r) => `${r.method} ${r.path}`),
  );
  return acceptedPublic
    .filter((k) => !activePublic.has(k))
    .map((k) => ({
      id: "stale-baseline",
      severity: "low",
      detail: `Accepted-public baseline entry "${k}" no longer matches a public route (removed or now guarded); remove it from acceptedPublic.`,
    }));
}

function reviewFindings(routes) {
  return routes
    .filter((r) => r.authStatus === "unknown")
    .map((r) => ({
      id: "opaque-middleware",
      severity: "medium",
      method: r.method,
      path: r.path,
      source: r.source || null,
      detail: "Guarded only by an inline/anonymous middleware whose intent can't be proven.",
    }));
}

function gapFindings(routes) {
  return inconsistentPaths(routes).map((g) => ({
    id: "per-verb-gap",
    severity: "high",
    path: g.path,
    methods: g.methods,
    detail: "Auth status differs across HTTP methods on the same path.",
  }));
}

/**
 * Derive audit findings from classified routes. Each finding has a stable `id`,
 * a `severity`, and a location, so an agent or CI step can act on it directly.
 *
 * @param {object[]} routes  classified routes (must have `authStatus`)
 * @param {string[]} [acceptedPublic]  reviewed baseline of intentionally-open routes
 * @returns {object[]}
 */
function buildFindings(routes, acceptedPublic) {
  return [
    ...publicFindings(routes),
    ...gapFindings(routes),
    ...reviewFindings(routes),
    ...staleBaselineFindings(routes, acceptedPublic),
  ];
}

module.exports = { buildFindings };
