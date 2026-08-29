"use strict";

const crypto = require("node:crypto");
const { inconsistentPaths } = require("./classify");

function fingerprintFinding(finding, options = {}) {
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
  const identity = [finding.id, ruleIdentity];
  if (options.applicationScoped !== false) identity.push(finding.applicationId || "");
  identity.push(
    finding.method || "",
    finding.path || "",
    finding.baselineEntry || legacyBaselineEntry,
  );
  const digest = crypto.createHash("sha256").update(identity.join("\0")).digest("hex").slice(0, 16);
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
      applicationId: r.applicationId ?? null,
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
  const publicRoutes = routes.filter((route) => route.authStatus === "public");
  const labelFor = (entry) =>
    typeof entry === "string" ? entry : `${entry.applicationId} ${entry.method} ${entry.path}`;
  const matches = (entry) =>
    publicRoutes.some((route) => {
      if (typeof entry === "string") return entry === `${route.method} ${route.path}`;
      return (
        entry.applicationId === route.applicationId &&
        entry.method === route.method &&
        entry.path === route.path
      );
    });
  return acceptedPublic
    .filter((entry) => !matches(entry))
    .map((entry) => {
      const label = labelFor(entry);
      return {
        id: "stale-baseline",
        ruleId: "stale-baseline",
        severity: "low",
        confidence: "high",
        applicationId: typeof entry === "string" ? null : entry.applicationId,
        baselineEntry: label,
        detail: `Accepted-public baseline entry "${label}" no longer matches a public route (removed or now guarded); remove it from acceptedPublic.`,
        recommendation: `Remove "${label}" from acceptedPublic.`,
      };
    });
}

function reviewFindings(routes) {
  return routes
    .filter((r) => r.authStatus === "unknown")
    .map((r) => ({
      id: "opaque-middleware",
      ruleId: "opaque-middleware",
      severity: "medium",
      confidence: r.pathConfidence === "partial" ? "low" : "medium",
      applicationId: r.applicationId ?? null,
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
    applicationId: g.applicationId,
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
 * @param {(string|{applicationId:string,method:string,path:string})[]} [acceptedPublic] reviewed baseline of intentionally-open routes
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
