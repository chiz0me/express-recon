"use strict";

const POSSIBLE = "possible";
const DEFINITE = "definite";
const NONE = "none";

/**
 * Return the literal path prefix before the first path-pattern token. This is
 * deliberately smaller than an Express path matcher: it is used only to prove
 * that two scopes cannot overlap. Pattern matches remain possible until a
 * framework-version-aware matcher can prove them.
 */
function literalPrefix(pattern) {
  let escaped = false;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if ("*+?()[]{}:".includes(character) || pattern.startsWith("<dynamic>", index)) {
      let end = index;
      // Legacy postfix modifiers can change the preceding literal, so that
      // character is not part of the guaranteed prefix. A slash-prefixed `*`
      // is instead a wildcard segment in supported Express syntaxes.
      if ("+?".includes(character) || (character === "*" && pattern[index - 1] !== "/")) {
        end = Math.max(0, end - 1);
      }
      return pattern.slice(0, end).replace(/\/$/, "") || "/";
    }
  }
  return pattern;
}

function underPrefix(path, prefix) {
  return prefix === "/" || path === prefix || path.startsWith(`${prefix}/`);
}

function prefixesMayOverlap(left, right) {
  return left === "/" || right === "/" || left.startsWith(right) || right.startsWith(left);
}

/**
 * Explain whether a path-scoped Express middleware definitely applies to a
 * route pattern, definitely cannot apply, or may apply. Reasons accompany
 * uncertainty so callers can retain an auditable, enforceable result.
 */
function scopeEvidence(routePath, scopePath, options = {}) {
  if (scopePath?.length > 1) scopePath = scopePath.replace(/\/+$/, "") || "/";
  if (scopePath === null || scopePath === "" || scopePath === "/") {
    return { applicability: DEFINITE, reasons: [] };
  }
  // Express 4's bare catch-all forms are host-wide for registered routes. Keep
  // that established static behavior even though Express 5 requires a named
  // wildcard and rejects these legacy spellings during application startup.
  if (scopePath === "*" || scopePath === "/*") {
    return { applicability: DEFINITE, reasons: [] };
  }
  const routePrefix = literalPrefix(routePath);
  const routePatterned = routePrefix !== routePath;
  if (scopePath.endsWith("/*")) {
    const prefix = scopePath.slice(0, -2) || "/";
    if (literalPrefix(prefix) === prefix) {
      if (routePatterned) {
        if (prefixesMayOverlap(routePrefix, prefix)) {
          return { applicability: POSSIBLE, reasons: ["path-pattern"] };
        }
        if (prefixesMayOverlap(routePrefix.toLowerCase(), prefix.toLowerCase())) {
          return { applicability: POSSIBLE, reasons: ["case-sensitivity", "path-pattern"] };
        }
        return { applicability: NONE, reasons: [] };
      }
      if (prefix === "/" || routePath.startsWith(`${prefix}/`)) {
        return { applicability: DEFINITE, reasons: [] };
      }
      if (routePath === prefix) return { applicability: POSSIBLE, reasons: ["path-pattern"] };
      if (routePath.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) {
        return { applicability: POSSIBLE, reasons: ["case-sensitivity"] };
      }
      return { applicability: NONE, reasons: [] };
    }
  }
  const scopePrefix = literalPrefix(scopePath);
  const patterned = scopePrefix !== scopePath;
  if (!patterned && !routePatterned) {
    if (underPrefix(routePath, scopePath)) {
      // A case-insensitive route can also accept spellings that a
      // case-sensitive middleware scope rejects. Identical inventory strings
      // therefore prove coverage only when their matching modes are compatible.
      const scopeMayBeSensitive =
        options.scopeCaseSensitive === true || options.scopeCaseSensitive === null;
      if (scopeMayBeSensitive && options.routeCaseSensitive !== true) {
        return { applicability: POSSIBLE, reasons: ["case-sensitivity"] };
      }
      return { applicability: DEFINITE, reasons: [] };
    }
    if (underPrefix(routePath.toLowerCase(), scopePath.toLowerCase())) {
      return { applicability: POSSIBLE, reasons: ["case-sensitivity"] };
    }
    return { applicability: NONE, reasons: [] };
  }
  if (!prefixesMayOverlap(routePrefix, scopePrefix)) {
    if (prefixesMayOverlap(routePrefix.toLowerCase(), scopePrefix.toLowerCase())) {
      return { applicability: POSSIBLE, reasons: ["case-sensitivity", "path-pattern"] };
    }
    return { applicability: NONE, reasons: [] };
  }
  return {
    applicability: POSSIBLE,
    reasons: [
      scopePath.includes("<dynamic>")
        ? "unknown-mount"
        : routePath.includes("<dynamic>")
          ? "unknown-route"
          : "path-pattern",
    ],
  };
}

/**
 * Determine whether a path-scoped Express middleware definitely applies to a
 * route pattern, definitely cannot apply, or may apply. `null` denotes a
 * pathless `use(middleware)` registration and is therefore host-wide.
 */
function scopeApplicability(routePath, scopePath) {
  return scopeEvidence(routePath, scopePath).applicability;
}

function combineApplicability(left, right) {
  if (left === NONE || right === NONE) return NONE;
  if (left === POSSIBLE || right === POSSIBLE) return POSSIBLE;
  return DEFINITE;
}

/** Attach only non-default applicability so existing definite reports stay compact. */
function withApplicability(middleware, applicability, reasons = []) {
  if (applicability === DEFINITE) return middleware;
  const value = { ...middleware, applicability };
  const combined = [...new Set([...(middleware.applicabilityReasons || []), ...reasons])];
  if (combined.length > 0) value.applicabilityReasons = combined;
  return value;
}

module.exports = {
  DEFINITE,
  NONE,
  POSSIBLE,
  combineApplicability,
  scopeApplicability,
  scopeEvidence,
  withApplicability,
};
