"use strict";

const crypto = require("node:crypto");
const { inconsistentPaths } = require("./classify");

function fingerprintFinding(finding) {
  const ruleIdentity =
    finding.id === "policy-violation"
      ? finding.ruleId || ""
      : finding.ruleId && finding.ruleId !== finding.id
        ? finding.ruleId
        : "";
  const legacyBaselineEntry =
    finding.id === "stale-baseline"
      ? finding.detail?.match(/baseline entry "([^"]+)"/)?.[1] || ""
      : "";
  const identity = [
    finding.id,
    ruleIdentity,
    finding.method || "",
    finding.path || "",
    finding.baselineEntry || legacyBaselineEntry,
  ].join("\0");
  const digest = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return { ...finding, fingerprint: `finding_${digest}` };
}

function publicFindings(routes) {
  return routes
    .filter((r) => r.authStatus === "public" && !r.accepted)
    .map((r) => ({
      id: "public-route",
      ruleId: "public-route",
      severity: "high",
      confidence: r.pathConfidence === "partial" ? "medium" : "high",
      method: r.method,
      path: r.path,
      source: r.source || null,
      detail: "No recognised auth middleware guards this route.",
      recommendation:
        "Add an always-enforcing auth middleware, or accept the route explicitly if it is intentionally public.",
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
      ruleId: "stale-baseline",
      severity: "low",
      confidence: "high",
      baselineEntry: k,
      detail: `Accepted-public baseline entry "${k}" no longer matches a public route (removed or now guarded); remove it from acceptedPublic.`,
      recommendation: `Remove "${k}" from acceptedPublic.`,
    }));
}

function reviewFindings(routes) {
  return routes
    .filter((r) => r.authStatus === "unknown")
    .map((r) => ({
      id: "opaque-middleware",
      ruleId: "opaque-middleware",
      severity: "medium",
      confidence: r.pathConfidence === "partial" ? "low" : "medium",
      method: r.method,
      path: r.path,
      source: r.source || null,
      detail: "Guarded only by an inline/anonymous middleware whose intent can't be proven.",
      recommendation:
        "Use a named, always-enforcing guard and include it in authMiddleware, or review this route manually.",
    }));
}

function gapFindings(routes) {
  return inconsistentPaths(routes).map((g) => ({
    id: "per-verb-gap",
    ruleId: "per-verb-gap",
    severity: "high",
    confidence: "high",
    path: g.path,
    methods: g.methods,
    detail: "Auth status differs across HTTP methods on the same path.",
    recommendation: "Apply a consistent authentication policy to every HTTP method on this path.",
  }));
}

/**
 * Derive audit findings from classified routes. Each finding has a stable `id`,
 * a `severity`, and a location, so an agent or CI step can act on it directly.
 *
 * @param {object[]} routes  classified routes (must have `authStatus`)
 * @param {string[]} [acceptedPublic]  reviewed baseline of intentionally-open routes
 * @param {object[]} [policyFindings]  findings from configurable route policies
 * @returns {object[]}
 */
function buildFindings(routes, acceptedPublic, policyFindings) {
  return [
    ...publicFindings(routes),
    ...gapFindings(routes),
    ...reviewFindings(routes),
    ...staleBaselineFindings(routes, acceptedPublic),
    ...(policyFindings || []),
  ].map(fingerprintFinding);
}

module.exports = { buildFindings, fingerprintFinding };
