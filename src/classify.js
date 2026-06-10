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
  for (const mw of middlewares) {
    const tag = authMiddleware[mw.name];
    if (tag) tags.add(tag);
    if (isOpaque(mw)) opaque = true;
  }
  if (tags.size > 0) return { authStatus: "proven", tags: [...tags] };
  if (opaque) return { authStatus: "unknown", tags: [REVIEW_TAG] };
  return { authStatus: "public", tags: [PUBLIC_TAG] };
}

function tagRoute(route, authMiddleware) {
  const { authStatus, tags } = authStatusFor(route.middlewares, authMiddleware);
  return { ...route, authStatus, tags };
}

/**
 * Annotate every route with `authStatus` + `tags` derived from
 * `options.authMiddleware`.
 *
 * @param {{routes: object[], globalMiddleware: object[]}} registry
 * @param {{authMiddleware?: Record<string,string>}} options
 */
function classify(registry, options) {
  const authMiddleware = (options && options.authMiddleware) || {};
  return {
    routes: registry.routes.map((r) => tagRoute(r, authMiddleware)),
    globalMiddleware: registry.globalMiddleware,
    diagnostics: registry.diagnostics || [],
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
    acc.push({ method: route.method, authStatus: route.authStatus });
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
