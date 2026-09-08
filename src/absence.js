"use strict";

const { NONE, scopeEvidence } = require("./express-scope");

function pathUnderScope(candidatePath, scope) {
  if (!scope) return true;
  // Absence needs a "could overlap" predicate, not a literal-prefix match.
  // Parameterized, wildcard, regex-like, or otherwise dynamic scopes cannot
  // prove that a documentation-only route is outside the unresolved mount.
  return scopeEvidence(candidatePath, scope).applicability !== NONE;
}

function appliesToApplication(obligation, applicationId) {
  return (
    applicationId === undefined ||
    obligation.applicationId === null ||
    obligation.applicationId === applicationId
  );
}

/**
 * Decide whether a missing method/path is a supported absence or merely not
 * observed. This contract is shared by documentation drift and report deltas.
 */
function absenceEvidence(report, candidate = {}) {
  const reasons = [];
  const candidatePath = candidate.path || "/";
  if (report.scanCoverage?.complete === false) reasons.push("scan-incomplete");

  const graph = report.routeGraph;
  if (graph) {
    const gaps = graph.gaps || [];
    for (const gap of gaps) {
      if (!appliesToApplication(gap, candidate.applicationId)) continue;
      if (gap.scope !== null && !pathUnderScope(candidatePath, gap.scope)) continue;
      reasons.push(gap.reasonCode || "route-graph-gap");
    }
    for (const mount of graph.opaqueMounts || []) {
      if (!appliesToApplication(mount, candidate.applicationId)) continue;
      if (mount.pathConfidence === "full" && !pathUnderScope(candidatePath, mount.path)) continue;
      reasons.push("opaque-registration");
    }
    // Older reports do not have structured gaps. Preserve their uncertainty.
    if (!gaps.length && (graph.orphanRoutes || 0) > 0) reasons.push("unattached-routes");
    if (!gaps.length && (graph.partialRoutes || 0) > 0) reasons.push("partial-routes");
    if (
      graph.complete === false &&
      !reasons.length &&
      !gaps.length &&
      !(graph.opaqueMounts || []).length
    ) {
      reasons.push("route-graph-incomplete");
    }
  }
  return { verified: reasons.length === 0, reasons: [...new Set(reasons)].sort() };
}

module.exports = { absenceEvidence, pathUnderScope };
