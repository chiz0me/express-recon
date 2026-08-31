"use strict";

function key(route) {
  return `${route.method} ${route.path}`;
}

function applicationCompatible(staticRoute, runtimeRoute) {
  const staticId = staticRoute.applicationId;
  const runtimeId = runtimeRoute.applicationId;
  return !staticId || !runtimeId || runtimeId === "runtime:default" || staticId === runtimeId;
}

function hasCompatibleExactStatic(runtimeRoute, staticRoutes) {
  return staticRoutes.some(
    (staticRoute) =>
      key(staticRoute) === key(runtimeRoute) && applicationCompatible(staticRoute, runtimeRoute),
  );
}

/**
 * Match a static route to its runtime twin by registration call site — both
 * scanners report the verb call's file:line (static from the AST, runtime from
 * `instrument()` stack capture), so an equal source is the same registration
 * even when the resolved paths differ. Absolute paths are compared as strings;
 * a symlinked source tree would defeat this and fall back to suffix matching.
 */
function sourceMatch(route, staticRoutes, runtimeRoutes, claimed) {
  if (!route.source || !route.source.file || route.source.line == null) return null;
  const candidates = runtimeRoutes.filter(
    (r) =>
      r.method === route.method &&
      applicationCompatible(route, r) &&
      r.source &&
      r.source.file === route.source.file &&
      r.source.line === route.source.line &&
      !hasCompatibleExactStatic(r, staticRoutes) &&
      !claimed.has(r),
  );
  if (candidates.length !== 1) return null;
  const runtimeRoute = candidates[0];
  const staticSourcePeers = staticRoutes.filter(
    (candidate) =>
      candidate.method === route.method &&
      applicationCompatible(candidate, runtimeRoute) &&
      candidate.source?.file === route.source.file &&
      candidate.source?.line === route.source.line,
  );
  return staticSourcePeers.length === 1 ? runtimeRoute : null;
}

/**
 * Match a partial-confidence static route (orphan router or `<dynamic>` mount
 * prefix) to its runtime twin by the path suffix static analysis *did* prove.
 * Only an unambiguous match counts: exactly one same-method runtime route ends
 * with the known suffix.
 */
function suffixMatch(route, staticRoutes, runtimeRoutes, claimed) {
  const idx = route.path.lastIndexOf("<dynamic>");
  const suffix = idx === -1 ? route.path : route.path.slice(idx + "<dynamic>".length);
  if (suffix === "" || suffix === "/") return null;
  const candidates = runtimeRoutes.filter(
    (r) =>
      r.method === route.method &&
      r.path.endsWith(suffix) &&
      !hasCompatibleExactStatic(r, staticRoutes) &&
      !claimed.has(r) &&
      (r.applicationId === route.applicationId ||
        (!r.source?.file &&
          staticRoutes.filter((candidate) => {
            if (candidate.method !== r.method || candidate.pathConfidence !== "partial") {
              return false;
            }
            const marker = candidate.path.lastIndexOf("<dynamic>");
            const candidateSuffix =
              marker === -1 ? candidate.path : candidate.path.slice(marker + "<dynamic>".length);
            return candidateSuffix && candidateSuffix !== "/" && r.path.endsWith(candidateSuffix);
          }).length === 1)),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

/** Pair an exact route key without crossing application/source boundaries. */
function exactMatch(route, staticRoutes, runtimeRoutes, claimed, staticKeyCounts) {
  const candidates = runtimeRoutes.filter(
    (r) => key(r) === key(route) && applicationCompatible(route, r) && !claimed.has(r),
  );
  if (candidates.length === 0) return null;
  if (route.source && route.source.file && route.source.line != null) {
    const bySource = candidates.filter(
      (candidate) =>
        candidate.source &&
        candidate.source.file === route.source.file &&
        candidate.source.line === route.source.line,
    );
    if (bySource.length === 1) {
      const candidate = bySource[0];
      const staticSourcePeers = staticRoutes.filter(
        (staticRoute) =>
          key(staticRoute) === key(route) &&
          applicationCompatible(staticRoute, candidate) &&
          staticRoute.source?.file === route.source.file &&
          staticRoute.source?.line === route.source.line,
      );
      if (staticSourcePeers.length === 1) return candidate;
    }
  }
  const byApplication = candidates.filter(
    (candidate) => candidate.applicationId === route.applicationId,
  );
  if (route.applicationId && byApplication.length === 1) return byApplication[0];
  // A sourced runtime registration that points elsewhere is evidence that this
  // is not the static route, even if method/path happen to match.
  if (candidates.some((candidate) => candidate.source?.file)) return null;
  // With no source or app identity, identical keys in multiple static apps are
  // ambiguous. Keep both observations separate instead of assigning runtime
  // authority to whichever app happened to be traversed first.
  if ((staticKeyCounts.get(key(route)) || 0) > 1) return null;
  return candidates[0];
}

function observation(route) {
  return {
    path: route.path,
    pathConfidence: route.pathConfidence,
    source: route.source || null,
    middlewares: route.middlewares || [],
    ...(route.authStatus ? { authStatus: route.authStatus } : {}),
    ...(route.tags ? { tags: route.tags } : {}),
    ...(route.roles ? { roles: route.roles } : {}),
    ...(route.scopes ? { scopes: route.scopes } : {}),
  };
}

function observationConflicts(staticRoute, runtimeRoute) {
  const conflicts = [];
  const staticNames = (staticRoute.middlewares || []).map((middleware) => middleware.name);
  const runtimeNames = (runtimeRoute.middlewares || []).map((middleware) => middleware.name);
  if (JSON.stringify(staticNames) !== JSON.stringify(runtimeNames)) {
    conflicts.push("middleware-identity");
  }
  if (
    staticRoute.authStatus &&
    runtimeRoute.authStatus &&
    staticRoute.authStatus !== runtimeRoute.authStatus
  ) {
    conflicts.push("auth-classification");
  }
  if (staticRoute.path !== runtimeRoute.path) conflicts.push("path");
  return conflicts;
}

function observations(staticRoute, runtimeRoute) {
  return {
    static: staticRoute ? observation(staticRoute) : null,
    runtime: runtimeRoute ? observation(runtimeRoute) : null,
    conflicts: staticRoute && runtimeRoute ? observationConflicts(staticRoute, runtimeRoute) : [],
  };
}

/**
 * Runtime is authoritative for middleware and auth: it observed the route that
 * actually booted. Static analysis contributes source and handler I/O metadata.
 */
function mergePair(route, match) {
  const accepted = match.authStatus === "public" && (route.accepted || match.accepted);
  return {
    ...match,
    applicationId: route.applicationId || match.applicationId || null,
    source: route.source || match.source || null,
    presence: "both",
    observations: observations(route, match),
    ...(route.io ? { io: route.io } : {}),
    ...(accepted ? { accepted: true } : {}),
  };
}

/**
 * Merge a static and a runtime registry into one, tagging each route with how
 * it was observed. Static routes carry source file/line; runtime-only routes
 * (e.g. dynamically registered ones static analysis can't see) are surfaced so
 * the audit doesn't miss them. A partial static route that unambiguously
 * matches a runtime route by suffix is merged instead of double-reported: the
 * runtime view wins (it saw the real mount wiring and middleware), the static
 * source location is kept.
 *
 * @param {{routes: object[], globalMiddleware: object[]}} staticReg
 * @param {{routes: object[], globalMiddleware: object[]}} runtimeReg
 * @returns {{routes: object[], globalMiddleware: object[]}}
 */
function reconcile(staticReg, runtimeReg) {
  const staticKeyCounts = new Map();
  for (const route of staticReg.routes) {
    staticKeyCounts.set(key(route), (staticKeyCounts.get(key(route)) || 0) + 1);
  }
  const claimed = new Set();
  const routes = [];
  for (const route of staticReg.routes) {
    const exact = exactMatch(route, staticReg.routes, runtimeReg.routes, claimed, staticKeyCounts);
    if (exact) {
      claimed.add(exact);
      routes.push(mergePair(route, exact));
      continue;
    }
    const match =
      sourceMatch(route, staticReg.routes, runtimeReg.routes, claimed) ||
      (route.pathConfidence === "partial"
        ? suffixMatch(route, staticReg.routes, runtimeReg.routes, claimed)
        : null);
    if (match) {
      claimed.add(match);
      routes.push(mergePair(route, match));
    } else {
      routes.push({
        ...route,
        presence: "static-only",
        observations: observations(route, null),
      });
    }
  }
  for (const route of runtimeReg.routes) {
    if (!claimed.has(route)) {
      routes.push({
        ...route,
        presence: "runtime-only",
        observations: observations(null, route),
      });
    }
  }
  // Both sides were classified with the same config, so the accepted tags on
  // routes already agree; carry the baseline list and static diagnostics
  // forward so the report can still flag stale entries and resolution warnings.
  return {
    routes,
    globalMiddleware: staticReg.globalMiddleware,
    applications: reconcileApplications(staticReg, runtimeReg, routes),
    diagnostics: [...(staticReg.diagnostics || []), ...(runtimeReg.diagnostics || [])],
    acceptedPublic: staticReg.acceptedPublic || [],
    ...(staticReg.openapi || runtimeReg.openapi
      ? { openapi: staticReg.openapi || runtimeReg.openapi }
      : {}),
    ...(staticReg.scanCoverage ? { scanCoverage: staticReg.scanCoverage } : {}),
    ...(staticReg.routeGraph ? { routeGraph: staticReg.routeGraph } : {}),
  };
}

function reconcileApplications(staticReg, runtimeReg, routes) {
  const applications = [...(staticReg.applications || [])].map((application) => ({
    ...application,
  }));
  const ids = new Set(applications.map((application) => application.id));
  for (const application of runtimeReg.applications || []) {
    if (
      !ids.has(application.id) &&
      routes.some((route) => route.applicationId === application.id)
    ) {
      applications.push({ ...application });
      ids.add(application.id);
    }
  }
  for (const application of applications) {
    application.routeCount = routes.filter(
      (route) => route.applicationId === application.id,
    ).length;
  }
  return applications;
}

module.exports = { reconcile };
