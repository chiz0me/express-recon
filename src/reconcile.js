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
      !claimed.has(key(r)),
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
      !claimed.has(key(r)),
  );
  return candidates.length === 1 ? candidates[0] : null;
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
  const runtimeKeys = new Set(runtimeReg.routes.map(key));
  const staticKeys = new Set(staticReg.routes.map(key));
  const claimed = new Set();
  const routes = [];
  for (const route of staticReg.routes) {
    if (runtimeKeys.has(key(route))) {
      // The runtime walk confirmed this exact path, so it is no longer partial.
      routes.push({ ...route, pathConfidence: "full", presence: "both" });
      continue;
    }
    const match =
      sourceMatch(route, runtimeReg.routes, staticKeys, claimed) ||
      (route.pathConfidence === "partial"
        ? suffixMatch(route, runtimeReg.routes, staticKeys, claimed)
        : null);
    if (match) {
      claimed.add(key(match));
      // The runtime twin has no statically-mined I/O hints; carry the static
      // route's `io` (and source) onto the merged route.
      routes.push({
        ...match,
        source: route.source || null,
        presence: "both",
        ...(route.io ? { io: route.io } : {}),
      });
    } else {
      routes.push({ ...route, presence: "static-only" });
    }
  }
  for (const route of runtimeReg.routes) {
    if (!staticKeys.has(key(route)) && !claimed.has(key(route)))
      routes.push({ ...route, presence: "runtime-only" });
  }
  // Both sides were classified with the same config, so the accepted tags on
  // routes already agree; carry the baseline list and static diagnostics
  // forward so the report can still flag stale entries and resolution warnings.
  return {
    routes,
    globalMiddleware: staticReg.globalMiddleware,
    diagnostics: staticReg.diagnostics || [],
    acceptedPublic: staticReg.acceptedPublic || [],
  };
}

module.exports = { reconcile };
