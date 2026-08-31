"use strict";

const { isOpaque } = require("./middleware");

const PUBLIC_TAG = "public";
const REVIEW_TAG = "unknown:review";

function validateAuthMiddleware(authMiddleware) {
  if (!authMiddleware || typeof authMiddleware !== "object" || Array.isArray(authMiddleware)) {
    throw new Error("authMiddleware must be an object");
  }
  for (const [name, value] of Object.entries(authMiddleware)) {
    if (!name.trim()) throw new Error("authMiddleware names must not be empty");
    if (typeof value === "string" && value) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`authMiddleware.${name} must be a tag string or grant object`);
    }
    const unknown = Object.keys(value).filter(
      (field) => !["tag", "tags", "roles", "scopes"].includes(field),
    );
    if (unknown.length) {
      throw new Error(`authMiddleware.${name} contains unknown field(s): ${unknown.join(", ")}`);
    }
    const values = [
      ...(value.tag === undefined ? [] : [value.tag]),
      ...(value.tags || []),
      ...(value.roles || []),
      ...(value.scopes || []),
    ];
    if (
      !["tags", "roles", "scopes"].every(
        (field) => value[field] === undefined || Array.isArray(value[field]),
      ) ||
      values.length === 0 ||
      values.some((item) => typeof item !== "string" || !item)
    ) {
      throw new Error(
        `authMiddleware.${name} must contain non-empty string tags, roles, or scopes`,
      );
    }
  }
}

function validateAuthWrappers(authWrappers) {
  if (
    !Array.isArray(authWrappers) ||
    authWrappers.some((name) => typeof name !== "string" || !name.trim())
  ) {
    throw new Error("authWrappers must be an array of non-empty wrapper names");
  }
}

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
 * @param {Record<string,string|{tag?:string,tags?:string[],roles?:string[],scopes?:string[]}>} authMiddleware
 * @param {boolean} [validated]
 * @param {string[]} [authWrappers] calls that unconditionally preserve/execute wrapped middleware
 * @returns {{authStatus: string, tags: string[], roles: string[], scopes: string[], authEvidence: object}}
 */
function authStatusFor(middlewares, authMiddleware, validated = false, authWrappers = []) {
  if (!validated) {
    validateAuthMiddleware(authMiddleware);
    validateAuthWrappers(authWrappers);
  }
  const transparentWrappers = new Set(authWrappers);
  const tags = new Set();
  const roles = new Set();
  const scopes = new Set();
  const matched = [];
  let opaque = false;
  // Own-property lookup only: a middleware named `constructor` must not match
  // Object.prototype and classify as proven.
  const grantFor = (name) => {
    if (!Object.hasOwn(authMiddleware, name)) return null;
    const value = authMiddleware[name];
    if (typeof value === "string" && value) return { tags: [value], roles: [], scopes: [] };
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const grantTags = [
      ...(typeof value.tag === "string" && value.tag ? [value.tag] : []),
      ...(Array.isArray(value.tags) ? value.tags : []),
    ];
    const grantRoles = Array.isArray(value.roles) ? value.roles : [];
    const grantScopes = Array.isArray(value.scopes) ? value.scopes : [];
    if (![...grantTags, ...grantRoles, ...grantScopes].every((item) => typeof item === "string")) {
      return null;
    }
    if (grantTags.length === 0 && (grantRoles.length > 0 || grantScopes.length > 0)) {
      grantTags.push("authenticated");
    }
    return { tags: grantTags, roles: grantRoles, scopes: grantScopes };
  };
  const applyGrant = (name) => {
    const grant = grantFor(name);
    if (!grant) return;
    for (const tag of grant.tags) tags.add(tag);
    for (const role of grant.roles) roles.add(role);
    for (const scope of grant.scopes) scopes.add(scope);
    matched.push({ name, ...grant });
  };
  for (const mw of middlewares) {
    applyGrant(mw.name);
    const inner = mw.inner || [];
    if (transparentWrappers.has(mw.name)) {
      // Only configured pass-through wrappers may prove an inner guard. An
      // arbitrary call could conditionally disable or merely reference it.
      for (const name of inner) applyGrant(name);
    } else if (inner.some((name) => grantFor(name))) {
      opaque = true;
    }
    if (isOpaque(mw)) opaque = true;
  }
  const authEvidence = { matched };
  if (matched.length > 0) {
    return {
      authStatus: "proven",
      tags: [...tags],
      roles: [...roles],
      scopes: [...scopes],
      authEvidence,
    };
  }
  if (opaque) {
    return {
      authStatus: "unknown",
      tags: [REVIEW_TAG],
      roles: [],
      scopes: [],
      authEvidence: { matched: [], opaque: true },
    };
  }
  return {
    authStatus: "public",
    tags: [PUBLIC_TAG],
    roles: [],
    scopes: [],
    authEvidence,
  };
}

function routeKey(route) {
  return `${route.method} ${route.path}`;
}

function acceptedRoute(route, acceptedPublic) {
  const key = routeKey(route);
  return acceptedPublic.some((entry) => {
    if (typeof entry === "string") return entry === key;
    return (
      entry.applicationId === route.applicationId &&
      entry.method === route.method &&
      entry.path === route.path
    );
  });
}

function tagRoute(route, authMiddleware, authWrappers, acceptedPublic) {
  const classification = authStatusFor(route.middlewares, authMiddleware, true, authWrappers);
  const { authStatus } = classification;
  const accepted = authStatus === "public" && acceptedRoute(route, acceptedPublic);
  const classified = { ...route, ...classification };
  return accepted ? { ...classified, accepted: true } : classified;
}

/**
 * Annotate every route with `authStatus` + `tags` derived from
 * `options.authMiddleware`. Routes whose `METHOD /path` key is in
 * `options.acceptedPublic` — a reviewed baseline of intentionally-open
 * endpoints — are additionally tagged `accepted`, which suppresses their
 * `public-route` finding and `--fail-on public` match. Legacy string entries
 * apply across applications; structured entries target one application ID.
 *
 * @param {{routes: object[], globalMiddleware: object[]}} registry
 * @param {{authMiddleware?: Record<string,string|object>, authWrappers?: string[], acceptedPublic?: (string|{applicationId:string,method:string,path:string})[]}} options
 */
function classify(registry, options) {
  const authMiddleware = (options && options.authMiddleware) || {};
  const authWrappers = (options && options.authWrappers) || [];
  validateAuthMiddleware(authMiddleware);
  validateAuthWrappers(authWrappers);
  const acceptedPublic = (options && options.acceptedPublic) || [];
  return {
    routes: registry.routes.map((r) => tagRoute(r, authMiddleware, authWrappers, acceptedPublic)),
    globalMiddleware: registry.globalMiddleware,
    applications: registry.applications || [],
    diagnostics: registry.diagnostics || [],
    acceptedPublic: acceptedPublic.map((entry) =>
      typeof entry === "string" ? entry : { ...entry },
    ),
    ...(options && options.openapi ? { openapi: options.openapi } : {}),
    ...(registry.scanCoverage ? { scanCoverage: registry.scanCoverage } : {}),
    ...(registry.routeGraph ? { routeGraph: registry.routeGraph } : {}),
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
    const key = `${route.applicationId || ""}\0${route.path}`;
    const acc = byPath.get(key) || {
      applicationId: route.applicationId ?? null,
      path: route.path,
      methods: [],
    };
    acc.methods.push({
      method: route.method,
      authStatus: route.authStatus,
      source: route.source || null,
    });
    byPath.set(key, acc);
  }
  const result = [];
  for (const { applicationId, path, methods } of byPath.values()) {
    if (new Set(methods.map((m) => m.authStatus)).size > 1) {
      result.push({
        applicationId,
        path,
        methods: methods.sort((a, b) => a.method.localeCompare(b.method)),
      });
    }
  }
  return result.sort((a, b) => {
    const left = `${a.applicationId || ""}\0${a.path}`;
    const right = `${b.applicationId || ""}\0${b.path}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

module.exports = {
  classify,
  authStatusFor,
  inconsistentPaths,
  validateAuthMiddleware,
  validateAuthWrappers,
  PUBLIC_TAG,
  REVIEW_TAG,
};
