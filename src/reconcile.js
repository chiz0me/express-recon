"use strict";

function key(route) {
  return `${route.method} ${route.path}`;
}

/**
 * Match a static route to its runtime twin by registration call site — both
 * scanners report the verb call's file:line (static from the AST, runtime from
 * `instrument()` stack capture), so an equal source is the same registration
 * even when the resolved paths differ. Absolute paths are compared as strings;
 * a symlinked source tree would defeat this and fall back to suffix matching.
 */
function sourceMatch(route, runtimeRoutes, staticKeys, claimed) {
  if (!route.source || !route.source.file || route.source.line == null) return null;
  const candidates = runtimeRoutes.filter(
    (r) =>
      r.method === route.method &&
      r.source &&
      r.source.file === route.source.file &&
      r.source.line === route.source.line &&
      !staticKeys.has(key(r)) &&
      !claimed.has(r),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Match a partial-confidence static route (orphan router or `<dynamic>` mount
 * prefix) to its runtime twin by the path suffix static analysis *did* prove.
 * Only an unambiguous match counts: exactly one same-method runtime route ends
 * with the known suffix.
 */
function suffixMatch(route, runtimeRoutes, staticKeys, claimed) {
  const idx = route.path.lastIndexOf("<dynamic>");
  const suffix = idx === -1 ? route.path : route.path.slice(idx + "<dynamic>".length);
  if (suffix === "" || suffix === "/") return null;
  const candidates = runtimeRoutes.filter(
    (r) =>
      r.method === route.method &&
      r.path.endsWith(suffix) &&
      !staticKeys.has(key(r)) &&
      !claimed.has(r),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

/** Pair an exact route key, preferring an equal registration source when available. */
function exactMatch(route, runtimeRoutes, claimed) {
  const candidates = runtimeRoutes.filter((r) => key(r) === key(route) && !claimed.has(r));
  if (candidates.length === 0) return null;
  if (route.source && route.source.file && route.source.line != null) {
    const bySource = candidates.filter(
      (candidate) =>
        candidate.source &&
        candidate.source.file === route.source.file &&
        candidate.source.line === route.source.line,
    );
    if (bySource.length === 1) return bySource[0];
  }
  return candidates[0];
}

/**
 * Runtime is authoritative for middleware and auth: it observed the route that
 * actually booted. Static analysis contributes source and handler I/O metadata.
 */
function mergePair(route, match) {
  return {
    ...match,
    source: route.source || match.source || null,
    presence: "both",
    ...(route.io ? { io: route.io } : {}),
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
  const staticKeys = new Set(staticReg.routes.map(key));
  const claimed = new Set();
  const routes = [];
  for (const route of staticReg.routes) {
    const exact = exactMatch(route, runtimeReg.routes, claimed);
    if (exact) {
      claimed.add(exact);
      routes.push(mergePair(route, exact));
      continue;
    }
    const match =
      sourceMatch(route, runtimeReg.routes, staticKeys, claimed) ||
      (route.pathConfidence === "partial"
        ? suffixMatch(route, runtimeReg.routes, staticKeys, claimed)
        : null);
    if (match) {
      claimed.add(match);
      routes.push(mergePair(route, match));
    } else {
      routes.push({ ...route, presence: "static-only" });
    }
  }
  for (const route of runtimeReg.routes) {
    if (!claimed.has(route)) routes.push({ ...route, presence: "runtime-only" });
  }
  // Both sides were classified with the same config, so the accepted tags on
  // routes already agree; carry the baseline list and static diagnostics
  // forward so the report can still flag stale entries and resolution warnings.
  return {
    routes,
    globalMiddleware: staticReg.globalMiddleware,
    diagnostics: [...(staticReg.diagnostics || []), ...(runtimeReg.diagnostics || [])],
    acceptedPublic: staticReg.acceptedPublic || [],
    ...(staticReg.scanCoverage ? { scanCoverage: staticReg.scanCoverage } : {}),
  };
}

module.exports = { reconcile };
