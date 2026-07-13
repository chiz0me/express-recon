"use strict";

const { isOpaque } = require("./middleware");

const PUBLIC_TAG = "public";
const REVIEW_TAG = "unknown:review";

/**
 * Auth status for a route, under a public-unless-proven policy:
 *
 * - `proven`  — at least one middleware name/callee matched the auth allowlist.
 * - `unknown` — no allowlist match, but the chain contains an *opaque*
 *   middleware (an inline/anonymous closure or an expression we can't name) that
 *   could be hiding an auth check. Surfaced for manual review rather than assumed
 *   safe, so an open endpoint can't slip through behind an inline guard.
 * - `public`  — no allowlist match and every middleware is a nameable identifier
 *   or call the auditor could have allow-listed (e.g. `express.json`, a logger).
 *   Treated as unauthenticated. If a named middleware here is in fact auth, add
 *   it to `authMiddleware` and re-run.
 *
 * @param {import("./middleware").Descriptor[]} middlewares
 * @param {Record<string,string>} authMiddleware  name/dotted-callee -> tag
 * @returns {{authStatus: string, tags: string[]}}
 */
function authStatusFor(middlewares, authMiddleware) {
  const tags = new Set();
  let opaque = false;
  // Own-property lookup only: a middleware named `constructor` must not match
  // Object.prototype and classify as proven.
  const tagFor = (name) => (Object.hasOwn(authMiddleware, name) ? authMiddleware[name] : undefined);
  for (const mw of middlewares) {
    const tag = tagFor(mw.name);
    if (tag) tags.add(tag);
    // Wrapped guards (`asyncHandler(requireAuth)`) match through their inner names.
    for (const name of mw.inner || []) {
      const innerTag = tagFor(name);
      if (innerTag) tags.add(innerTag);
    }
    if (isOpaque(mw)) opaque = true;
  }
  if (tags.size > 0) return { authStatus: "proven", tags: [...tags] };
  if (opaque) return { authStatus: "unknown", tags: [REVIEW_TAG] };
  return { authStatus: "public", tags: [PUBLIC_TAG] };
}

function routeKey(route) {
  return `${route.method} ${route.path}`;
}

function tagRoute(route, authMiddleware, acceptedPublic) {
  const { authStatus, tags } = authStatusFor(route.middlewares, authMiddleware);
  const accepted = authStatus === "public" && acceptedPublic.has(routeKey(route));
  return accepted ? { ...route, authStatus, tags, accepted: true } : { ...route, authStatus, tags };
}

/**
 * Annotate every route with `authStatus` + `tags` derived from
 * `options.authMiddleware`. Routes whose `METHOD /path` key is in
 * `options.acceptedPublic` — a reviewed baseline of intentionally-open
 * endpoints — are additionally tagged `accepted`, which suppresses their
 * `public-route` finding and `--fail-on public` match.
 *
 * @param {{routes: object[], globalMiddleware: object[]}} registry
 * @param {{authMiddleware?: Record<string,string>, acceptedPublic?: string[]}} options
 */
function classify(registry, options) {
  const authMiddleware = (options && options.authMiddleware) || {};
  const acceptedPublic = new Set((options && options.acceptedPublic) || []);
  return {
    routes: registry.routes.map((r) => tagRoute(r, authMiddleware, acceptedPublic)),
    globalMiddleware: registry.globalMiddleware,
    diagnostics: registry.diagnostics || [],
    acceptedPublic: [...acceptedPublic],
  };
}

/**
 * Find paths whose auth status differs across HTTP methods — e.g. `POST /x` is
 * proven but `PATCH /x` is public. These per-verb gaps are an easy way to leave
 * a write path unauthenticated on an otherwise-guarded resource.
 *
 * @param {object[]} routes  classified routes
 * @returns {{path: string, methods: {method: string, authStatus: string}[]}[]}
 */
function inconsistentPaths(routes) {
  const byPath = new Map();
  for (const route of routes) {
    const acc = byPath.get(route.path) || [];
    acc.push({ method: route.method, authStatus: route.authStatus, source: route.source || null });
    byPath.set(route.path, acc);
  }
  const result = [];
  for (const [path, methods] of byPath) {
    if (new Set(methods.map((m) => m.authStatus)).size > 1) {
      result.push({ path, methods: methods.sort((a, b) => a.method.localeCompare(b.method)) });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

module.exports = { classify, authStatusFor, inconsistentPaths, PUBLIC_TAG, REVIEW_TAG };
