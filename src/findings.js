"use strict";

const { inconsistentPaths } = require("./classify");

function publicFindings(routes) {
  return routes
    .filter((r) => r.authStatus === "public")
    .map((r) => ({
      id: "public-route",
      severity: "high",
      method: r.method,
      path: r.path,
      source: r.source || null,
      detail: "No recognised auth middleware guards this route.",
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
 * @returns {object[]}
 */
function buildFindings(routes) {
  return [...publicFindings(routes), ...gapFindings(routes), ...reviewFindings(routes)];
}

module.exports = { buildFindings };
