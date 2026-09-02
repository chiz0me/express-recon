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
