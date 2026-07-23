"use strict";

const PLACEHOLDER = "AI-unrefined placeholder — refine via handler code review";
const UNREFINED_NOTE =
  "Schemas, parameters, and descriptions are AI-unrefined placeholders derived from static " +
  "analysis; refine them via handler code review.";

// router.all() answers every verb; expand it across the concrete methods so the
// spec stays valid (OpenAPI has no "all" operation key).
const ALL_VERBS = ["get", "post", "put", "patch", "delete"];
const BODY_METHODS = new Set(["post", "put", "patch", "delete"]);

/**
 * Convert an Express path to an OpenAPI path template, returning the template
 * and its ordered, unique path-parameter names. `:name`/`:name?` → `{name}`,
 * Express-5 `{name}` is kept, `*`/splats → `{wildcard}`, and an unresolved
 * `<dynamic>` segment → `{dynamic}`.
 */
function toOpenApiPath(exprPath) {
  const used = new Set();
  const unique = (base) => {
    let name = base || "param";
    let i = 2;
    while (used.has(name)) name = `${base}${i++}`;
    used.add(name);
    return name;
  };
  const segments = (exprPath || "/").split("/").map((seg) => {
    if (seg === "") return seg;
    if (seg === "<dynamic>") return `{${unique("dynamic")}}`;
    if (/^\{[A-Za-z0-9_]+\}$/.test(seg)) return `{${unique(seg.slice(1, -1))}}`;
    if (seg.startsWith(":")) {
      const base = seg.slice(1).replace(/[^A-Za-z0-9_].*$/, "");
      return `{${unique(base)}}`;
    }
    if (seg.includes("*")) return `{${unique("wildcard")}}`;
    return seg;
  });
  const path = segments.join("/") || "/";
  return { path, params: [...used] };
}

/** Tag from the first literal path segment (parameters/root → "default"). */
function firstSegmentTag(templatedPath) {
  const parts = templatedPath.split("/").filter(Boolean);
  const first = parts[0];
  if (!first || first.startsWith("{")) return "default";
  return first;
}

function sanitizeOperationId(method, templatedPath) {
  const base = `${method}_${templatedPath}`.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return base.replace(/^_+|_+$/g, "") || "root";
}

/** securityScheme component keys must be `[A-Za-z0-9._-]`; tags may hold ":" etc. */
function sanitizeSchemeName(tag) {
  return tag.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function placeholderObjectSchema(keys) {
  const properties = {};
  for (const k of keys) properties[k] = {};
  return { type: "object", properties, "x-express-recon-unrefined": true };
}

function buildParameters(pathParams, io) {
  const params = pathParams.map((name) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
    description: PLACEHOLDER,
  }));
  if (io) {
    for (const name of io.request.query)
      params.push({ name, in: "query", required: false, schema: {}, description: PLACEHOLDER });
    for (const name of io.request.headers)
      params.push({
        name,
        in: "header",
        required: false,
        schema: { type: "string" },
        description: PLACEHOLDER,
      });
  }
  return params;
}

function buildRequestBody(verb, io) {
  if (!BODY_METHODS.has(verb) || !io || io.request.body.length === 0) return null;
  return {
    required: false,
    content: { "application/json": { schema: placeholderObjectSchema(io.request.body) } },
  };
}

function buildResponses(io) {
  const responses = {};
  if (io) {
    for (const r of io.responses) {
      if (r.status == null) continue;
      const resp = { description: PLACEHOLDER };
      if (r.bodyKeys && r.bodyKeys.length)
        resp.content = { "application/json": { schema: placeholderObjectSchema(r.bodyKeys) } };
      responses[String(r.status)] = resp;
    }
    for (const code of io.statusCodes)
      if (!responses[String(code)]) responses[String(code)] = { description: PLACEHOLDER };
  }
  responses.default = { description: "AI-unrefined default response" };
  return responses;
}

/**
 * Per-operation `security`: proven routes reference a bearer scheme per auth tag
 * (registered in `schemes`); public routes get an explicit `[]` (no auth); an
 * `unknown` (opaque) route omits `security` and is flagged for review. Inventory
 * routes carry no `authStatus`, so `security` is omitted.
 *
 * @returns {object[]|undefined}
 */
function buildSecurity(route, schemes) {
  if (route.authStatus === "public") return [];
  if (route.authStatus === "proven") {
    const requirements = [];
    for (const tag of route.tags || []) {
      const name = sanitizeSchemeName(tag);
      if (!schemes.has(name))
        schemes.set(name, {
          type: "http",
          scheme: "bearer",
          description: `AI-unrefined; derived from middleware auth tag '${tag}'`,
        });
      requirements.push({ [name]: [] });
    }
    return requirements;
  }
  return undefined;
}

function buildOperation(route, verb, opId, tag, isAudit, pathParams, schemes) {
  const op = { operationId: opId, tags: [tag], responses: buildResponses(route.io) };
  const params = buildParameters(pathParams, route.io);
  if (params.length) op.parameters = params;
  const body = buildRequestBody(verb, route.io);
  if (body) op.requestBody = body;
  if (isAudit) {
    const security = buildSecurity(route, schemes);
    if (security !== undefined) op.security = security;
  }
  op["x-express-recon"] = {
    source: route.source || null,
    authStatus: route.authStatus ?? null,
    authTags: route.tags || [],
    roles: route.roles || [],
    scopes: route.scopes || [],
    middlewares: route.middlewares.map((m) => m.name),
    pathConfidence: route.pathConfidence,
    handlerResolved: route.io ? route.io.handlerResolved : null,
    handlerName: route.io ? (route.io.handlerName ?? null) : null,
    method: route.method,
  };
  return op;
}

function compareRoutes(a, b) {
  if (a.path === b.path) return a.method.localeCompare(b.method);
  return a.path.localeCompare(b.path);
}

function buildInfo(report) {
  const target = report.target || {};
  return {
    title: target.name ? `${target.name} API` : "express-recon API",
    version: target.version || "0.0.0",
    "x-express-recon-note": UNREFINED_NOTE,
  };
}

/**
 * Render an inventory/audit report as an OpenAPI 3.1 document. Paths, methods,
 * path/query/header parameters, request/response placeholders, and (for audit
 * reports) security requirements are derived deterministically; the schema
 * bodies are placeholders for an AI enrichment pass, marked throughout with
 * `x-express-recon` extensions carrying the source location and auth posture.
 *
 * @param {object} report  a buildReport() result
 * @returns {string} pretty-printed OpenAPI 3.1 JSON
 */
function format(report) {
  const isAudit = report.command === "audit";
  const schemes = new Map();
  const opIds = new Set();
  const paths = {};

  for (const route of report.routes.slice().sort(compareRoutes)) {
    const { path: templated, params: pathParams } = toOpenApiPath(route.path);
    const tag = firstSegmentTag(templated);
    const verbs = route.method === "ALL" ? ALL_VERBS : [route.method.toLowerCase()];
    const item = paths[templated] || (paths[templated] = {});
    for (const verb of verbs) {
      if (item[verb]) continue;
      let opId = sanitizeOperationId(verb, templated);
      let n = 2;
      while (opIds.has(opId)) opId = `${sanitizeOperationId(verb, templated)}_${n++}`;
      opIds.add(opId);
      item[verb] = buildOperation(route, verb, opId, tag, isAudit, pathParams, schemes);
    }
  }

  const doc = { openapi: "3.1.0", info: buildInfo(report), paths };
  if (schemes.size > 0) doc.components = { securitySchemes: Object.fromEntries(schemes) };
  doc["x-express-recon"] = {
    generated: true,
    tool: "express-recon",
    schemaVersion: report.schemaVersion,
    command: report.command,
    mode: report.mode,
    schemasArePlaceholders: true,
  };
  return JSON.stringify(doc, null, 2);
}

module.exports = { format };
