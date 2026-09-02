"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pkg = require("../package.json");
const { compareReports } = require("./compare");
const { describeRenderableSpecification } = require("./docs");
const { renderHtmlSite } = require("./html");
const { compareOpenApiDocuments } = require("./openapi-compare");
const { validateOpenApiDocument } = require("./openapi-validation");

const REFRESH_MANIFEST = "refresh-manifest.json";
const ENRICHMENT_FILE = "openapi.enrichment.json";
const GENERATED_FILE = "openapi.generated.json";
const OPENAPI_BASELINE_FILE = "openapi.baseline.json";
const OPENAPI_DELTA_FILE = "openapi-delta.json";
const OPENAPI_FILE = "openapi.json";
const ROUTES_FILE = "routes.json";
const DISCOVERY_FILE = "discovery.json";
const DOCS_REPORT_FILE = "docs-report.json";
const REFRESH_REPORT_FILE = "refresh-report.json";
const API_REFERENCE_DIRECTORY = "api-reference";
const STATE_SCHEMA_VERSION = "1.0";
const ENRICHMENT_SCHEMA_VERSION = "1.0";
const MAX_STATE_JSON_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_FINGERPRINT_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_FINGERPRINT_SOURCES = 500;
const MAX_SCHEMA_DEPENDENCIES = 5_000;
const MAX_SCOPE_PATTERNS = 100;
const MAX_OWNED_FILES = 100_000;
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const ENRICHABLE_OPERATION_FIELDS = [
  "summary",
  "description",
  "parameters",
  "requestBody",
  "responses",
];
const ENRICHABLE_OPERATION_FIELD_SET = new Set(ENRICHABLE_OPERATION_FIELDS);
const MISSING_SCHEMA_FINGERPRINT = "<missing-schema>";
const CORE_STATE_FILES = [
  ROUTES_FILE,
  DISCOVERY_FILE,
  GENERATED_FILE,
  ENRICHMENT_FILE,
  OPENAPI_BASELINE_FILE,
  OPENAPI_FILE,
  OPENAPI_DELTA_FILE,
  DOCS_REPORT_FILE,
  REFRESH_REPORT_FILE,
];

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

function hash(value) {
  const input =
    typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value));
  return `sha256:${crypto.createHash("sha256").update(input).digest("hex")}`;
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function within(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function safeRelative(reference) {
  return (
    typeof reference === "string" &&
    reference.length > 0 &&
    reference.length <= 500 &&
    !hasControlCharacters(reference) &&
    !path.posix.isAbsolute(reference) &&
    !reference.includes("\\") &&
    reference.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

function hasControlCharacters(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function validScopePatterns(values) {
  return (
    Array.isArray(values) &&
    values.length <= MAX_SCOPE_PATTERNS &&
    values.every(
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 500 &&
        !hasControlCharacters(value),
    )
  );
}

function normalizedInvocation(invocation = {}) {
  if (!isObject(invocation)) throw new Error("Refresh invocation metadata must be an object");
  if (
    (invocation.include !== undefined && !Array.isArray(invocation.include)) ||
    (invocation.exclude !== undefined && !Array.isArray(invocation.exclude)) ||
    (invocation.externalConfig !== undefined && typeof invocation.externalConfig !== "boolean") ||
    (invocation.externalIgnoreFile !== undefined &&
      typeof invocation.externalIgnoreFile !== "boolean") ||
    (invocation.includeTests !== undefined && typeof invocation.includeTests !== "boolean") ||
    (invocation.includeHidden !== undefined && typeof invocation.includeHidden !== "boolean") ||
    (invocation.render !== undefined && typeof invocation.render !== "boolean")
  ) {
    throw new Error("Refresh invocation metadata contains invalid field types");
  }
  const output = {
    config: invocation.config ?? null,
    externalConfig: invocation.externalConfig === true,
    include: [...(invocation.include || [])],
    exclude: [...(invocation.exclude || [])],
    ignoreFile: invocation.ignoreFile ?? null,
    externalIgnoreFile: invocation.externalIgnoreFile === true,
    includeTests: invocation.includeTests === true,
    includeHidden: invocation.includeHidden === true,
    render: invocation.render !== false,
  };
  if (!validInvocation(output)) {
    throw new Error("Refresh invocation metadata contains unsafe paths or scope patterns");
  }
  return output;
}

function validInvocation(invocation) {
  return (
    isObject(invocation) &&
    validScopePatterns(invocation.include) &&
    validScopePatterns(invocation.exclude) &&
    typeof invocation.includeTests === "boolean" &&
    typeof invocation.includeHidden === "boolean" &&
    typeof invocation.render === "boolean" &&
    ([null, false].includes(invocation.ignoreFile) || safeRelative(invocation.ignoreFile)) &&
    (invocation.config === null || safeRelative(invocation.config)) &&
    typeof invocation.externalConfig === "boolean" &&
    typeof invocation.externalIgnoreFile === "boolean" &&
    (!invocation.externalConfig || invocation.config === null) &&
    (!invocation.externalIgnoreFile || invocation.ignoreFile === null)
  );
}

function define(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function readBoundedJson(file, maximum = MAX_STATE_JSON_BYTES) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    throw new Error(`Could not read refresh state ${file}: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Refresh state artifact must be a regular file: ${file}`);
  }
  if (stat.size <= 0 || stat.size > maximum) {
    throw new Error(`Refresh state artifact must be between 1 and ${maximum} bytes: ${file}`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse refresh state ${file}: ${error.message}`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function operationEntries(document) {
  const entries = [];
  for (const pathName of Object.keys(object(document?.paths)).sort()) {
    const pathItem = object(document.paths[pathName]);
    for (const method of Object.keys(pathItem).sort()) {
      const normalizedMethod = method.toLowerCase();
      if (!HTTP_METHODS.has(normalizedMethod) || !isObject(pathItem[method])) continue;
      entries.push({
        key: `${normalizedMethod.toUpperCase()} ${pathName}`,
        method: normalizedMethod,
        path: pathName,
        operation: pathItem[method],
      });
    }
  }
  return entries;
}

function sourceFingerprint(root, reference) {
  const file = reference?.file;
  if (typeof file !== "string" || !file || path.isAbsolute(file)) {
    return { file: typeof file === "string" ? file : null, status: "unavailable" };
  }
  const candidate = path.resolve(root, file);
  if (!within(root, candidate)) return { file, status: "outside-root" };
  try {
    const realRoot = fs.realpathSync(root);
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) return { file, status: "not-regular" };
    const realFile = fs.realpathSync(candidate);
    if (!within(realRoot, realFile)) return { file, status: "outside-root" };
    if (stat.size > MAX_FINGERPRINT_SOURCE_BYTES) {
      return { file, status: "too-large", bytes: stat.size };
    }
    return { file, status: "hashed", sha256: hash(fs.readFileSync(realFile)) };
  } catch (error) {
    return { file, status: error.code === "ENOENT" ? "missing" : "unreadable" };
  }
}

function collectFileReferences(value, references = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectFileReferences(item, references);
    return references;
  }
  if (!value || typeof value !== "object") return references;
  if (typeof value.file === "string" && value.file) references.add(value.file);
  for (const child of Object.values(value)) collectFileReferences(child, references);
  return references;
}

function operationFingerprint(root, operation) {
  const copy = clone(operation);
  const metadata = object(copy["x-express-recon"]);
  delete metadata.enrichmentFingerprint;
  delete metadata.enrichmentSources;
  const sourceReferences = [...collectFileReferences(metadata)].sort();
  if (sourceReferences.length > MAX_FINGERPRINT_SOURCES) {
    throw new Error(
      `OpenAPI operation evidence references more than ${MAX_FINGERPRINT_SOURCES} source files`,
    );
  }
  return hash({
    operation: copy,
    sources: sourceReferences.map((file) => sourceFingerprint(root, { file })),
  });
}

function addOperationFingerprints(document, root) {
  const output = clone(document);
  for (const entry of operationEntries(output)) {
    const metadata = object(entry.operation["x-express-recon"]);
    if (entry.operation["x-express-recon"] !== metadata) {
      define(entry.operation, "x-express-recon", metadata);
    }
    metadata.enrichmentFingerprint = operationFingerprint(root, entry.operation);
  }
  return output;
}

function schemaFingerprint(value) {
  return hash(value === undefined ? MISSING_SCHEMA_FINGERPRINT : value);
}

function emptyEnrichment(applicationId) {
  return {
    schemaVersion: ENRICHMENT_SCHEMA_VERSION,
    kind: "express-recon-openapi-enrichment",
    tool: "express-recon",
    applicationId: applicationId ?? null,
    operations: [],
    schemas: [],
  };
}

function validateEnrichment(enrichment, applicationId) {
  if (
    !enrichment ||
    enrichment.schemaVersion !== ENRICHMENT_SCHEMA_VERSION ||
    enrichment.kind !== "express-recon-openapi-enrichment" ||
    enrichment.tool !== "express-recon" ||
    !Array.isArray(enrichment.operations) ||
    !Array.isArray(enrichment.schemas)
  ) {
    throw new Error("openapi.enrichment.json has an incompatible contract");
  }
  if ((enrichment.applicationId ?? null) !== (applicationId ?? null)) {
    throw new Error("openapi.enrichment.json belongs to a different application selection");
  }
  const operations = new Set();
  for (const entry of enrichment.operations) {
    if (
      !entry ||
      typeof entry.operation !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(entry.evidenceFingerprint) ||
      !entry.fields ||
      typeof entry.fields !== "object" ||
      Array.isArray(entry.fields) ||
      (entry.remove !== undefined && !Array.isArray(entry.remove))
    ) {
      throw new Error("openapi.enrichment.json contains an invalid operation entry");
    }
    if (operations.has(entry.operation)) {
      throw new Error(`openapi.enrichment.json repeats operation ${entry.operation}`);
    }
    operations.add(entry.operation);
    for (const field of Object.keys(entry.fields)) {
      if (!ENRICHABLE_OPERATION_FIELD_SET.has(field)) {
        throw new Error(`openapi.enrichment.json cannot own operation field ${field}`);
      }
    }
    for (const field of entry.remove || []) {
      if (!ENRICHABLE_OPERATION_FIELD_SET.has(field)) {
        throw new Error(`openapi.enrichment.json cannot remove operation field ${field}`);
      }
    }
    if (entry.reviewedSources !== undefined) {
      if (!Array.isArray(entry.reviewedSources) || entry.reviewedSources.length > 50) {
        throw new Error("openapi.enrichment.json contains invalid reviewedSources");
      }
      const reviewed = new Set();
      for (const source of entry.reviewedSources) {
        if (
          !source ||
          !safeRelative(source.file) ||
          !/^sha256:[a-f0-9]{64}$/.test(source.sha256) ||
          reviewed.has(source.file)
        ) {
          throw new Error("openapi.enrichment.json contains an invalid reviewed source");
        }
        reviewed.add(source.file);
      }
    }
  }
  const schemas = new Set();
  for (const entry of enrichment.schemas) {
    if (
      !entry ||
      typeof entry.name !== "string" ||
      !entry.name ||
      entry.name.length > 300 ||
      !/^sha256:[a-f0-9]{64}$/.test(entry.evidenceFingerprint) ||
      !Array.isArray(entry.dependencies) ||
      entry.dependencies.length > MAX_SCHEMA_DEPENDENCIES ||
      entry.value === undefined
    ) {
      throw new Error("openapi.enrichment.json contains an invalid schema entry");
    }
    if (schemas.has(entry.name)) {
      throw new Error(`openapi.enrichment.json repeats schema ${entry.name}`);
    }
    schemas.add(entry.name);
    const dependencies = new Set();
    for (const dependency of entry.dependencies) {
      if (
        !dependency ||
        typeof dependency.operation !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(dependency.evidenceFingerprint) ||
        dependencies.has(dependency.operation) ||
        (dependency.reviewedSources !== undefined &&
          (!Array.isArray(dependency.reviewedSources) || dependency.reviewedSources.length > 50))
      ) {
        throw new Error("openapi.enrichment.json contains an invalid schema dependency");
      }
      dependencies.add(dependency.operation);
      const reviewed = new Set();
      for (const source of dependency.reviewedSources || []) {
        if (
          !source ||
          !safeRelative(source.file) ||
          !/^sha256:[a-f0-9]{64}$/.test(source.sha256) ||
          reviewed.has(source.file)
        ) {
          throw new Error("openapi.enrichment.json contains an invalid schema dependency source");
        }
        reviewed.add(source.file);
      }
    }
  }
  return enrichment;
}

function stripEnrichableFields(document) {
  const output = clone(document);
  for (const { operation } of operationEntries(output)) {
    for (const field of ENRICHABLE_OPERATION_FIELDS) delete operation[field];
    delete object(operation["x-express-recon"]).enrichmentSources;
  }
  if (object(output.components).schemas !== undefined) {
    delete output.components.schemas;
    if (Object.keys(output.components).length === 0) delete output.components;
  }
  const metadata = object(output["x-express-recon"]);
  delete metadata.enrichment;
  delete metadata.schemasArePlaceholders;
  if (Object.keys(metadata).length === 0) delete output["x-express-recon"];
  return output;
}

function captureReviewedSources(root, operation) {
  const values = object(operation["x-express-recon"]).enrichmentSources;
  if (values === undefined) return [];
  if (
    !Array.isArray(values) ||
    values.length > 50 ||
    values.some((value) => typeof value !== "string" || !safeRelative(value))
  ) {
    throw new Error("x-express-recon.enrichmentSources must contain up to 50 relative file paths");
  }
  const unique = [...new Set(values)].sort();
  if (unique.length !== values.length) {
    throw new Error("x-express-recon.enrichmentSources must not contain duplicates");
  }
  return unique.map((file) => {
    const evidence = sourceFingerprint(root, { file });
    if (evidence.status !== "hashed") {
      throw new Error(`Could not fingerprint enrichment source ${file}: ${evidence.status}`);
    }
    return { file, sha256: evidence.sha256 };
  });
}

function normalizedOperationSelectors(values, option) {
  const output = new Set();
  for (const value of values || []) {
    const match = /^([A-Za-z]+)\s+(\/\S*)$/.exec(String(value).trim());
    const method = match?.[1].toLowerCase();
    if (!match || !HTTP_METHODS.has(method)) {
      throw new Error(`${option} must use "METHOD /path" with an OpenAPI HTTP method`);
    }
    const key = `${method.toUpperCase()} ${match[2]}`;
    if (output.has(key)) throw new Error(`${option} repeats ${key}`);
    output.add(key);
  }
  return output;
}

function normalizedSchemaSelectors(values, option) {
  const output = new Set();
  for (const value of values || []) {
    const name = String(value).trim();
    if (!name || name.length > 300 || hasControlCharacters(name)) {
      throw new Error(`${option} requires a schema name of at most 300 characters`);
    }
    if (output.has(name)) throw new Error(`${option} repeats ${name}`);
    output.add(name);
  }
  return output;
}

function captureOperationEnrichment(root, base, edited, existing, options = {}) {
  const prior = new Map(existing.operations.map((entry) => [entry.operation, entry]));
  const baseOperations = new Map(operationEntries(base).map((entry) => [entry.key, entry]));
  const editedOperations = new Map(operationEntries(edited).map((entry) => [entry.key, entry]));
  const reviews = normalizedOperationSelectors(options.reviewOperations, "--review-operation");
  const clears = normalizedOperationSelectors(options.clearOperations, "--clear-operation");
  const captured = [];
  const retained = [];
  const removed = [];
  const markedReviewed = [];

  for (const key of reviews) {
    if (!baseOperations.has(key)) {
      throw new Error(`--review-operation does not match a current operation: ${key}`);
    }
    if (clears.has(key)) {
      throw new Error(`Operation ${key} cannot be both reviewed and cleared`);
    }
  }
  for (const key of clears) {
    if (!prior.has(key)) throw new Error(`--clear-operation has no saved enrichment: ${key}`);
  }

  for (const [key, entry] of baseOperations) {
    const editedEntry = editedOperations.get(key);
    if (clears.has(key)) {
      prior.delete(key);
      removed.push(key);
      continue;
    }
    const fingerprint = entry.operation["x-express-recon"]?.enrichmentFingerprint;
    const reviewedSources = captureReviewedSources(root, editedEntry.operation);
    const fields = {};
    const remove = [];
    for (const field of ENRICHABLE_OPERATION_FIELDS) {
      const hasBase = Object.hasOwn(entry.operation, field);
      const hasEdited = Object.hasOwn(editedEntry.operation, field);
      if (hasEdited && (!hasBase || !same(entry.operation[field], editedEntry.operation[field]))) {
        define(fields, field, clone(editedEntry.operation[field]));
      } else if (hasBase && !hasEdited) remove.push(field);
    }
    if (Object.keys(fields).length || remove.length || reviewedSources.length || reviews.has(key)) {
      captured.push({
        operation: key,
        evidenceFingerprint: fingerprint,
        fields,
        ...(remove.length ? { remove } : {}),
        ...(reviewedSources.length ? { reviewedSources } : {}),
      });
      if (reviews.has(key)) markedReviewed.push(key);
      prior.delete(key);
      continue;
    }
    const previous = prior.get(key);
    if (previous?.evidenceFingerprint === fingerprint) {
      removed.push(key);
      prior.delete(key);
    }
  }
  for (const key of clears) prior.delete(key);
  retained.push(...prior.values());
  return {
    entries: [...captured, ...retained].sort((left, right) =>
      left.operation.localeCompare(right.operation),
    ),
    summary: {
      captured: captured.length,
      markedReviewed: markedReviewed.length,
      retainedStaleOrRemoved: retained.length,
      cleared: removed.length,
    },
  };
}

function schemaDependencies(root, document) {
  const schemas = object(object(document.components).schemas);
  const schemaReferences = new Map(
    Object.entries(schemas).map(([name, value]) => [name, collectSchemaReferences(value)]),
  );
  const dependents = new Map();
  for (const entry of operationEntries(document)) {
    const references = collectSchemaReferences(entry.operation);
    let previousSize = -1;
    while (references.size !== previousSize) {
      previousSize = references.size;
      for (const name of references) {
        for (const nested of schemaReferences.get(name) || []) references.add(nested);
      }
    }
    const dependency = {
      operation: entry.key,
      evidenceFingerprint: entry.operation["x-express-recon"]?.enrichmentFingerprint,
      ...(object(entry.operation["x-express-recon"]).enrichmentSources
        ? { reviewedSources: captureReviewedSources(root, entry.operation) }
        : {}),
    };
    for (const name of references) {
      const values = dependents.get(name) || [];
      values.push(dependency);
      dependents.set(name, values);
    }
  }
  for (const values of dependents.values()) {
    values.sort((left, right) => left.operation.localeCompare(right.operation));
  }
  return dependents;
}

function captureSchemaEnrichment(root, base, edited, existing, previousApplication, options = {}) {
  const prior = new Map(existing.schemas.map((entry) => [entry.name, entry]));
  const baseSchemas = object(object(base.components).schemas);
  const editedSchemas = object(object(edited.components).schemas);
  const dependencies = schemaDependencies(root, edited);
  const previouslyApplied = new Set(previousApplication.report.appliedSchemas);
  const clears = normalizedSchemaSelectors(options.clearSchemas, "--clear-schema");
  const captured = [];
  const retained = [];
  const removed = [];

  for (const name of clears) {
    if (!prior.has(name)) throw new Error(`--clear-schema has no saved enrichment: ${name}`);
  }

  for (const name of Object.keys(baseSchemas)) {
    if (!Object.hasOwn(editedSchemas, name)) {
      throw new Error(`--accept-enrichment cannot remove the existing component schema ${name}`);
    }
  }
  for (const name of [
    ...new Set([...Object.keys(baseSchemas), ...Object.keys(editedSchemas), ...prior.keys()]),
  ].sort()) {
    if (clears.has(name)) {
      prior.delete(name);
      removed.push(name);
      continue;
    }
    const baseValue = Object.hasOwn(baseSchemas, name) ? baseSchemas[name] : undefined;
    const fingerprint = schemaFingerprint(baseValue);
    if (!same(baseValue, editedSchemas[name])) {
      captured.push({
        name,
        evidenceFingerprint: fingerprint,
        dependencies: dependencies.get(name) || [],
        value: clone(editedSchemas[name]),
      });
      prior.delete(name);
      continue;
    }
    const previous = prior.get(name);
    if (previous?.evidenceFingerprint === fingerprint && previouslyApplied.has(name)) {
      removed.push(name);
      prior.delete(name);
    }
  }
  retained.push(...prior.values());
  return {
    entries: [...captured, ...retained].sort((left, right) => left.name.localeCompare(right.name)),
    summary: {
      captured: captured.length,
      retainedStale: retained.length,
      cleared: removed.length,
    },
  };
}

function captureEnrichment(root, base, edited, existing, applicationId, options = {}) {
  validateSpecification(edited, "edited openapi.json");
  const baseKeys = operationEntries(base).map((entry) => entry.key);
  const editedKeys = operationEntries(edited).map((entry) => entry.key);
  if (
    !same(baseKeys, editedKeys) ||
    !same(stripEnrichableFields(base), stripEnrichableFields(edited))
  ) {
    throw new Error(
      "--accept-enrichment found edits outside summary, description, parameters, requestBody, responses, or components.schemas; restore scanner-owned paths, methods, security, tags, operationId, and x-express-recon fields",
    );
  }
  const operations = captureOperationEnrichment(root, base, edited, existing, options);
  const previousApplication = applyEnrichment(root, base, existing);
  const schemas = captureSchemaEnrichment(
    root,
    base,
    edited,
    existing,
    previousApplication,
    options,
  );
  return {
    enrichment: validateEnrichment(
      {
        ...emptyEnrichment(applicationId),
        operations: operations.entries,
        schemas: schemas.entries,
      },
      applicationId,
    ),
    summary: { operations: operations.summary, schemas: schemas.summary },
  };
}

function containsUnrefined(value) {
  if (Array.isArray(value)) return value.some(containsUnrefined);
  if (!value || typeof value !== "object") return false;
  if (value["x-express-recon-unrefined"] === true) return true;
  return Object.values(value).some(containsUnrefined);
}

function reviewedSourcesMatch(root, entry) {
  return (entry.reviewedSources || []).every((source) => {
    const current = sourceFingerprint(root, { file: source.file });
    return current.status === "hashed" && current.sha256 === source.sha256;
  });
}

function collectSchemaReferences(value, references = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaReferences(item, references);
    return references;
  }
  if (!value || typeof value !== "object") return references;
  if (typeof value.$ref === "string" && value.$ref.startsWith("#/components/schemas/")) {
    const encoded = value.$ref.slice("#/components/schemas/".length).split("/", 1)[0];
    let decoded = encoded;
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      // Invalid percent escapes are rejected later by local-reference validation.
    }
    references.add(decoded.replaceAll("~1", "/").replaceAll("~0", "~"));
  }
  for (const child of Object.values(value)) collectSchemaReferences(child, references);
  return references;
}

function applyOperationEntry(operation, entry) {
  for (const field of entry.remove || []) delete operation[field];
  for (const [field, value] of Object.entries(entry.fields)) define(operation, field, clone(value));
  if (entry.reviewedSources?.length) {
    object(operation["x-express-recon"]).enrichmentSources = entry.reviewedSources.map(
      (source) => source.file,
    );
  }
}

function dependentOperations(document) {
  const schemas = object(object(document.components).schemas);
  const schemaReferences = new Map(
    Object.entries(schemas).map(([name, value]) => [name, collectSchemaReferences(value)]),
  );
  const output = new Map();
  for (const entry of operationEntries(document)) {
    const references = collectSchemaReferences(entry.operation);
    let previousSize = -1;
    while (references.size !== previousSize) {
      previousSize = references.size;
      for (const name of references) {
        for (const nested of schemaReferences.get(name) || []) references.add(nested);
      }
    }
    for (const name of references) {
      const operations = output.get(name) || new Set();
      operations.add(entry.key);
      output.set(name, operations);
    }
  }
  return output;
}

function operationCompatibility(root, operation, entry) {
  if (operation["x-express-recon"]?.enrichmentFingerprint !== entry.evidenceFingerprint) {
    return "operation-evidence-changed";
  }
  if (!reviewedSourcesMatch(root, entry)) return "reviewed-source-changed";
  return null;
}

function schemaCompatibility(root, entry, current, currentDependents) {
  const expected = entry.dependencies.map((dependency) => dependency.operation).sort();
  const actual = [...(currentDependents.get(entry.name) || [])].sort();
  if (!same(expected, actual)) return "dependent-operation-set-changed";
  for (const dependency of entry.dependencies) {
    const operation = current.get(dependency.operation);
    if (
      !operation ||
      operation["x-express-recon"]?.enrichmentFingerprint !== dependency.evidenceFingerprint
    ) {
      return "dependent-operation-evidence-changed";
    }
    if (!reviewedSourcesMatch(root, dependency)) return "dependent-reviewed-source-changed";
  }
  return null;
}

function applyEnrichment(root, base, enrichment) {
  const output = clone(base);
  const current = new Map(operationEntries(output).map((entry) => [entry.key, entry.operation]));
  const applicableOperations = new Map();
  const staleOperationDetails = [];
  const removedOperations = [];

  for (const entry of enrichment.operations) {
    const operation = current.get(entry.operation);
    if (!operation) {
      removedOperations.push(entry.operation);
      continue;
    }
    const reason = operationCompatibility(root, operation, entry);
    if (reason) staleOperationDetails.push({ operation: entry.operation, reason });
    else applicableOperations.set(entry.operation, entry);
  }

  // Build the contract that would result if all evidence-compatible operation
  // and base-schema overlays applied. Schema dependency sets are evaluated
  // against this prospective graph, including transitive component references.
  const prospective = clone(base);
  const prospectiveOperations = new Map(
    operationEntries(prospective).map((entry) => [entry.key, entry.operation]),
  );
  for (const [key, entry] of applicableOperations) {
    applyOperationEntry(prospectiveOperations.get(key), entry);
  }

  const baseSchemas = object(object(base.components).schemas);
  const matchingSchemas = new Map();
  const staleSchemaDetails = [];
  for (const entry of enrichment.schemas) {
    const baseValue = Object.hasOwn(baseSchemas, entry.name) ? baseSchemas[entry.name] : undefined;
    if (schemaFingerprint(baseValue) !== entry.evidenceFingerprint) {
      staleSchemaDetails.push({ name: entry.name, reason: "base-schema-changed" });
      continue;
    }
    matchingSchemas.set(entry.name, entry);
    prospective.components ||= {};
    prospective.components.schemas ||= {};
    define(prospective.components.schemas, entry.name, clone(entry.value));
  }

  const prospectiveCurrent = new Map(
    operationEntries(prospective).map((entry) => [entry.key, entry.operation]),
  );
  const currentDependents = dependentOperations(prospective);
  const applicableSchemas = new Map();
  const dormantSchemas = [];
  for (const [name, entry] of matchingSchemas) {
    const reason = schemaCompatibility(root, entry, prospectiveCurrent, currentDependents);
    if (reason) {
      staleSchemaDetails.push({ name, reason });
    } else if (!Object.hasOwn(baseSchemas, name) && !(currentDependents.get(name)?.size > 0)) {
      dormantSchemas.push(name);
    } else {
      applicableSchemas.set(name, entry);
    }
  }

  const appliedSchemas = [];
  for (const [name, entry] of applicableSchemas) {
    output.components ||= {};
    output.components.schemas ||= {};
    define(output.components.schemas, name, clone(entry.value));
    appliedSchemas.push(name);
  }

  const appliedOperations = [];
  for (const [key, entry] of applicableOperations) {
    const candidate = clone(current.get(key));
    applyOperationEntry(candidate, entry);
    try {
      validateReferences(candidate, output, `#/paths/${key}`);
    } catch {
      staleOperationDetails.push({ operation: key, reason: "schema-reference-unavailable" });
      continue;
    }
    applyOperationEntry(current.get(key), entry);
    appliedOperations.push(key);
  }

  const reviewed = new Set(enrichment.operations.map((entry) => entry.operation));
  const unreviewedOperations = [...current.keys()].filter((key) => !reviewed.has(key)).sort();
  const staleOperations = staleOperationDetails.map((entry) => entry.operation).sort();
  const staleSchemas = staleSchemaDetails.map((entry) => entry.name).sort();
  const summary = {
    appliedOperations: appliedOperations.length,
    staleOperations: staleOperations.length,
    removedOperations: removedOperations.length,
    unreviewedOperations: unreviewedOperations.length,
    appliedSchemas: appliedSchemas.length,
    staleSchemas: staleSchemas.length,
    dormantSchemas: dormantSchemas.length,
  };
  const metadata = object(output["x-express-recon"]);
  if (output["x-express-recon"] !== metadata) define(output, "x-express-recon", metadata);
  metadata.schemasArePlaceholders =
    unreviewedOperations.length > 0 ||
    staleOperations.length > 0 ||
    staleSchemas.length > 0 ||
    containsUnrefined(output);
  metadata.enrichment = {
    tool: "express-recon",
    schemaVersion: ENRICHMENT_SCHEMA_VERSION,
    artifact: ENRICHMENT_FILE,
    fingerprintPolicy: "operation-all-evidence-and-schema-dependencies-v2",
    summary,
  };
  return {
    document: output,
    report: {
      summary,
      appliedOperations: appliedOperations.sort(),
      staleOperations,
      staleOperationDetails: staleOperationDetails.sort((left, right) =>
        left.operation.localeCompare(right.operation),
      ),
      removedOperations: removedOperations.sort(),
      unreviewedOperations,
      appliedSchemas: appliedSchemas.sort(),
      staleSchemas,
      staleSchemaDetails: staleSchemaDetails.sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
      dormantSchemas: dormantSchemas.sort(),
    },
  };
}

function resolveLocalPointer(document, reference) {
  let current = document;
  for (const encoded of reference.slice(2).split("/")) {
    const key = decodeURIComponent(encoded).replaceAll("~1", "/").replaceAll("~0", "~");
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return false;
    current = current[key];
  }
  return true;
}

function validateReferences(value, document, location = "#") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateReferences(item, document, `${location}/${index}`));
    return;
  }
  if (!value || typeof value !== "object") return;
  if (
    typeof value.$ref === "string" &&
    value.$ref.startsWith("#/") &&
    !resolveLocalPointer(document, value.$ref)
  ) {
    throw new Error(`OpenAPI local reference does not resolve at ${location}: ${value.$ref}`);
  }
  for (const [key, child] of Object.entries(value)) {
    validateReferences(
      child,
      document,
      `${location}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
    );
  }
}

function validateSpecification(document, label = "refreshed OpenAPI document") {
  describeRenderableSpecification(document, label);
  validateOpenApiDocument(document, label);
  validateReferences(document, document);
  if (Buffer.byteLength(JSON.stringify(document)) > MAX_STATE_JSON_BYTES) {
    throw new Error(`${label} exceeds ${MAX_STATE_JSON_BYTES} bytes`);
  }
}

function listFiles(directory, root = directory, state = { count: 0 }, depth = 0) {
  if (depth > 40) throw new Error(`Refresh output exceeds the maximum directory depth: ${root}`);
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    state.count++;
    if (state.count > MAX_OWNED_FILES) {
      throw new Error(`Refresh output exceeds ${MAX_OWNED_FILES} filesystem entries: ${root}`);
    }
    const target = path.join(directory, entry.name);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink())
      throw new Error(`Refresh output cannot contain symbolic links: ${target}`);
    if (stat.isDirectory()) output.push(...listFiles(target, root, state, depth + 1));
    else if (stat.isFile()) output.push(path.relative(root, target).split(path.sep).join("/"));
    else throw new Error(`Refresh output contains an unsupported filesystem entry: ${target}`);
  }
  return output.sort();
}

function ensureDirectory(directory) {
  const resolved = path.resolve(directory);
  if (resolved === path.parse(resolved).root) return;
  const parent = path.dirname(resolved);
  ensureDirectory(parent);
  if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refresh output path must use regular directories: ${resolved}`);
  }
}

function resolvedDestination(destination) {
  const requested = path.resolve(destination);
  if (fs.existsSync(requested)) {
    const stat = fs.lstatSync(requested);
    if (stat.isSymbolicLink())
      throw new Error(`Refresh output cannot be a symbolic link: ${requested}`);
    return fs.realpathSync(requested);
  }
  const missing = [];
  let ancestor = requested;
  while (!fs.existsSync(ancestor)) {
    missing.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const stat = fs.lstatSync(ancestor);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refresh output parent must resolve to a directory: ${ancestor}`);
  }
  return path.join(fs.realpathSync(ancestor), ...missing);
}

function validateOutputLocation(root, output) {
  const source = fs.realpathSync(path.resolve(root));
  const target = resolvedDestination(output);
  const currentDirectory = fs.realpathSync(path.resolve(process.cwd()));
  const homeDirectory = fs.realpathSync(path.resolve(os.homedir()));
  const forbidden = new Set([path.parse(target).root, source, currentDirectory, homeDirectory]);
  if (forbidden.has(target) || within(target, source)) {
    throw new Error(`Refusing unsafe refresh output directory: ${target}`);
  }
  if (within(source, target)) {
    const relative = path.relative(source, target).split(path.sep);
    if (relative[0] !== ".express-recon" || relative.length < 2) {
      throw new Error("Refresh output inside the scan root must be under .express-recon/<name>");
    }
  }
  ensureDirectory(path.dirname(target));
  return { source, output: target };
}

function validateManifest(manifest, output) {
  if (
    !manifest ||
    manifest.schemaVersion !== STATE_SCHEMA_VERSION ||
    manifest.kind !== "express-recon-openapi-refresh" ||
    manifest.tool !== "express-recon" ||
    !Array.isArray(manifest.ownedFiles) ||
    !manifest.integrity ||
    typeof manifest.integrity !== "object" ||
    Array.isArray(manifest.integrity)
  ) {
    throw new Error(`Refresh output has an incompatible ${REFRESH_MANIFEST}: ${output}`);
  }
  if (manifest.ownedFiles.some((reference) => !safeRelative(reference))) {
    throw new Error(`Refresh output manifest contains an unsafe owned path: ${output}`);
  }
  if (new Set(manifest.ownedFiles).size !== manifest.ownedFiles.length) {
    throw new Error(`Refresh output manifest repeats an owned path: ${output}`);
  }
  const owned = new Set(manifest.ownedFiles);
  if (
    !owned.has(REFRESH_MANIFEST) ||
    CORE_STATE_FILES.some(
      (reference) => !owned.has(reference) || !Object.hasOwn(manifest.integrity, reference),
    )
  ) {
    throw new Error(`Refresh output manifest is missing required artifacts: ${output}`);
  }
  const selection = manifest.selection;
  if (
    !selection ||
    (selection.applicationId !== null && typeof selection.applicationId !== "string") ||
    (selection.spec !== null && !safeRelative(selection.spec)) ||
    (selection.jsdoc !== null &&
      (!Array.isArray(selection.jsdoc) || selection.jsdoc.some((value) => !safeRelative(value))))
  ) {
    throw new Error(`Refresh output manifest has an invalid selection: ${output}`);
  }
  const invocation = manifest.invocation;
  if (!validInvocation(invocation)) {
    throw new Error(`Refresh output manifest has an invalid invocation: ${output}`);
  }
  const actual = listFiles(output);
  const expected = manifest.ownedFiles.slice().sort();
  if (!same(actual, expected)) {
    throw new Error(
      `Refresh output contains missing or unowned files: ${output}. No files were changed.`,
    );
  }
}

function inspectExistingState(root, output, options = {}) {
  const location = validateOutputLocation(root, output);
  if (!fs.existsSync(location.output)) return { ...location, manifest: null };
  const stat = fs.lstatSync(location.output);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refresh output must be a regular directory: ${location.output}`);
  }
  if (fs.readdirSync(location.output).length === 0) return { ...location, manifest: null };
  const manifest = readBoundedJson(
    path.join(location.output, REFRESH_MANIFEST),
    MAX_MANIFEST_BYTES,
  );
  validateManifest(manifest, location.output);
  if (!options.overwrite) {
    for (const [reference, expected] of Object.entries(manifest.integrity)) {
      if (!safeRelative(reference) || !/^sha256:[a-f0-9]{64}$/.test(expected)) {
        throw new Error(
          `Refresh output manifest has invalid integrity metadata: ${location.output}`,
        );
      }
      if (options.acceptEnrichment && reference === OPENAPI_FILE) continue;
      const actual = hash(fs.readFileSync(path.join(location.output, ...reference.split("/"))));
      if (actual !== expected) {
        const hint =
          reference === OPENAPI_FILE
            ? " Run refresh --accept-enrichment to retain intentional AI edits."
            : "";
        throw new Error(
          `Refresh-owned artifact was modified: ${reference}.${hint} No files were changed.`,
        );
      }
    }
  }
  return { ...location, manifest };
}

function readRefreshDefaults(root, output, options = {}) {
  const state = inspectExistingState(root, output, options);
  if (options.acceptEnrichment && !state.manifest) {
    throw new Error("refresh --accept-enrichment requires an existing refresh output");
  }
  if (options.overwrite || !state.manifest) return {};
  return {
    applicationId: state.manifest.selection?.applicationId ?? undefined,
    spec: state.manifest.selection?.spec ?? undefined,
    jsdoc: state.manifest.selection?.jsdoc ?? undefined,
    invocation: clone(state.manifest.invocation),
  };
}

function loadExistingArtifacts(state, options) {
  if (!state.manifest || options.overwrite) return null;
  const root = state.output;
  return {
    manifest: state.manifest,
    routes: readBoundedJson(path.join(root, ROUTES_FILE)),
    generated: readBoundedJson(path.join(root, GENERATED_FILE)),
    enrichment: readBoundedJson(path.join(root, ENRICHMENT_FILE)),
    baselineOpenApi: readBoundedJson(path.join(root, OPENAPI_BASELINE_FILE)),
    openapi: readBoundedJson(path.join(root, OPENAPI_FILE)),
  };
}

function applicationMatches(value, applicationId) {
  if (applicationId === "all") return true;
  return (value?.applicationId ?? null) === applicationId;
}

function scopedRouteReport(report, applicationId) {
  if (applicationId === "all") return clone(report);
  const output = clone(report);
  output.routes = (output.routes || []).filter((route) => applicationMatches(route, applicationId));
  output.applications = (output.applications || []).filter(
    (application) => application.id === applicationId,
  );
  if (Array.isArray(output.findings)) {
    output.findings = output.findings.filter((finding) =>
      applicationMatches(finding, applicationId),
    );
  }
  if (output.summary) {
    output.summary = {
      ...output.summary,
      routes: output.routes.length,
      public: output.routes.filter((route) => route.authStatus === "public").length,
      unknown: output.routes.filter((route) => route.authStatus === "unknown").length,
      proven: output.routes.filter((route) => route.authStatus === "proven").length,
      accepted: output.routes.filter((route) => route.accepted).length,
      policyViolations: (output.findings || []).filter(
        (finding) => finding.id === "policy-violation",
      ).length,
    };
  }
  if (output.routeGraph) {
    output.routeGraph = {
      ...output.routeGraph,
      orphanRoutes: applicationId === null ? output.routeGraph.orphanRoutes : 0,
      opaqueMounts: (output.routeGraph.opaqueMounts || []).filter(
        (mount) => mount.applicationId === null || mount.applicationId === applicationId,
      ),
    };
  }
  return output;
}

function assertCompatibleState(existing, report, documentationReport, options) {
  if (!existing) return;
  const previousSelection = existing.manifest.selection || {};
  const applicationId = documentationReport.applicationId ?? null;
  if ((previousSelection.applicationId ?? null) !== applicationId) {
    throw new Error("Refresh application selection changed; use --overwrite to start a new state");
  }
  if ((previousSelection.spec ?? null) !== (documentationReport.sources?.base ?? null)) {
    throw new Error("Refresh base OpenAPI selection changed; use --overwrite to start a new state");
  }
  if (
    (existing.routes.configHash ?? null) !== (report.configHash ?? null) &&
    !options.configurationExplicit
  ) {
    throw new Error(
      "Refresh configuration changed; repeat the prior --config or use --overwrite to start a new state",
    );
  }
  const previousTarget = existing.routes.target?.name;
  const currentTarget = report.target?.name;
  if (previousTarget && currentTarget && previousTarget !== currentTarget) {
    throw new Error(
      "Refresh output belongs to a different package; use a separate --out directory",
    );
  }
  compareReports(existing.routes, report);
}

function replaceOutput(staging, output) {
  if (!fs.existsSync(output)) {
    fs.renameSync(staging, output);
    return;
  }
  const backup = fs.mkdtempSync(path.join(path.dirname(output), ".express-recon-refresh-backup-"));
  fs.rmdirSync(backup);
  fs.renameSync(output, backup);
  try {
    fs.renameSync(staging, output);
  } catch (error) {
    fs.renameSync(backup, output);
    throw error;
  }
  fs.rmSync(backup, { recursive: true, force: true });
}

function integrityFor(directory, references) {
  return Object.fromEntries(
    references.map((reference) => [
      reference,
      hash(fs.readFileSync(path.join(directory, ...reference.split("/")))),
    ]),
  );
}

function refreshResult(output, refreshReport, rendered) {
  return {
    kind: "openapi-refresh-result",
    output,
    openapi: path.join(output, OPENAPI_FILE),
    enrichment: path.join(output, ENRICHMENT_FILE),
    report: path.join(output, REFRESH_REPORT_FILE),
    openapiDelta: path.join(output, OPENAPI_DELTA_FILE),
    ...(rendered ? { html: path.join(output, API_REFERENCE_DIRECTORY, "index.html") } : {}),
    routeChanges: refreshReport.routeChanges,
    openapiChanges: refreshReport.openapiChanges,
    openapiBaselineAvailable: refreshReport.openapiBaselineAvailable,
    enrichmentSummary: refreshReport.enrichment.summary,
  };
}

/**
 * Replace a tool-owned OpenAPI refresh state atomically. Static reconciliation
 * remains authoritative; accepted AI fields live in a fingerprinted overlay
 * and are applied only while the operation and its source evidence still match.
 */
function refreshDocumentation(options) {
  const invocation = normalizedInvocation({
    ...options.invocation,
    render: options.render !== false,
  });
  const state = inspectExistingState(options.root, options.output, options);
  const existing = loadExistingArtifacts(state, options);
  const applicationId = options.documentation.report.applicationId ?? null;
  const currentRoutes = scopedRouteReport(options.routes, applicationId);
  assertCompatibleState(existing, currentRoutes, options.documentation.report, options);

  const generated = addOperationFingerprints(options.documentation.document, state.source);
  validateSpecification(generated, GENERATED_FILE);
  let enrichment = existing
    ? validateEnrichment(existing.enrichment, applicationId)
    : emptyEnrichment(applicationId);
  let acceptance = null;
  if (options.acceptEnrichment) {
    const captured = captureEnrichment(
      state.source,
      existing.generated,
      existing.openapi,
      enrichment,
      applicationId,
      {
        reviewOperations: options.reviewOperations,
        clearOperations: options.clearOperations,
        clearSchemas: options.clearSchemas,
      },
    );
    enrichment = captured.enrichment;
    acceptance = captured.summary;
  }
  const applied = applyEnrichment(state.source, generated, enrichment);
  validateSpecification(applied.document);
  const openapiDelta = compareOpenApiDocuments(existing?.baselineOpenApi || null, applied.document);

  const routes = clone(currentRoutes);
  if (existing) routes.delta = compareReports(existing.routes, routes);
  const routeChanges = routes.delta?.summary || null;
  const refreshReport = {
    schemaVersion: STATE_SCHEMA_VERSION,
    kind: "express-recon-openapi-refresh-report",
    tool: "express-recon",
    toolVersion: pkg.version,
    applicationId,
    routeChanges,
    openapiBaselineAvailable: openapiDelta.baselineAvailable,
    openapiChanges: openapiDelta.summary,
    enrichment: applied.report,
    ...(acceptance ? { acceptance } : {}),
    artifacts: {
      routes: ROUTES_FILE,
      discovery: DISCOVERY_FILE,
      generatedOpenApi: GENERATED_FILE,
      enrichment: ENRICHMENT_FILE,
      baselineOpenApi: OPENAPI_BASELINE_FILE,
      openapi: OPENAPI_FILE,
      openapiDelta: OPENAPI_DELTA_FILE,
      documentationReport: DOCS_REPORT_FILE,
      ...(options.render === false ? {} : { html: `${API_REFERENCE_DIRECTORY}/index.html` }),
    },
  };

  const staging = fs.mkdtempSync(path.join(path.dirname(state.output), ".express-recon-refresh-"));
  let moved = false;
  try {
    writeJson(path.join(staging, ROUTES_FILE), routes);
    writeJson(path.join(staging, DISCOVERY_FILE), options.discovery);
    writeJson(path.join(staging, GENERATED_FILE), generated);
    writeJson(path.join(staging, ENRICHMENT_FILE), enrichment);
    writeJson(path.join(staging, OPENAPI_BASELINE_FILE), applied.document);
    writeJson(path.join(staging, OPENAPI_FILE), applied.document);
    writeJson(path.join(staging, OPENAPI_DELTA_FILE), openapiDelta);
    writeJson(path.join(staging, DOCS_REPORT_FILE), options.documentation.report);
    writeJson(path.join(staging, REFRESH_REPORT_FILE), refreshReport);
    if (options.render !== false) {
      renderHtmlSite(path.join(staging, OPENAPI_FILE), path.join(staging, API_REFERENCE_DIRECTORY));
    }
    const integrityFiles = [
      ROUTES_FILE,
      DISCOVERY_FILE,
      GENERATED_FILE,
      ENRICHMENT_FILE,
      OPENAPI_BASELINE_FILE,
      OPENAPI_FILE,
      OPENAPI_DELTA_FILE,
      DOCS_REPORT_FILE,
      REFRESH_REPORT_FILE,
    ];
    const selection = {
      applicationId,
      spec: options.documentation.report.sources?.base ?? null,
      jsdoc: options.explicitJSDoc ? options.documentation.report.sources?.jsdoc || [] : null,
    };
    const ownedFiles = [...listFiles(staging), REFRESH_MANIFEST].sort();
    const manifest = {
      schemaVersion: STATE_SCHEMA_VERSION,
      kind: "express-recon-openapi-refresh",
      tool: "express-recon",
      toolVersion: pkg.version,
      selection,
      invocation,
      source: {
        target: currentRoutes.target || null,
        scopeFingerprint: currentRoutes.scanCoverage?.scope?.fingerprint || null,
      },
      render: options.render !== false,
      artifacts: refreshReport.artifacts,
      ownedFiles,
      integrity: integrityFor(staging, integrityFiles),
    };
    writeJson(path.join(staging, REFRESH_MANIFEST), manifest);
    replaceOutput(staging, state.output);
    moved = true;
    return refreshResult(state.output, refreshReport, options.render !== false);
  } finally {
    if (!moved) fs.rmSync(staging, { recursive: true, force: true });
  }
}

function defaultRefreshOutput(root) {
  return path.join(path.resolve(root), ".express-recon", "api");
}

module.exports = {
  defaultRefreshOutput,
  readRefreshDefaults,
  refreshDocumentation,
};
