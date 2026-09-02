"use strict";

const crypto = require("node:crypto");

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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
  return `sha256:${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}

function contractValue(value) {
  if (Array.isArray(value)) return value.map(contractValue);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (key !== "x-express-recon") output[key] = contractValue(child);
  }
  return output;
}

function operationMap(document) {
  const output = new Map();
  for (const pathName of Object.keys(object(document?.paths)).sort()) {
    const pathItem = object(document.paths[pathName]);
    for (const [methodName, operation] of Object.entries(pathItem)) {
      const method = methodName.toLowerCase();
      if (!HTTP_METHODS.has(method) || !operation || typeof operation !== "object") continue;
      const key = `${method.toUpperCase()} ${pathName}`;
      output.set(key, {
        key,
        method: method.toUpperCase(),
        path: pathName,
        contract: canonical({
          pathParameters: contractValue(pathItem.parameters || []),
          pathServers: contractValue(pathItem.servers || []),
          operation: contractValue(operation),
        }),
      });
    }
  }
  return output;
}

function schemaMap(document) {
  return new Map(
    Object.entries(object(object(document?.components).schemas)).map(([name, value]) => [
      name,
      canonical(contractValue(value)),
    ]),
  );
}

function referenceNames(value, output = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((entry) => referenceNames(entry, output));
    return output;
  }
  if (!value || typeof value !== "object") return output;
  if (typeof value.$ref === "string" && value.$ref.startsWith("#/components/schemas/")) {
    const raw = value.$ref.slice("#/components/schemas/".length).split("/", 1)[0];
    try {
      output.add(decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~"));
    } catch {
      output.add(raw.replaceAll("~1", "/").replaceAll("~0", "~"));
    }
  }
  Object.values(value).forEach((entry) => referenceNames(entry, output));
  return output;
}

function parameters(contract) {
  const values = [
    ...(contract.pathParameters || []),
    ...(object(contract.operation).parameters || []),
  ];
  return new Map(
    values
      .filter((entry) => entry && typeof entry === "object" && !entry.$ref)
      .map((entry) => [`${entry.in || ""}\0${entry.name || ""}`, entry]),
  );
}

function requiredParameter(parameter) {
  return parameter?.required === true || parameter?.in === "path";
}

function changedFields(before, after) {
  const beforeOperation = object(before.operation);
  const afterOperation = object(after.operation);
  const values = [];
  if (JSON.stringify(before.pathParameters) !== JSON.stringify(after.pathParameters)) {
    values.push("pathParameters");
  }
  if (JSON.stringify(before.pathServers) !== JSON.stringify(after.pathServers)) {
    values.push("pathServers");
  }
  for (const field of new Set([...Object.keys(beforeOperation), ...Object.keys(afterOperation)])) {
    if (JSON.stringify(beforeOperation[field]) !== JSON.stringify(afterOperation[field])) {
      values.push(field);
    }
  }
  return values.sort();
}

function operationBreaks(beforeEntry, afterEntry) {
  const output = [];
  const before = beforeEntry.contract;
  const after = afterEntry.contract;
  const beforeParameters = parameters(before);
  const afterParameters = parameters(after);
  for (const [key, parameter] of afterParameters) {
    const previous = beforeParameters.get(key);
    if (!previous && requiredParameter(parameter)) {
      output.push({
        kind: "required-parameter-added",
        operation: afterEntry.key,
        parameter: { name: parameter.name, in: parameter.in },
      });
    } else if (previous && !requiredParameter(previous) && requiredParameter(parameter)) {
      output.push({
        kind: "parameter-became-required",
        operation: afterEntry.key,
        parameter: { name: parameter.name, in: parameter.in },
      });
    } else if (
      previous &&
      requiredParameter(parameter) &&
      JSON.stringify(previous.schema || previous.content) !==
        JSON.stringify(parameter.schema || parameter.content)
    ) {
      output.push({
        kind: "required-parameter-contract-changed",
        operation: afterEntry.key,
        parameter: { name: parameter.name, in: parameter.in },
      });
    }
  }
  const beforeBody = object(before.operation).requestBody;
  const afterBody = object(after.operation).requestBody;
  if (beforeBody?.required !== true && afterBody?.required === true) {
    output.push({ kind: "request-body-became-required", operation: afterEntry.key });
  }
  const beforeResponses = object(object(before.operation).responses);
  const afterResponses = object(object(after.operation).responses);
  for (const status of Object.keys(beforeResponses)) {
    if (!Object.hasOwn(afterResponses, status)) {
      output.push({ kind: "response-removed", operation: afterEntry.key, status });
    }
  }
  return output;
}

function operationSummary(entry) {
  return { method: entry.method, path: entry.path };
}

/**
 * Compare two resolved OpenAPI documents without treating scanner provenance as
 * API contract. The breaking set is deliberately conservative; ambiguous
 * schema/body changes are reported separately for review instead of guessed.
 */
function compareOpenApiDocuments(baseline, current) {
  const before = baseline ? operationMap(baseline) : new Map();
  const after = operationMap(current);
  const addedOperations = [];
  const removedOperations = [];
  const changedOperations = [];
  const breakingChanges = [];
  const potentiallyBreakingChanges = [];

  for (const [key, entry] of after) {
    const previous = before.get(key);
    if (!previous) {
      addedOperations.push(operationSummary(entry));
      continue;
    }
    if (JSON.stringify(previous.contract) === JSON.stringify(entry.contract)) continue;
    const fields = changedFields(previous.contract, entry.contract);
    changedOperations.push({
      ...operationSummary(entry),
      changedFields: fields,
      beforeFingerprint: hash(previous.contract),
      afterFingerprint: hash(entry.contract),
    });
    const definite = operationBreaks(previous, entry);
    breakingChanges.push(...definite);
    if (
      fields.some((field) =>
        ["parameters", "pathParameters", "requestBody", "responses"].includes(field),
      ) &&
      definite.length === 0
    ) {
      potentiallyBreakingChanges.push({
        kind: "operation-contract-changed",
        operation: key,
        fields,
      });
    }
  }
  for (const [key, entry] of before) {
    if (!after.has(key)) {
      removedOperations.push(operationSummary(entry));
      breakingChanges.push({ kind: "operation-removed", operation: key });
    }
  }

  const beforeSchemas = baseline ? schemaMap(baseline) : new Map();
  const afterSchemas = schemaMap(current);
  const references = new Set([
    ...(baseline ? referenceNames(baseline) : []),
    ...referenceNames(current),
  ]);
  const addedSchemas = [];
  const removedSchemas = [];
  const changedSchemas = [];
  for (const [name, value] of afterSchemas) {
    if (!beforeSchemas.has(name)) addedSchemas.push(name);
    else if (JSON.stringify(beforeSchemas.get(name)) !== JSON.stringify(value)) {
      changedSchemas.push({
        name,
        beforeFingerprint: hash(beforeSchemas.get(name)),
        afterFingerprint: hash(value),
      });
      if (references.has(name)) {
        potentiallyBreakingChanges.push({ kind: "referenced-schema-changed", schema: name });
      }
    }
  }
  for (const name of beforeSchemas.keys()) {
    if (!afterSchemas.has(name)) {
      removedSchemas.push(name);
      if (references.has(name))
        breakingChanges.push({ kind: "referenced-schema-removed", schema: name });
    }
  }

  for (const list of [addedOperations, removedOperations, changedOperations]) {
    list.sort((left, right) =>
      left.path === right.path
        ? left.method.localeCompare(right.method)
        : left.path.localeCompare(right.path),
    );
  }
  addedSchemas.sort();
  removedSchemas.sort();
  changedSchemas.sort((left, right) => left.name.localeCompare(right.name));
  return {
    schemaVersion: "1.0",
    kind: "express-recon-openapi-delta",
    baselineAvailable: Boolean(baseline),
    summary: {
      addedOperations: addedOperations.length,
      removedOperations: removedOperations.length,
      changedOperations: changedOperations.length,
      addedSchemas: addedSchemas.length,
      removedSchemas: removedSchemas.length,
      changedSchemas: changedSchemas.length,
      breakingChanges: breakingChanges.length,
      potentiallyBreakingChanges: potentiallyBreakingChanges.length,
    },
    addedOperations,
    removedOperations,
    changedOperations,
    addedSchemas,
    removedSchemas,
    changedSchemas,
    breakingChanges,
    potentiallyBreakingChanges,
  };
}

module.exports = { compareOpenApiDocuments };
