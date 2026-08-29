"use strict";

const { fingerprintFinding } = require("./findings");

const AUTH_RISK = { proven: 0, unknown: 1, public: 2 };

function assertReport(report, label) {
  if (!report || typeof report !== "object" || !Array.isArray(report.routes)) {
    throw new Error(`${label} must be an express-recon report with a routes array`);
  }
}

function assertComparableScope(baseline, current) {
  const before = baseline.scanCoverage?.scope?.fingerprint;
  const after = current.scanCoverage?.scope?.fingerprint;
  if (before && after && before !== after) {
    throw new Error(
      "baseline and current scan scopes differ; scan both revisions with the same " +
        "--include, --exclude, --ignore-file, and --include-tests policy",
    );
  }
}

function routeKey(route, applicationScoped) {
  return applicationScoped
    ? `${route.applicationId || ""}\0${route.method} ${route.path}`
    : `${route.method} ${route.path}`;
}

/** Collapse duplicate route keys to the least-safe auth view for comparison. */
function routeMap(routes, applicationScoped) {
  const map = new Map();
  for (const route of routes) {
    const key = routeKey(route, applicationScoped);
    const existing = map.get(key);
    const risk = AUTH_RISK[route.authStatus] ?? -1;
    const existingRisk = existing ? (AUTH_RISK[existing.authStatus] ?? -1) : -2;
    if (!existing || risk > existingRisk) map.set(key, route);
  }
  return map;
}

function routeSummary(route) {
  return {
    applicationId: route.applicationId ?? null,
    method: route.method,
    path: route.path,
    ...(route.authStatus ? { authStatus: route.authStatus } : {}),
    ...(route.accepted ? { accepted: true } : {}),
    source: route.source || null,
  };
}

function middlewareNames(route) {
  return (route.middlewares || []).flatMap((middleware) => [
    middleware.name,
    ...(middleware.inner || []),
  ]);
}

function difference(before, after) {
  const afterSet = new Set(after);
  return [...new Set(before)].filter((item) => !afterSet.has(item));
}

function sameMultiset(before, after) {
  if (before.length !== after.length) return false;
  const counts = new Map();
  for (const item of before) counts.set(item, (counts.get(item) || 0) + 1);
  for (const item of after) {
    const count = counts.get(item);
    if (!count) return false;
    if (count === 1) counts.delete(item);
    else counts.set(item, count - 1);
  }
  return counts.size === 0;
}

function authenticationCause(previous, current) {
  const beforeMiddleware = middlewareNames(previous);
  const afterMiddleware = middlewareNames(current);
  const changes = {
    removedMiddleware: difference(beforeMiddleware, afterMiddleware),
    addedMiddleware: difference(afterMiddleware, beforeMiddleware),
    removedTags: difference(previous.tags || [], current.tags || []),
    addedTags: difference(current.tags || [], previous.tags || []),
    removedRoles: difference(previous.roles || [], current.roles || []),
    addedRoles: difference(current.roles || [], previous.roles || []),
    removedScopes: difference(previous.scopes || [], current.scopes || []),
    addedScopes: difference(current.scopes || [], previous.scopes || []),
  };
  if (
    sameMultiset(beforeMiddleware, afterMiddleware) &&
    beforeMiddleware.join("\0") !== afterMiddleware.join("\0")
  ) {
    changes.middlewareOrderChanged = true;
  }
  for (const key of Object.keys(changes)) {
    if (Array.isArray(changes[key]) && changes[key].length === 0) delete changes[key];
  }

  let explanation;
  if (changes.removedTags?.length) {
    explanation = `Recognized auth tag(s) removed: ${changes.removedTags.join(", ")}.`;
  } else if (changes.addedTags?.length) {
    explanation = `Recognized auth tag(s) added: ${changes.addedTags.join(", ")}.`;
  } else if (changes.removedRoles?.length || changes.removedScopes?.length) {
    const grants = [...(changes.removedRoles || []), ...(changes.removedScopes || [])];
    explanation = `Authorization grant(s) removed: ${grants.join(", ")}.`;
  } else if (changes.addedRoles?.length || changes.addedScopes?.length) {
    const grants = [...(changes.addedRoles || []), ...(changes.addedScopes || [])];
    explanation = `Authorization grant(s) added: ${grants.join(", ")}.`;
  } else if (changes.removedMiddleware?.length) {
    explanation = `Middleware removed from the route chain: ${changes.removedMiddleware.join(", ")}.`;
  } else if (current.authStatus === "unknown" && previous.authStatus !== "unknown") {
    explanation = "The route is now guarded only by middleware whose security behavior is opaque.";
  } else if (changes.middlewareOrderChanged) {
    explanation = "The middleware chain order changed alongside the authentication classification.";
  } else {
    explanation =
      "Authentication classification changed without a visible route-level middleware difference; " +
      "check authMiddleware configuration or shared mount wiring.";
  }
  return { changes, explanation };
}

function compareRoutes(baseline, current, applicationScoped) {
  const before = routeMap(baseline.routes, applicationScoped);
  const after = routeMap(current.routes, applicationScoped);
  const addedRoutes = [];
  const removedRoutes = [];
  const authRegressions = [];
  const authImprovements = [];

  for (const [key, route] of after) {
    const previous = before.get(key);
    if (!previous) {
      addedRoutes.push(routeSummary(route));
      continue;
    }
    const fromRisk = AUTH_RISK[previous.authStatus];
    const toRisk = AUTH_RISK[route.authStatus];
    if (fromRisk === undefined || toRisk === undefined || fromRisk === toRisk) continue;
    const change = {
      applicationId: route.applicationId ?? null,
      method: route.method,
      path: route.path,
      from: previous.authStatus,
      to: route.authStatus,
      source: route.source || null,
      ...authenticationCause(previous, route),
    };
    if (toRisk > fromRisk) authRegressions.push(change);
    else authImprovements.push(change);
  }
  for (const [key, route] of before) {
    if (!after.has(key)) removedRoutes.push(routeSummary(route));
  }

  const byRoute = (a, b) => {
    const byApplication = (a.applicationId || "").localeCompare(b.applicationId || "");
    if (byApplication) return byApplication;
    return a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path);
  };
  for (const list of [addedRoutes, removedRoutes, authRegressions, authImprovements]) {
    list.sort(byRoute);
  }
  return { addedRoutes, removedRoutes, authRegressions, authImprovements };
}

function findingFingerprint(finding, applicationScoped) {
  // Recompute semantic identity so schema 1.x baselines remain comparable even
  // though version 2 adds application identity to emitted fingerprints.
  return fingerprintFinding(finding, { applicationScoped }).fingerprint;
}

function compareFindings(baseline, current, applicationScoped) {
  const before = new Set(
    (baseline.findings || []).map((finding) => findingFingerprint(finding, applicationScoped)),
  );
  const after = new Set(
    (current.findings || []).map((finding) => findingFingerprint(finding, applicationScoped)),
  );
  return {
    newFindings: (current.findings || []).filter(
      (finding) => !before.has(findingFingerprint(finding, applicationScoped)),
    ),
    resolvedFindings: (baseline.findings || []).filter(
      (finding) => !after.has(findingFingerprint(finding, applicationScoped)),
    ),
  };
}

function supportsApplicationIdentity(report) {
  const major = Number.parseInt(String(report.schemaVersion || "").split(".")[0], 10);
  return (
    major >= 2 ||
    report.routes.some((route) => typeof route.applicationId === "string") ||
    (report.findings || []).some((finding) => typeof finding.applicationId === "string")
  );
}

/**
 * Compare two full reports. The scanner still analyzes the complete route graph;
 * this function only scopes CI output after analysis, so changes to shared
 * middleware and mount wiring cannot hide regressions in unchanged route files.
 */
function compareReports(baseline, current) {
  assertReport(baseline, "baseline");
  assertReport(current, "current report");
  assertComparableScope(baseline, current);
  // The baseline controls compatibility: schema 1.x had no application IDs, so
  // retain its historical method/path semantics when comparing a version 2 run.
  const applicationScoped = supportsApplicationIdentity(baseline);
  const routes = compareRoutes(baseline, current, applicationScoped);
  const findings = compareFindings(baseline, current, applicationScoped);
  return {
    baseline: {
      schemaVersion: baseline.schemaVersion || null,
      target: baseline.target || null,
    },
    summary: {
      addedRoutes: routes.addedRoutes.length,
      removedRoutes: routes.removedRoutes.length,
      authRegressions: routes.authRegressions.length,
      authImprovements: routes.authImprovements.length,
      newFindings: findings.newFindings.length,
      resolvedFindings: findings.resolvedFindings.length,
    },
    ...routes,
    ...findings,
  };
}

module.exports = { compareReports };
