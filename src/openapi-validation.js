"use strict";

const AjvDraft4 = require("ajv-draft-04");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const { openapi: schemas } = require("@readme/openapi-schemas");

const MAX_ERRORS = 20;
const validators = new Map();

function structuralOpenApi31Schema(value) {
  if (Array.isArray(value)) return value.map(structuralOpenApi31Schema);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$dynamicRef" && child === "#meta") {
      // The published non-base OpenAPI 3.1 schema deliberately leaves Schema
      // Objects open to the document's selected JSON Schema dialect. Ajv would
      // otherwise resolve this dynamic anchor against the OpenAPI document
      // schema itself. Point it at the bundled permissive Schema Object slot so
      // the validator remains structural and never fetches a remote dialect.
      output.$ref = "#/$defs/schema";
    } else if (key !== "$dynamicAnchor") {
      output[key] = structuralOpenApi31Schema(child);
    }
  }
  return output;
}

function validator(schema, Validator) {
  const ajv = new Validator({ allErrors: true, strict: false, validateFormats: true });
  addFormats(ajv);
  // The official OpenAPI schemas use this format for content-map keys. Ajv's
  // format package intentionally does not define it, and structural validation
  // must not reject vendor media types merely because their grammar evolves.
  ajv.addFormat("media-range", true);
  return ajv.compile(schema);
}

function validatorFor(version) {
  const family = version.startsWith("3.0.") ? "3.0" : version.startsWith("3.1.") ? "3.1" : null;
  if (!family) {
    throw new Error(
      `OpenAPI version ${JSON.stringify(version)} is unsupported for validation; use 3.0.x or 3.1.x`,
    );
  }
  if (!validators.has(family)) {
    validators.set(
      family,
      family === "3.0"
        ? validator(schemas.v3, AjvDraft4)
        : validator(structuralOpenApi31Schema(schemas.v31), Ajv2020),
    );
  }
  return { family, validate: validators.get(family) };
}

function safeText(value, maximum = 300) {
  let printable = "";
  for (const character of String(value ?? "")) {
    const code = character.charCodeAt(0);
    printable += code <= 31 || code === 127 ? " " : character;
  }
  const text = printable.replace(/\s+/g, " ").trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function formatError(error) {
  const location = error.instancePath ? `#${error.instancePath}` : "#";
  const property = error.params?.additionalProperty;
  const detail = property === undefined ? "" : ` (${safeText(JSON.stringify(property), 120)})`;
  return `${location} ${safeText(error.message || error.keyword)}${detail}`;
}

const HTTP_VERBS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

function resolveLocalPointer(document, reference) {
  if (!document || typeof document !== "object" || !reference.startsWith("#/")) return undefined;
  let current = document;
  for (const encoded of reference.slice(2).split("/")) {
    let key;
    try {
      key = decodeURIComponent(encoded).replaceAll("~1", "/").replaceAll("~0", "~");
    } catch {
      return undefined;
    }
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Resolve a local Parameter Object reference for semantic template checks. External, broken, or
 * cyclic references remain structurally valid evidence whose contents are unknown offline.
 */
function resolveParameter(item, document, seen = new Set()) {
  if (!item || typeof item !== "object") return { parameter: null, unresolved: false };
  if (typeof item.$ref === "string") {
    if (seen.size >= 10 || seen.has(item.$ref)) {
      return { parameter: null, unresolved: true };
    }
    const nextSeen = new Set(seen);
    nextSeen.add(item.$ref);
    const target = resolveLocalPointer(document, item.$ref);
    if (!target) return { parameter: null, unresolved: true };
    return resolveParameter(target, document, nextSeen);
  }
  return { parameter: item, unresolved: false };
}

function validatePathTemplates(paths, label, document) {
  if (!paths || typeof paths !== "object" || Array.isArray(paths)) return;
  for (const pathKey of Object.keys(paths)) {
    if (pathKey.startsWith("x-")) continue;
    if (!pathKey.startsWith("/")) {
      throw new Error(`${label} path ${JSON.stringify(pathKey)} must start with '/'`);
    }
    let inBrace = false;
    let paramStart = -1;
    const pathParams = [];
    const pathParamSet = new Set();
    for (let i = 0; i < pathKey.length; i++) {
      const ch = pathKey[i];
      if (ch === "{") {
        if (inBrace) {
          throw new Error(
            `${label} path ${JSON.stringify(pathKey)} has nested or malformed parameter braces`,
          );
        }
        inBrace = true;
        paramStart = i + 1;
      } else if (ch === "}") {
        if (!inBrace) {
          throw new Error(
            `${label} path ${JSON.stringify(pathKey)} has unmatched closing brace '}'`,
          );
        }
        const paramName = pathKey.slice(paramStart, i);
        if (!paramName || !/^[A-Za-z0-9_.-]+$/.test(paramName)) {
          throw new Error(
            `${label} path ${JSON.stringify(pathKey)} contains invalid parameter name ${JSON.stringify(paramName)}`,
          );
        }
        if (pathParamSet.has(paramName)) {
          throw new Error(
            `${label} path ${JSON.stringify(pathKey)} contains duplicate parameter name ${JSON.stringify(paramName)}`,
          );
        }
        pathParams.push(paramName);
        pathParamSet.add(paramName);
        inBrace = false;
      }
    }
    if (inBrace) {
      throw new Error(`${label} path ${JSON.stringify(pathKey)} has unclosed parameter brace '{'`);
    }

    const pathItem = paths[pathKey];
    if (!pathItem || typeof pathItem !== "object" || Array.isArray(pathItem)) continue;

    const pathLevelParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    const pathLevelPathParams = new Set();
    let unresolvedPathLevelParameter = typeof pathItem.$ref === "string";
    for (const rawP of pathLevelParams) {
      const resolved = resolveParameter(rawP, document);
      unresolvedPathLevelParameter ||= resolved.unresolved;
      const p = resolved.parameter;
      if (p && typeof p === "object" && p.in === "path" && typeof p.name === "string") {
        pathLevelPathParams.add(p.name);
      }
    }

    let hasOperations = false;
    for (const verb of HTTP_VERBS) {
      const operation = pathItem[verb];
      if (!operation || typeof operation !== "object" || Array.isArray(operation)) continue;
      hasOperations = true;

      const opLevelParams = Array.isArray(operation.parameters) ? operation.parameters : [];
      const opPathParams = new Set(pathLevelPathParams);
      let unresolvedOperationParameter = unresolvedPathLevelParameter;
      for (const rawP of opLevelParams) {
        const resolved = resolveParameter(rawP, document);
        unresolvedOperationParameter ||= resolved.unresolved;
        const p = resolved.parameter;
        if (p && typeof p === "object" && p.in === "path" && typeof p.name === "string") {
          opPathParams.add(p.name);
        }
      }

      if (!unresolvedOperationParameter) {
        for (const param of pathParams) {
          if (!opPathParams.has(param)) {
            throw new Error(
              `${label} path ${JSON.stringify(pathKey)} operation ${verb.toUpperCase()} is missing required path parameter declaration for '{${param}}'`,
            );
          }
        }
      }

      for (const declared of opPathParams) {
        if (!pathParamSet.has(declared)) {
          throw new Error(
            `${label} path ${JSON.stringify(pathKey)} operation ${verb.toUpperCase()} declares path parameter '${declared}' which is not in the path template`,
          );
        }
      }
    }

    if (!hasOperations && pathParams.length > 0 && !unresolvedPathLevelParameter) {
      for (const param of pathParams) {
        if (!pathLevelPathParams.has(param)) {
          throw new Error(
            `${label} path ${JSON.stringify(pathKey)} is missing required path parameter declaration for '{${param}}'`,
          );
        }
      }
    }
  }
}

/**
 * Validate a complete OpenAPI 3.0/3.1 document against the official schema.
 * Validation is entirely local: schemas are bundled and no external `$ref`
 * resolver, network request, or target-code execution is used.
 */
function validateOpenApiDocument(document, label = "OpenAPI document") {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`${label} must contain an object`);
  }
  if (typeof document.openapi !== "string") {
    throw new Error(`${label} must declare an OpenAPI 3.0.x or 3.1.x version`);
  }
  validatePathTemplates(document.paths, label, document);
  const selected = validatorFor(document.openapi);
  if (selected.validate(document)) return { version: document.openapi, family: selected.family };
  const errors = (selected.validate.errors || []).slice(0, MAX_ERRORS).map(formatError);
  const omitted = Math.max(0, (selected.validate.errors || []).length - errors.length);
  throw new Error(
    `${label} failed OpenAPI ${selected.family} validation: ${errors.join("; ")}` +
      (omitted ? `; ${omitted} more error(s)` : ""),
  );
}

module.exports = { validateOpenApiDocument };
