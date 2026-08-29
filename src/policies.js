"use strict";

const { fingerprintFinding } = require("./findings");

const SEVERITIES = new Set(["high", "medium", "low"]);
const AUTH_STATUSES = new Set(["proven", "public", "unknown"]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ALL"]);
const ARRAY_REQUIREMENTS = [
  "anyMiddleware",
  "allMiddleware",
  "noMiddleware",
  "middlewareOrder",
  "anyTag",
  "allTags",
  "noTags",
  "anyRole",
  "allRoles",
  "noRoles",
  "anyScope",
  "allScopes",
  "noScopes",
];

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unknown field(s): ${unknown.join(", ")}`);
}

function stringArray(value, label, { nonEmpty = false } = {}) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  if (nonEmpty && value.length === 0) throw new Error(`${label} must not be empty`);
  return value.map((item) => item.trim());
}

function normalizeMatch(match, label, { requireSelector = false } = {}) {
  const value = match || {};
  if (!plainObject(value)) throw new Error(`${label} must be an object`);
  assertKnownKeys(
    value,
    new Set([
      "applicationIds",
      "methods",
      "paths",
      "excludePaths",
      "authStatuses",
      "tags",
      "roles",
      "scopes",
    ]),
    label,
  );
  const methods = stringArray(value.methods, `${label}.methods`, { nonEmpty: true });
  if (methods) {
    for (const method of methods) {
      if (!METHODS.has(method.toUpperCase())) {
        throw new Error(`${label}.methods contains unsupported method "${method}"`);
      }
    }
  }
  const authStatuses = stringArray(value.authStatuses, `${label}.authStatuses`, {
    nonEmpty: true,
  });
  if (authStatuses) {
    for (const status of authStatuses) {
      if (!AUTH_STATUSES.has(status)) {
        throw new Error(`${label}.authStatuses contains unsupported status "${status}"`);
      }
    }
  }
  const normalized = {
    applicationIds: stringArray(value.applicationIds, `${label}.applicationIds`, {
      nonEmpty: true,
    }),
    methods: methods && methods.map((method) => method.toUpperCase()),
    paths: stringArray(value.paths, `${label}.paths`, { nonEmpty: true }),
    excludePaths: stringArray(value.excludePaths, `${label}.excludePaths`, { nonEmpty: true }),
    authStatuses,
    tags: stringArray(value.tags, `${label}.tags`, { nonEmpty: true }),
    roles: stringArray(value.roles, `${label}.roles`, { nonEmpty: true }),
    scopes: stringArray(value.scopes, `${label}.scopes`, { nonEmpty: true }),
  };
  if (requireSelector && !Object.values(normalized).some(Boolean)) {
    throw new Error(
      `${label} must select at least one application, method, path, auth status, tag, role, or scope`,
    );
  }
  return normalized;
}

function normalizeRequirement(requirement, label, depth = 0) {
  if (!plainObject(requirement)) throw new Error(`${label} must be an object`);
  if (depth > 12) throw new Error(`${label} exceeds the maximum boolean-expression depth`);
  assertKnownKeys(
    requirement,
    new Set(["auth", ...ARRAY_REQUIREMENTS, "roles", "scopes", "all", "any", "not"]),
    label,
  );
  if (requirement.auth !== undefined && requirement.auth !== true) {
    throw new Error(`${label}.auth currently supports only true`);
  }

  const normalized = { auth: requirement.auth === true };
  for (const field of ARRAY_REQUIREMENTS) {
    normalized[field] = stringArray(requirement[field], `${label}.${field}`, { nonEmpty: true });
  }
  // Concise aliases mean "all required" and normalize to the explicit fields.
  if (requirement.roles !== undefined) {
    if (normalized.allRoles) throw new Error(`${label} cannot set both roles and allRoles`);
    normalized.allRoles = stringArray(requirement.roles, `${label}.roles`, { nonEmpty: true });
  }
  if (requirement.scopes !== undefined) {
    if (normalized.allScopes) throw new Error(`${label} cannot set both scopes and allScopes`);
    normalized.allScopes = stringArray(requirement.scopes, `${label}.scopes`, { nonEmpty: true });
  }
  for (const operator of ["all", "any"]) {
    if (requirement[operator] !== undefined) {
      if (!Array.isArray(requirement[operator]) || requirement[operator].length === 0) {
        throw new Error(`${label}.${operator} must be a non-empty array of requirements`);
      }
      normalized[operator] = requirement[operator].map((child, index) =>
        normalizeRequirement(child, `${label}.${operator}[${index}]`, depth + 1),
      );
    }
  }
  if (requirement.not !== undefined) {
    normalized.not = normalizeRequirement(requirement.not, `${label}.not`, depth + 1);
  }

  const hasLeaf =
    normalized.auth || ARRAY_REQUIREMENTS.some((field) => normalized[field] !== undefined);
  if (!hasLeaf && !normalized.all && !normalized.any && !normalized.not) {
    throw new Error(
      `${label} must set auth:true, a tag/role/scope/middleware requirement, or all/any/not`,
    );
  }
  return normalized;
}

function normalizeException(exception, policyLabel, index) {
  const label = `${policyLabel}.exceptions[${index}]`;
  if (!plainObject(exception)) throw new Error(`${label} must be an object`);
  assertKnownKeys(exception, new Set(["id", "reason", "expires", "match"]), label);
  const id = exception.id || `exception-${index + 1}`;
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`${label}.id must be a stable identifier`);
  }
  if (typeof exception.reason !== "string" || !exception.reason.trim()) {
    throw new Error(`${label}.reason must be a non-empty string`);
  }
  if (typeof exception.expires !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(exception.expires)) {
    throw new Error(`${label}.expires must be an ISO date (YYYY-MM-DD)`);
  }
  const timestamp = Date.parse(`${exception.expires}T00:00:00Z`);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== exception.expires
  ) {
    throw new Error(`${label}.expires is not a valid calendar date`);
  }
  return {
    id,
    reason: exception.reason.trim(),
    expires: exception.expires,
    match: normalizeMatch(exception.match, `${label}.match`, { requireSelector: true }),
  };
}

function normalizePolicy(policy, index) {
  const label = `policies[${index}]`;
  if (!plainObject(policy)) throw new Error(`${label} must be an object`);
  assertKnownKeys(
    policy,
    new Set([
      "id",
      "description",
      "severity",
      "match",
      "require",
      "exceptions",
      "message",
      "recommendation",
    ]),
    label,
  );
  if (typeof policy.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(policy.id)) {
    throw new Error(`${label}.id must contain only letters, numbers, ".", "_", or "-"`);
  }
  const severity = policy.severity || "medium";
  if (!SEVERITIES.has(severity)) {
    throw new Error(`${label}.severity must be high, medium, or low`);
  }
  for (const field of ["description", "message", "recommendation"]) {
    if (policy[field] !== undefined && typeof policy[field] !== "string") {
      throw new Error(`${label}.${field} must be a string`);
    }
  }
  if (policy.exceptions !== undefined && !Array.isArray(policy.exceptions)) {
    throw new Error(`${label}.exceptions must be an array`);
  }
  const exceptions = (policy.exceptions || []).map((item, exceptionIndex) =>
    normalizeException(item, label, exceptionIndex),
  );
  const exceptionIds = new Set();
  for (const exception of exceptions) {
    if (exceptionIds.has(exception.id))
      throw new Error(`${label} has duplicate exception "${exception.id}"`);
    exceptionIds.add(exception.id);
  }
  return {
    id: policy.id,
    description: policy.description,
    severity,
    match: normalizeMatch(policy.match, `${label}.match`),
    require: normalizeRequirement(policy.require || {}, `${label}.require`),
    exceptions,
    message: policy.message,
    recommendation: policy.recommendation,
  };
}

function normalizePolicies(policies) {
  if (policies === undefined) return [];
  if (!Array.isArray(policies)) throw new Error("policies must be an array");
  const normalized = policies.map(normalizePolicy);
  const ids = new Set();
  for (const policy of normalized) {
    if (ids.has(policy.id)) throw new Error(`Duplicate policy id "${policy.id}"`);
    ids.add(policy.id);
  }
  return normalized;
}

function escapeRegex(char) {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

/** Route-path glob: `*` stays within a segment and `**` crosses `/`. */
function pathPattern(pattern) {
  if (pattern.endsWith("/**")) {
    const base = pattern.slice(0, -3);
    return new RegExp(`^${[...base].map(escapeRegex).join("")}(?:/.*)?$`);
  }
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      source += ".*";
      i++;
    } else if (pattern[i] === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegex(pattern[i]);
    }
  }
  return new RegExp(`${source}$`);
}

function matchesAnyPath(path, patterns) {
  return patterns.some((pattern) => pathPattern(pattern).test(path));
}

function overlaps(actual, required) {
  return required.some((item) => actual.includes(item));
}

function routeMatches(route, match) {
  if (match.applicationIds && !match.applicationIds.includes(route.applicationId)) return false;
  if (match.methods && !match.methods.includes(route.method)) return false;
  if (match.paths && !matchesAnyPath(route.path, match.paths)) return false;
  if (match.excludePaths && matchesAnyPath(route.path, match.excludePaths)) return false;
  if (match.authStatuses && !match.authStatuses.includes(route.authStatus)) return false;
  if (match.tags && !overlaps(route.tags || [], match.tags)) return false;
  if (match.roles && !overlaps(route.roles || [], match.roles)) return false;
  if (match.scopes && !overlaps(route.scopes || [], match.scopes)) return false;
  return true;
}

function middlewareSequence(route) {
  return route.middlewares.flatMap((middleware) => [middleware.name, ...(middleware.inner || [])]);
}

function missingAny(actual, required) {
  return required && !required.some((item) => actual.includes(item)) ? required : undefined;
}

function missingAll(actual, required) {
  if (!required) return undefined;
  const missing = required.filter((item) => !actual.includes(item));
  return missing.length ? missing : undefined;
}

function forbidden(actual, required) {
  if (!required) return undefined;
  const present = required.filter((item) => actual.includes(item));
  return present.length ? present : undefined;
}

function orderingFailure(sequence, required) {
  if (!required) return undefined;
  let cursor = -1;
  for (const name of required) {
    const position = sequence.indexOf(name, cursor + 1);
    if (position === -1) return { required, observed: sequence };
    cursor = position;
  }
  return undefined;
}

function evaluateRequirement(route, requirement) {
  const middleware = middlewareSequence(route);
  const tags = route.tags || [];
  const roles = route.roles || [];
  const scopes = route.scopes || [];
  const evidence = {};
  if (requirement.auth && route.authStatus !== "proven") evidence.missingAuth = true;

  const checks = [
    ["missingAnyMiddleware", missingAny(middleware, requirement.anyMiddleware)],
    ["missingAllMiddleware", missingAll(middleware, requirement.allMiddleware)],
    ["forbiddenMiddleware", forbidden(middleware, requirement.noMiddleware)],
    ["middlewareOrder", orderingFailure(middleware, requirement.middlewareOrder)],
    ["missingAnyTag", missingAny(tags, requirement.anyTag)],
    ["missingAllTags", missingAll(tags, requirement.allTags)],
    ["forbiddenTags", forbidden(tags, requirement.noTags)],
    ["missingAnyRole", missingAny(roles, requirement.anyRole)],
    ["missingAllRoles", missingAll(roles, requirement.allRoles)],
    ["forbiddenRoles", forbidden(roles, requirement.noRoles)],
    ["missingAnyScope", missingAny(scopes, requirement.anyScope)],
    ["missingAllScopes", missingAll(scopes, requirement.allScopes)],
    ["forbiddenScopes", forbidden(scopes, requirement.noScopes)],
  ];
  for (const [key, value] of checks) if (value !== undefined) evidence[key] = value;

  if (requirement.all) {
    const failed = requirement.all
      .map((child, index) => ({ index, result: evaluateRequirement(route, child) }))
      .filter(({ result }) => !result.satisfied)
      .map(({ index, result }) => ({ index, evidence: result.evidence }));
    if (failed.length) evidence.allOf = failed;
  }
  if (requirement.any) {
    const alternatives = requirement.any.map((child) => evaluateRequirement(route, child));
    if (!alternatives.some((result) => result.satisfied)) {
      evidence.anyOf = alternatives.map((result, index) => ({ index, evidence: result.evidence }));
    }
  }
  if (requirement.not) {
    const negated = evaluateRequirement(route, requirement.not);
    if (negated.satisfied) evidence.forbiddenCondition = { matched: true };
  }
  return { satisfied: Object.keys(evidence).length === 0, evidence };
}

function defaultDetail(evidence) {
  const parts = [];
  if (evidence.missingAuth) parts.push("recognised authentication");
  for (const [key, label] of [
    ["missingAnyMiddleware", "one required middleware"],
    ["missingAllMiddleware", "required middleware"],
    ["missingAnyTag", "one required auth tag"],
    ["missingAllTags", "required auth tags"],
    ["missingAnyRole", "one required role"],
    ["missingAllRoles", "required roles"],
    ["missingAnyScope", "one required scope"],
    ["missingAllScopes", "required scopes"],
  ]) {
    if (evidence[key]) parts.push(`${label} [${evidence[key].join(", ")}]`);
  }
  if (evidence.forbiddenMiddleware) {
    parts.push(`forbidden middleware [${evidence.forbiddenMiddleware.join(", ")}]`);
  }
  if (evidence.forbiddenTags) parts.push(`forbidden tags [${evidence.forbiddenTags.join(", ")}]`);
  if (evidence.forbiddenRoles)
    parts.push(`forbidden roles [${evidence.forbiddenRoles.join(", ")}]`);
  if (evidence.forbiddenScopes)
    parts.push(`forbidden scopes [${evidence.forbiddenScopes.join(", ")}]`);
  if (evidence.middlewareOrder) parts.push("required middleware ordering");
  if (evidence.allOf || evidence.anyOf || evidence.forbiddenCondition) {
    parts.push("the configured boolean requirement");
  }
  return `Route does not satisfy policy requirements: ${parts.join("; ")}.`;
}

function defaultRecommendation(evidence) {
  const recommendations = [];
  if (evidence.forbiddenMiddleware) {
    recommendations.push(
      `Remove ${evidence.forbiddenMiddleware.join(", ")} from the middleware chain.`,
    );
  }
  if (evidence.missingAuth) {
    recommendations.push("Add an always-enforcing authentication middleware.");
  }
  if (evidence.middlewareOrder) {
    recommendations.push(`Order middleware as ${evidence.middlewareOrder.required.join(" → ")}.`);
  }
  if (evidence.missingAnyMiddleware) {
    recommendations.push(
      `Add one of ${evidence.missingAnyMiddleware.join(", ")} to the route chain.`,
    );
  }
  if (evidence.missingAllMiddleware) {
    recommendations.push(`Add ${evidence.missingAllMiddleware.join(", ")} to the route chain.`);
  }
  if (
    evidence.missingAnyRole ||
    evidence.missingAllRoles ||
    evidence.missingAnyScope ||
    evidence.missingAllScopes
  ) {
    recommendations.push("Add the required authorization grant to authMiddleware configuration.");
  }
  if (recommendations.length === 0) {
    recommendations.push(
      "Update the route middleware or policy metadata to satisfy this requirement.",
    );
  }
  return recommendations.join(" ");
}

function confidenceFor(route) {
  if (route.pathConfidence === "partial" || route.presence === "static-only") return "medium";
  return "high";
}

function todayUtc(now) {
  const invalid = () => new Error("policy evaluation now must be a valid date");
  let datePart;
  if (typeof now === "string") {
    const match = now.match(/^(\d{4}-\d{2}-\d{2})(?:T.+)?$/);
    if (!match) throw invalid();
    datePart = match[1];
    const calendarDate = new Date(`${datePart}T00:00:00Z`);
    if (
      Number.isNaN(calendarDate.getTime()) ||
      calendarDate.toISOString().slice(0, 10) !== datePart
    ) {
      throw invalid();
    }
  }
  const value = now === undefined ? new Date() : new Date(now);
  if (Number.isNaN(value.getTime())) throw invalid();
  return value.toISOString().slice(0, 10);
}

function evaluatePolicies(registry, policies, options = {}) {
  const normalized = normalizePolicies(policies);
  const policyFindings = [];
  const policyExceptions = [];
  const today = todayUtc(options.now);
  const diagnostics = [...(registry.diagnostics || [])];
  for (const policy of normalized) {
    for (const exception of policy.exceptions) {
      if (exception.expires < today) {
        diagnostics.push(
          `policy: exception ${policy.id}/${exception.id} expired on ${exception.expires} and no longer suppresses violations`,
        );
      }
    }
  }
  for (const policy of normalized) {
    for (const route of registry.routes) {
      if (!routeMatches(route, policy.match)) continue;
      const matchingExceptions = policy.exceptions.filter((exception) =>
        routeMatches(route, exception.match),
      );
      const result = evaluateRequirement(route, policy.require);
      if (result.satisfied) continue;
      const activeException = matchingExceptions.find((exception) => exception.expires >= today);
      if (activeException) {
        policyExceptions.push({
          policyId: policy.id,
          exceptionId: activeException.id,
          applicationId: route.applicationId ?? null,
          method: route.method,
          path: route.path,
          reason: activeException.reason,
          expires: activeException.expires,
        });
        continue;
      }
      const expiredException = matchingExceptions
        .filter((exception) => exception.expires < today)
        .sort((a, b) => b.expires.localeCompare(a.expires))[0];
      if (expiredException) {
        result.evidence.expiredException = {
          id: expiredException.id,
          reason: expiredException.reason,
          expired: expiredException.expires,
        };
      }
      policyFindings.push(
        fingerprintFinding({
          id: "policy-violation",
          ruleId: policy.id,
          severity: policy.severity,
          confidence: confidenceFor(route),
          applicationId: route.applicationId ?? null,
          method: route.method,
          path: route.path,
          source: route.source || null,
          detail: policy.message || defaultDetail(result.evidence),
          recommendation: policy.recommendation || defaultRecommendation(result.evidence),
          evidence: result.evidence,
        }),
      );
    }
  }
  return {
    ...registry,
    diagnostics,
    policies: normalized,
    policyFindings,
    policyExceptions,
  };
}

module.exports = {
  evaluatePolicies,
  evaluateRequirement,
  normalizePolicies,
  pathPattern,
  routeMatches,
  todayUtc,
};
