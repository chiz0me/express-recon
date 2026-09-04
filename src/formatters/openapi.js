"use strict";

const PLACEHOLDER = "AI-unrefined placeholder — refine via handler code review";
const UNREFINED_NOTE =
  "Schemas and parameters combine explicit static validator/framework evidence with " +
  "AI-unrefined field-access placeholders; verify them against runtime behavior.";

// router.all() answers every verb; expand it across the concrete methods so the
// spec stays valid (OpenAPI has no "all" operation key).
const ALL_VERBS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];
const BODY_METHODS = new Set(["post", "put", "patch", "delete"]);
const MAX_PATH_VARIANTS = 128;
const MAX_OPTIONAL_GROUP_DEPTH = 32;

function parseIdentifierFrom(str, start) {
  let j = start;
  const len = str.length;
  while (j < len) {
    const ch = str[j];
    if (
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "_"
    ) {
      j++;
    } else {
      break;
    }
  }
  return str.slice(start, j);
}

function skipRegexAndModifierFrom(str, index) {
  let pos = index;
  const len = str.length;
  if (pos < len && str[pos] === "(") {
    let depth = 1;
    pos++;
    while (pos < len && depth > 0) {
      if (str[pos] === "\\") {
        pos += 2;
        continue;
      }
      if (str[pos] === "(") depth++;
      else if (str[pos] === ")") depth--;
      pos++;
    }
  }
  while (pos < len && (str[pos] === "?" || str[pos] === "*" || str[pos] === "+")) {
    pos++;
  }
  return pos;
}

/** Return the complete `:name(pattern)?` token at an unescaped colon, if present. */
function parameterTokenAt(str, index) {
  const ident = parseIdentifierFrom(str, index + 1);
  if (!ident) return null;
  let baseEnd = index + 1 + ident.length;
  if (str[baseEnd] === "(") {
    let depth = 1;
    baseEnd++;
    while (baseEnd < str.length && depth > 0) {
      if (str[baseEnd] === "\\") {
        baseEnd = Math.min(str.length, baseEnd + 2);
        continue;
      }
      if (str[baseEnd] === "(") depth++;
      else if (str[baseEnd] === ")") depth--;
      baseEnd++;
    }
  }
  let end = baseEnd;
  while (end < str.length && (str[end] === "?" || str[end] === "*" || str[end] === "+")) {
    end++;
  }
  const modifiers = str.slice(baseEnd, end);
  return {
    end,
    optional: modifiers.includes("?"),
    included: str.slice(index, baseEnd) + modifiers.replaceAll("?", ""),
  };
}

/** Locate a closing optional-group brace while respecting path-to-regexp escapes. */
function findMatchingBrace(str, startIndex) {
  let depth = 0;
  for (let i = startIndex; i < str.length; i++) {
    if (str[i] === "\\") {
      i++;
    } else if (str[i] === "{") {
      depth++;
    } else if (str[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Append text to the last token when possible so path tokenization remains linear in the input.
 */
function appendPathText(tokens, value) {
  if (!value) return;
  const previous = tokens.at(-1);
  if (previous?.kind === "text") previous.value += value;
  else tokens.push({ kind: "text", value });
}

/**
 * Parse Express optional groups and legacy `:name?` parameters without expanding them. Escaped
 * syntax stays intact for the later URL-template conversion. Nesting is deliberately bounded;
 * deeper groups are omitted and reported as truncated rather than risking call-stack exhaustion.
 */
function tokenizeOptionalPath(str, state, depth = 0) {
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === "\\" && i + 1 < str.length) {
      appendPathText(tokens, str.slice(i, i + 2));
      i += 2;
      continue;
    }

    if (str[i] === "{") {
      const close = findMatchingBrace(str, i);
      if (close === -1) {
        appendPathText(tokens, str[i++]);
        continue;
      }
      const inner = str.slice(i + 1, close);
      let nextIndex = close + 1;
      while (
        nextIndex < str.length &&
        (str[nextIndex] === "?" || str[nextIndex] === "*" || str[nextIndex] === "+")
      ) {
        nextIndex++;
      }
      if (depth >= MAX_OPTIONAL_GROUP_DEPTH) {
        state.truncated = true;
        state.depthLimited = true;
      } else {
        tokens.push({
          kind: "optional",
          tokens: tokenizeOptionalPath(inner, state, depth + 1),
        });
      }
      i = nextIndex;
      continue;
    }

    if (str[i] === ":") {
      const parameter = parameterTokenAt(str, i);
      if (parameter) {
        if (parameter.optional) {
          let prefix = "";
          const previous = tokens.at(-1);
          if (previous?.kind === "text" && /[/.]$/.test(previous.value)) {
            prefix = previous.value.slice(-1);
            previous.value = previous.value.slice(0, -1);
            if (!previous.value) tokens.pop();
          }
          tokens.push({
            kind: "optional",
            tokens: [{ kind: "text", value: prefix + parameter.included }],
          });
        } else {
          appendPathText(tokens, str.slice(i, parameter.end));
        }
        i = parameter.end;
        continue;
      }
    }

    appendPathText(tokens, str[i]);
    i++;
  }
  return tokens;
}

/** Return text that is present even when every remaining optional token is omitted. */
function requiredPathText(tokens, start) {
  let text = "";
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].kind === "text") text += tokens[i].value;
  }
  return text;
}

/** Combine token alternatives with a strict unique-variant ceiling. */
function expandPathTokens(tokens, state, limit) {
  let variants = [""];
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
    const token = tokens[tokenIndex];
    let alternatives;
    if (token.kind === "text") {
      alternatives = [token.value];
    } else {
      const included = expandPathTokens(token.tokens, state, limit);
      alternatives = ["", ...included];
    }

    const next = [];
    const seen = new Set();
    let full = false;
    for (const base of variants) {
      for (const suffix of alternatives) {
        const candidate = base + suffix;
        if (seen.has(candidate)) continue;
        if (next.length === limit) {
          state.truncated = true;
          full = true;
          break;
        }
        seen.add(candidate);
        next.push(candidate);
      }
      if (full) break;
    }
    if (full) {
      const requiredSuffix = requiredPathText(tokens, tokenIndex + 1);
      return requiredSuffix ? next.map((variant) => variant + requiredSuffix) : next;
    }
    variants = next;
  }
  return variants;
}

/**
 * Expand Express 5 groups (`{/:id}`) and Express 4 optional parameters (`:id?`) with a hard
 * ceiling. The detailed result lets callers disclose when not every concrete route fits.
 */
function expandPathVariants(exprPath, limit = MAX_PATH_VARIANTS) {
  const state = { truncated: false, depthLimited: false };
  const tokens = tokenizeOptionalPath(exprPath || "/", state);
  const variants = expandPathTokens(tokens, state, Math.max(1, limit));
  return { variants, truncated: state.truncated, depthLimited: state.depthLimited };
}

/**
 * Convert a single concrete framework path to an OpenAPI path template, returning the template
 * and its ordered, unique path-parameter names. `:name` → `{name}`, `*`/splats →
 * `{wildcard}`, and an unresolved `<dynamic>` segment → `{dynamic}`. Optional
 * groups and parameters have already been expanded by this point.
 */
function toOpenApiPathSingle(exprPath) {
  const used = new Set();
  const unique = (base) => {
    let name = base || "param";
    let i = 2;
    while (used.has(name)) name = `${base}${i++}`;
    used.add(name);
    return name;
  };

  const str = exprPath || "/";
  let result = "";
  let i = 0;
  const len = str.length;

  while (i < len) {
    if (str.startsWith("<dynamic>", i)) {
      result += `{${unique("dynamic")}}`;
      i += 9;
      continue;
    }

    const ch = str[i];

    if (ch === "\\") {
      const literal = str[i + 1];
      if (literal === undefined) {
        result += "%5C";
        i++;
        continue;
      }
      if (literal === "{") result += "%7B";
      else if (literal === "}") result += "%7D";
      else if (literal === "?") result += "%3F";
      else if (literal === "#") result += "%23";
      else if (literal === "\\") result += "%5C";
      else result += literal;
      i += 2;
      continue;
    }

    if (ch === "{") {
      const close = findMatchingBrace(str, i);
      if (close === -1) {
        result += ch;
        i++;
        continue;
      }

      const inner = str.slice(i + 1, close);
      let nextIndex = close + 1;
      while (
        nextIndex < len &&
        (str[nextIndex] === "?" || str[nextIndex] === "*" || str[nextIndex] === "+")
      ) {
        nextIndex++;
      }

      if (inner.startsWith("*")) {
        // Express 5 wildcard/splat parameter: {*splat}
        let rawName = inner.slice(1);
        const paren = rawName.indexOf("(");
        if (paren !== -1) rawName = rawName.slice(0, paren);
        while (rawName.endsWith("?") || rawName.endsWith("*") || rawName.endsWith("+")) {
          rawName = rawName.slice(0, -1);
        }
        const paramName = unique(rawName || "wildcard");
        result += `{${paramName}}`;
      } else if (inner.includes(":") || inner.includes("*")) {
        // Group containing parameters: e.g. {.:ext}, {/:left-:right}
        let k = 0;
        while (k < inner.length) {
          if (inner[k] === ":") {
            const ident = parseIdentifierFrom(inner, k + 1);
            let endPos = k + 1 + ident.length;
            endPos = skipRegexAndModifierFrom(inner, endPos);
            const paramName = unique(ident || "param");
            result += `{${paramName}}`;
            k = endPos;
          } else if (inner[k] === "*") {
            const ident = parseIdentifierFrom(inner, k + 1);
            let endPos = k + 1 + ident.length;
            endPos = skipRegexAndModifierFrom(inner, endPos);
            const paramName = unique(ident || "wildcard");
            result += `{${paramName}}`;
            k = endPos;
          } else {
            result += inner[k];
            k++;
          }
        }
      } else if (/^[A-Za-z0-9_]+$/.test(inner)) {
        // Standard path parameter: {id}
        result += `{${unique(inner)}}`;
      } else {
        // Literal group without parameters: e.g. {.json}
        result += inner;
      }

      i = nextIndex;
      continue;
    }

    if (ch === ":") {
      const ident = parseIdentifierFrom(str, i + 1);
      if (ident.length > 0) {
        let endPos = i + 1 + ident.length;
        endPos = skipRegexAndModifierFrom(str, endPos);
        result += `{${unique(ident)}}`;
        i = endPos;
        continue;
      }
    }

    if (ch === "*") {
      const ident = parseIdentifierFrom(str, i + 1);
      let endPos = i + 1 + ident.length;
      endPos = skipRegexAndModifierFrom(str, endPos);
      result += `{${unique(ident || "wildcard")}}`;
      i = endPos;
      continue;
    }

    result += ch;
    i++;
  }

  result = result.replace(/\/+/g, "/");
  if (result.length > 1 && result.endsWith("/")) {
    result = result.slice(0, -1);
  }
  if (!result.startsWith("/")) result = `/${result}`;

  return { path: result, params: [...used] };
}

/** Convert a framework path and retain bounded-expansion completeness metadata. */
function toOpenApiPathsDetailed(exprPath) {
  const expanded = expandPathVariants(exprPath || "/");
  const seen = new Set();
  const variants = [];
  for (const raw of expanded.variants) {
    const single = toOpenApiPathSingle(raw);
    if (!seen.has(single.path)) {
      seen.add(single.path);
      variants.push(single);
    }
  }
  return {
    variants: variants.length > 0 ? variants : [{ path: "/", params: [] }],
    truncated: expanded.truncated,
    depthLimited: expanded.depthLimited,
  };
}

/** Convert a framework route into its bounded set of concrete OpenAPI templates. */
function toOpenApiPaths(exprPath) {
  return toOpenApiPathsDetailed(exprPath).variants;
}

function toOpenApiPath(exprPath) {
  return toOpenApiPaths(exprPath)[0];
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

function requestContract(io, bucket) {
  const value = io?.schemas?.request?.[bucket] || null;
  if (!value || contractConfidence(value) !== "low" || !io?.request?.[bucket]?.length) return value;
  const properties = Object.fromEntries(Object.entries(objectProperties(value)));
  for (const name of io.request[bucket]) {
    if (!Object.hasOwn(properties, name)) {
      Object.defineProperty(properties, name, {
        value: {},
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return { ...value, schema: { ...value.schema, type: "object", properties } };
}

function responseContract(io, status) {
  return io?.schemas?.responses?.find((item) => item.status === status)?.contract || null;
}

function contractConfidence(value) {
  const ranks = { low: 1, medium: 2, high: 3 };
  return (value?.evidence || []).reduce(
    (best, item) => (ranks[item.confidence] > ranks[best] ? item.confidence : best),
    "low",
  );
}

function contractSchema(value) {
  if (!value) return null;
  const schema = structuredClone(value.schema);
  if (contractConfidence(value) !== "high") schema["x-express-recon-unrefined"] = true;
  return schema;
}

function objectProperties(value) {
  return value?.schema?.type === "object" && value.schema.properties ? value.schema.properties : {};
}

function objectRequired(value) {
  return new Set(Array.isArray(value?.schema?.required) ? value.schema.required : []);
}

function parameterDescription(value) {
  if (typeof value?.schema?.description === "string" && value.schema.description.trim()) {
    return value.schema.description;
  }
  return value && contractConfidence(value) === "high"
    ? "Derived from static validator or framework schema evidence; verify runtime transforms."
    : PLACEHOLDER;
}

function buildParameters(pathParams, io) {
  const pathSchema = requestContract(io, "params");
  const pathProperties = objectProperties(pathSchema);
  const params = pathParams.map((name) => {
    const value = Object.hasOwn(pathProperties, name)
      ? { ...pathSchema, schema: pathProperties[name] }
      : null;
    return {
      name,
      in: "path",
      required: true,
      schema: value ? contractSchema(value) : { type: "string" },
      description: parameterDescription(value),
    };
  });
  if (io?.request) {
    for (const [bucket, location, fallback] of [
      ["query", "query", {}],
      ["headers", "header", { type: "string" }],
    ]) {
      const value = requestContract(io, bucket);
      const properties = objectProperties(value);
      const required = objectRequired(value);
      const names = [
        ...new Set([...(io.request[bucket] || []), ...Object.keys(properties)]),
      ].sort();
      for (const name of names) {
        const property = Object.hasOwn(properties, name)
          ? { ...value, schema: properties[name] }
          : null;
        params.push({
          name,
          in: location,
          required: required.has(name),
          schema: property ? contractSchema(property) : fallback,
          description: parameterDescription(property),
        });
      }
    }
  }
  return params;
}

function buildRequestBody(verb, io) {
  const value = requestContract(io, "body");
  if (!BODY_METHODS.has(verb) || !io?.request || (!value && (io.request.body || []).length === 0)) {
    return null;
  }
  return {
    required: Boolean(value?.schema?.required?.length),
    content: {
      "application/json": {
        schema: value ? contractSchema(value) : placeholderObjectSchema(io.request.body || []),
      },
    },
  };
}

function buildResponses(io) {
  const responses = {};
  if (io) {
    for (const r of io.responses || []) {
      if (r.status == null) continue;
      const value = responseContract(io, r.status);
      const resp = { description: parameterDescription(value) };
      if (value) resp.content = { "application/json": { schema: contractSchema(value) } };
      else if (r.bodyKeys && r.bodyKeys.length) {
        resp.content = { "application/json": { schema: placeholderObjectSchema(r.bodyKeys) } };
      }
      responses[String(r.status)] = resp;
    }
    for (const code of io.statusCodes || []) {
      if (responses[String(code)]) continue;
      const value = responseContract(io, code);
      responses[String(code)] = {
        description: parameterDescription(value),
        ...(value ? { content: { "application/json": { schema: contractSchema(value) } } } : {}),
      };
    }
  }
  const defaultValue = responseContract(io, null);
  responses.default = defaultValue
    ? {
        description: parameterDescription(defaultValue),
        content: { "application/json": { schema: contractSchema(defaultValue) } },
      }
    : { description: "AI-unrefined default response" };
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
  if (route.io?.documentation?.summary) op.summary = route.io.documentation.summary;
  if (route.io?.documentation?.description) {
    op.description = route.io.documentation.description;
  }
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
    ...(route.io?.schemas
      ? {
          schemaEvidence: [
            ...Object.entries(route.io.schemas.request || {}).map(([location, value]) => ({
              location: `request.${location}`,
              evidence: value.evidence,
            })),
            ...(route.io.schemas.responses || []).map((value) => ({
              location: `response.${value.status ?? "default"}`,
              evidence: value.contract.evidence,
            })),
          ],
          ...(route.io.schemas.conflicts?.length
            ? { schemaConflicts: route.io.schemas.conflicts }
            : {}),
        }
      : {}),
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
  const pathVariantTruncations = [];

  for (const route of report.routes.slice().sort(compareRoutes)) {
    const expanded = toOpenApiPathsDetailed(route.path);
    const variants = expanded.variants;
    if (expanded.truncated) {
      const routePath = String(route.path || "/");
      pathVariantTruncations.push({
        applicationId: route.applicationId ?? null,
        method: route.method,
        path: routePath.length > 500 ? `${routePath.slice(0, 499)}…` : routePath,
        source: route.source || null,
        maxVariants: MAX_PATH_VARIANTS,
        reason: expanded.depthLimited ? "optional-group-depth-limit" : "variant-limit",
      });
    }
    for (const { path: templated, params: pathParams } of variants) {
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
    structuredSchemaEvidence: report.routes.some((route) => Boolean(route.io?.schemas)),
    ...(duplicateOperations.length ? { duplicateOperations } : {}),
    ...(pathVariantTruncations.length ? { pathVariantTruncations } : {}),
  };
  return doc;
}

function format(report) {
  return JSON.stringify(build(report), null, 2);
}

module.exports = { build, format, toOpenApiPath, toOpenApiPaths };
