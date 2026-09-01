"use strict";

const PLACEHOLDER = "AI-unrefined placeholder — refine via handler code review";
const UNREFINED_NOTE =
  "Schemas, parameters, and descriptions are AI-unrefined placeholders derived from static " +
  "analysis; refine them via handler code review.";

// router.all() answers every verb; expand it across the concrete methods so the
// spec stays valid (OpenAPI has no "all" operation key).
const ALL_VERBS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];
const BODY_METHODS = new Set(["post", "put", "patch", "delete"]);

/**
 * Convert a supported framework path to an OpenAPI path template, returning the template
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
  const joined = segments.join("/") || "/";
  const path = joined.startsWith("/") ? joined : `/${joined}`;
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

function placeholderObjectSchema(keys) {
  const properties = Object.fromEntries(keys.map((key) => [key, {}]));
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
 * Per-operation `security`: public routes get an explicit `[]`; proven routes
 * reference only schemes explicitly mapped through report.openapi.securityByTag.
 * Audit tags do not imply a protocol (a tag may mean a cookie session, HMAC,
 * mTLS, API key, or bearer token), so inventing a bearer scheme would publish a
 * materially incorrect contract. Multiple mapped schemes are placed in one
 * Security Requirement Object because chained configured guards are conjunctive.
 *
 * @returns {{security: object[]|undefined, unmappedTags: string[]}}
 */
function buildSecurity(route, config, usedSchemes) {
  if (route.authStatus === "public") return { security: [], unmappedTags: [] };
  if (route.authStatus === "proven") {
    const requirementEntries = new Map();
    const unmappedTags = [];
    for (const tag of route.tags || []) {
      const names = config?.securityByTag?.[tag];
      if (!names) {
        unmappedTags.push(tag);
        continue;
      }
      for (const name of names) {
        requirementEntries.set(name, []);
        usedSchemes.add(name);
      }
    }
    const requirement = Object.fromEntries(requirementEntries);
    return {
      security: requirementEntries.size ? [requirement] : undefined,
      unmappedTags,
    };
  }
  return { security: undefined, unmappedTags: [] };
}

function buildOperation(route, verb, opId, tag, isAudit, pathParams, openapi, usedSchemes) {
  const op = { operationId: opId, tags: [tag], responses: buildResponses(route.io) };
  const params = buildParameters(pathParams, route.io);
  if (params.length) op.parameters = params;
  const body = buildRequestBody(verb, route.io);
  if (body) op.requestBody = body;
  let unmappedAuthTags = [];
  if (isAudit) {
    const result = buildSecurity(route, openapi, usedSchemes);
    const { security } = result;
    unmappedAuthTags = result.unmappedTags;
    if (security !== undefined) op.security = security;
  }
  op["x-express-recon"] = {
    applicationId: route.applicationId ?? null,
    framework: route.framework || "express",
    source: route.source || null,
    authStatus: route.authStatus ?? null,
    authTags: route.tags || [],
    roles: route.roles || [],
    scopes: route.scopes || [],
    middlewares: route.middlewares.map((m) => m.name),
    middlewareStages: route.middlewares.map((m) => m.stage || null),
    pathConfidence: route.pathConfidence,
    handlerResolved: route.io ? route.io.handlerResolved : null,
    handlerName: route.io ? (route.io.handlerName ?? null) : null,
    handlerSource: route.io ? (route.io.handlerSource ?? null) : null,
    method: route.method,
    ...(unmappedAuthTags.length ? { unmappedAuthTags } : {}),
    ...(route.observations ? { observations: route.observations } : {}),
  };
  return op;
}

function compareRoutes(a, b) {
  if (a.path === b.path && a.method === b.method) {
    const af = a.source?.file || "";
    const bf = b.source?.file || "";
    if (af === bf) return (a.source?.line || 0) - (b.source?.line || 0);
    // Code-point ordering is stable across locales/CI hosts; localeCompare can
    // choose a different duplicate operation on different machines.
    return af < bf ? -1 : 1;
  }
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
function build(report) {
  const isAudit = report.command === "audit";
  const usedSchemes = new Set();
  const opIds = new Set();
  const paths = {};
  const duplicateOperations = [];

  for (const route of report.routes.slice().sort(compareRoutes)) {
    const { path: templated, params: pathParams } = toOpenApiPath(route.path);
    const tag = firstSegmentTag(templated);
    const verbs = route.method === "ALL" ? ALL_VERBS : [route.method.toLowerCase()];
    let item = Object.hasOwn(paths, templated) ? paths[templated] : null;
    if (!item) {
      item = {};
      Object.defineProperty(paths, templated, {
        value: item,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    for (const verb of verbs) {
      if (item[verb]) {
        duplicateOperations.push({
          keptApplicationId: item[verb]["x-express-recon"].applicationId,
          droppedApplicationId: route.applicationId ?? null,
          method: verb.toUpperCase(),
          path: templated,
          keptSource: item[verb]["x-express-recon"].source,
          droppedSource: route.source || null,
        });
        continue;
      }
      let opId = sanitizeOperationId(verb, templated);
      let n = 2;
      while (opIds.has(opId)) opId = `${sanitizeOperationId(verb, templated)}_${n++}`;
      opIds.add(opId);
      item[verb] = buildOperation(
        route,
        verb,
        opId,
        tag,
        isAudit,
        pathParams,
        report.openapi,
        usedSchemes,
      );
    }
  }

  const doc = { openapi: "3.1.0", info: buildInfo(report), paths };
  if (usedSchemes.size > 0) {
    doc.components = {
      securitySchemes: Object.fromEntries(
        [...usedSchemes].sort().map((name) => [name, report.openapi.securitySchemes[name]]),
      ),
    };
  }
  doc["x-express-recon"] = {
    generated: true,
    tool: "express-recon",
    schemaVersion: report.schemaVersion,
    command: report.command,
    mode: report.mode,
    frameworks: [
      ...new Set([
        ...(report.applications || []).map((application) => application.framework || "express"),
        ...report.routes.map((route) => route.framework || "express"),
      ]),
    ].sort(),
    schemasArePlaceholders: true,
    ...(duplicateOperations.length ? { duplicateOperations } : {}),
  };
  return doc;
}

function format(report) {
  return JSON.stringify(build(report), null, 2);
}

module.exports = { build, format };
