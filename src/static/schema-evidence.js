"use strict";

const { unwrap, staticString, calleeName } = require("./ast");

const CONFIDENCE = new Map([
  ["low", 1],
  ["medium", 2],
  ["high", 3],
]);
const KIND_PRIORITY = new Map([
  ["field-access", 10],
  ["response-literal", 20],
  ["typescript", 30],
  ["nestjs-dto", 40],
  ["class-validator", 50],
  ["nestjs-swagger", 52],
  ["express-validator", 55],
  ["joi", 55],
  ["zod", 55],
  ["fastify-schema", 60],
]);
const REQUEST_BUCKETS = ["body", "query", "params", "headers"];
const MAX_STATIC_DEPTH = 16;
const MAX_STATIC_NODES = 2_000;

/** Create an object whose keys are data even when one is named `__proto__`. */
function dataObject(entries = []) {
  return Object.fromEntries(entries);
}

function propertyName(property, consts) {
  if (!property) return null;
  if (!property.computed && property.key.type === "Identifier") return property.key.name;
  if (!property.computed && property.key.type === "Literal") return String(property.key.value);
  return property.computed ? staticString(property.key, consts) : null;
}

/**
 * Interpret a bounded, side-effect-free JavaScript value. This supports the
 * literal data shapes used by Fastify schemas and validator options without
 * importing or executing repository code.
 */
function staticValue(node, options = {}, state = { depth: 0, nodes: 0, seen: new Set() }) {
  const value = unwrap(node);
  const budget = state.budget || { nodes: state.nodes || 0 };
  if (!value || state.depth > MAX_STATIC_DEPTH || budget.nodes++ > MAX_STATIC_NODES)
    return undefined;
  if (value.type === "Literal") {
    if (["string", "number", "boolean"].includes(typeof value.value) || value.value === null) {
      return value.value;
    }
    return undefined;
  }
  if (value.type === "TemplateLiteral") {
    const text = staticString(value, options.consts);
    return text === null ? undefined : text;
  }
  if (value.type === "UnaryExpression" && ["+", "-"].includes(value.operator)) {
    const argument = staticValue(value.argument, options, {
      ...state,
      budget,
      depth: state.depth + 1,
    });
    return typeof argument === "number"
      ? value.operator === "-"
        ? -argument
        : argument
      : undefined;
  }
  if (value.type === "Identifier") {
    if (value.name === "undefined") return undefined;
    const binding = options.bindings?.get(value.name);
    if (!binding || state.seen.has(value.name)) return undefined;
    const seen = new Set(state.seen).add(value.name);
    return staticValue(binding, options, { ...state, budget, depth: state.depth + 1, seen });
  }
  if (value.type === "ArrayExpression") {
    const output = [];
    for (const element of value.elements || []) {
      if (!element) {
        output.push(null);
        continue;
      }
      const resolved = staticValue(element, options, {
        ...state,
        budget,
        depth: state.depth + 1,
      });
      if (resolved === undefined) return undefined;
      output.push(resolved);
    }
    return output;
  }
  if (value.type === "ObjectExpression") {
    const entries = [];
    for (const property of value.properties || []) {
      if (property.type === "SpreadElement") {
        const spread = staticValue(property.argument, options, {
          ...state,
          budget,
          depth: state.depth + 1,
        });
        if (!spread || typeof spread !== "object" || Array.isArray(spread)) return undefined;
        entries.push(...Object.entries(spread));
        continue;
      }
      if (property.type !== "Property" || property.kind !== "init") return undefined;
      const name = propertyName(property, options.consts);
      if (name === null) return undefined;
      const resolved = staticValue(property.value, options, {
        ...state,
        budget,
        depth: state.depth + 1,
      });
      if (resolved !== undefined) entries.push([name, resolved]);
      else if (!options.partialObjects) return undefined;
    }
    return dataObject(entries);
  }
  if (value.type === "CallExpression") {
    const name = calleeName(value.callee);
    if (["Object.freeze", "Object.seal"].includes(name) && value.arguments[0]) {
      return staticValue(value.arguments[0], options, {
        ...state,
        budget,
        depth: state.depth + 1,
      });
    }
  }
  return undefined;
}

function schemaType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function uniqueSchemas(schemas) {
  const seen = new Set();
  return schemas.filter((schema) => {
    const key = JSON.stringify(schema);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Infer a conservative JSON Schema fragment from a returned literal expression. */
function schemaFromExpression(node, options = {}, depth = 0, seen = new Set()) {
  const value = unwrap(node);
  if (!value || depth > MAX_STATIC_DEPTH) return {};
  if (value.type === "Identifier") {
    const binding = options.bindings?.get(value.name);
    if (!binding || seen.has(value.name)) return {};
    return schemaFromExpression(binding, options, depth + 1, new Set(seen).add(value.name));
  }
  if (value.type === "Literal") {
    const type = schemaType(value.value);
    return type === "undefined" ? {} : { type };
  }
  if (value.type === "TemplateLiteral") return { type: "string" };
  if (value.type === "ObjectExpression") {
    const properties = [];
    const required = [];
    for (const property of value.properties || []) {
      if (property.type !== "Property" || property.kind !== "init") continue;
      const name = propertyName(property, options.consts);
      if (name === null) continue;
      properties.push([
        name,
        schemaFromExpression(property.value, options, depth + 1, new Set(seen)),
      ]);
      required.push(name);
    }
    return {
      type: "object",
      properties: dataObject(properties),
      ...(required.length ? { required } : {}),
    };
  }
  if (value.type === "ArrayExpression") {
    const schemas = uniqueSchemas(
      (value.elements || [])
        .filter(Boolean)
        .map((element) => schemaFromExpression(element, options, depth + 1, new Set(seen))),
    );
    if (schemas.length === 0) return { type: "array", items: {} };
    return { type: "array", items: schemas.length === 1 ? schemas[0] : { anyOf: schemas } };
  }
  if (value.type === "ConditionalExpression") {
    const schemas = uniqueSchemas([
      schemaFromExpression(value.consequent, options, depth + 1, new Set(seen)),
      schemaFromExpression(value.alternate, options, depth + 1, new Set(seen)),
    ]);
    return schemas.length === 1 ? schemas[0] : { anyOf: schemas };
  }
  if (value.type === "LogicalExpression") {
    const schemas = uniqueSchemas([
      schemaFromExpression(value.left, options, depth + 1, new Set(seen)),
      schemaFromExpression(value.right, options, depth + 1, new Set(seen)),
    ]);
    return schemas.length === 1 ? schemas[0] : { anyOf: schemas };
  }
  if (value.type === "BinaryExpression") {
    if (
      ["==", "!=", "===", "!==", "<", "<=", ">", ">=", "in", "instanceof"].includes(value.operator)
    ) {
      return { type: "boolean" };
    }
    if (value.operator === "+") {
      const left = schemaFromExpression(value.left, options, depth + 1, new Set(seen));
      const right = schemaFromExpression(value.right, options, depth + 1, new Set(seen));
      if (left.type === "string" || right.type === "string") return { type: "string" };
      if (["integer", "number"].includes(left.type) && ["integer", "number"].includes(right.type)) {
        return { type: "number" };
      }
      return {};
    }
    if (["-", "*", "/", "%", "**", "|", "&", "^", "<<", ">>", ">>>"].includes(value.operator)) {
      return { type: "number" };
    }
    return {};
  }
  if (value.type === "UnaryExpression") {
    if (["!", "delete"].includes(value.operator)) return { type: "boolean" };
    if (value.operator === "typeof") return { type: "string" };
    if (["+", "-", "~"].includes(value.operator)) return { type: "number" };
    return {};
  }
  if (value.type === "UpdateExpression") return { type: "number" };
  if (value.type === "AwaitExpression" || value.type === "ChainExpression") {
    return schemaFromExpression(
      value.argument || value.expression,
      options,
      depth + 1,
      new Set(seen),
    );
  }
  if (value.type === "CallExpression" || value.type === "NewExpression") {
    const name = calleeName(value.callee);
    if (name === "String") return { type: "string" };
    if (name === "Number") return { type: "number" };
    if (name === "Boolean") return { type: "boolean" };
    if (name === "Date") return { type: "string", format: "date-time" };
  }
  return {};
}

/** Build the low-confidence object shape represented by field-access hints. */
function schemaFromFields(fields) {
  return {
    type: "object",
    properties: dataObject([...new Set(fields)].sort().map((name) => [name, {}])),
  };
}

/** Create a normalized schema provenance record. */
function evidence(kind, confidence, source = null) {
  return {
    kind,
    confidence,
    ...(source ? { source } : {}),
  };
}

/** Wrap a JSON Schema fragment with one or more provenance records. */
function contract(schema, provenance) {
  return {
    schema: schema && typeof schema === "object" && !Array.isArray(schema) ? schema : {},
    evidence: (Array.isArray(provenance) ? provenance : [provenance]).filter(Boolean),
  };
}

function evidenceRank(item) {
  return (CONFIDENCE.get(item.confidence) || 0) * 100 + (KIND_PRIORITY.get(item.kind) || 0);
}

function contractRank(value) {
  return Math.max(0, ...(value?.evidence || []).map(evidenceRank));
}

function evidenceKey(item) {
  return `${item.kind}\0${item.confidence}\0${item.source?.file || ""}\0${item.source?.line || ""}`;
}

function mergeEvidence(left, right) {
  const seen = new Set();
  return [...(left || []), ...(right || [])].filter((item) => {
    const key = evidenceKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function schemaProperties(schema) {
  return schema?.type === "object" && schema.properties && typeof schema.properties === "object"
    ? schema.properties
    : null;
}

function addConflict(conflicts, conflict) {
  const key = `${conflict.location}\0${conflict.kind}\0${conflict.message}`;
  if (conflicts.some((item) => `${item.location}\0${item.kind}\0${item.message}` === key)) return;
  conflicts.push(conflict);
}

function compareSchemas(left, right, location, provenance, conflicts, reportMissing = true) {
  if (left.type && right.type && JSON.stringify(left.type) !== JSON.stringify(right.type)) {
    addConflict(conflicts, {
      location,
      kind: "type-mismatch",
      message: `static evidence disagrees on type (${JSON.stringify(left.type)} vs ${JSON.stringify(right.type)})`,
      evidence: provenance,
    });
    return;
  }
  for (const keyword of [
    "format",
    "pattern",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "enum",
    "const",
  ]) {
    if (
      Object.hasOwn(left, keyword) &&
      Object.hasOwn(right, keyword) &&
      JSON.stringify(left[keyword]) !== JSON.stringify(right[keyword])
    ) {
      addConflict(conflicts, {
        location,
        kind: "constraint-mismatch",
        message: `static schema evidence disagrees on ${keyword}`,
        evidence: provenance,
      });
    }
  }
  const leftProperties = schemaProperties(left);
  const rightProperties = schemaProperties(right);
  if (!leftProperties || !rightProperties) return;
  const leftRequired = new Set(left.required || []);
  const rightRequired = new Set(right.required || []);
  for (const name of Object.keys(leftProperties)) {
    if (!Object.hasOwn(rightProperties, name)) {
      if (reportMissing) {
        addConflict(conflicts, {
          location: `${location}.${name}`,
          kind: "field-not-described",
          message: "a field read or returned by code is absent from stronger schema evidence",
          evidence: provenance,
        });
      }
      continue;
    }
    if (leftRequired.has(name) !== rightRequired.has(name)) {
      addConflict(conflicts, {
        location: `${location}.${name}`,
        kind: "requiredness-mismatch",
        message: "static schema evidence disagrees on whether the field is required",
        evidence: provenance,
      });
    }
    compareSchemas(
      leftProperties[name],
      rightProperties[name],
      `${location}.${name}`,
      provenance,
      conflicts,
      reportMissing,
    );
  }
}

function mergeObjectSchemas(left, right) {
  const leftProperties = schemaProperties(left);
  const rightProperties = schemaProperties(right);
  if (!leftProperties || !rightProperties) return left;
  const properties = dataObject(Object.entries(leftProperties));
  for (const [name, schema] of Object.entries(rightProperties)) {
    if (!Object.hasOwn(properties, name)) properties[name] = schema;
  }
  const required = [...new Set([...(left.required || []), ...(right.required || [])])].sort();
  return { ...left, properties, ...(required.length ? { required } : {}) };
}

function mergeContract(current, incoming, location, conflicts) {
  if (!current) return incoming;
  const provenance = mergeEvidence(current.evidence, incoming.evidence);
  const currentRank = contractRank(current);
  const incomingRank = contractRank(incoming);
  if (currentRank < incomingRank) {
    compareSchemas(current.schema, incoming.schema, location, provenance, conflicts);
    return { schema: incoming.schema, evidence: provenance };
  }
  if (incomingRank < currentRank) {
    compareSchemas(incoming.schema, current.schema, location, provenance, conflicts);
    return { schema: current.schema, evidence: provenance };
  }
  compareSchemas(current.schema, incoming.schema, location, provenance, conflicts, false);
  compareSchemas(incoming.schema, current.schema, location, provenance, conflicts, false);
  return { schema: mergeObjectSchemas(current.schema, incoming.schema), evidence: provenance };
}

/** Ensure an I/O record has the optional structured-schema container. */
function ensureSchemas(io) {
  if (!io.schemas) io.schemas = { request: {}, responses: [], conflicts: [] };
  return io.schemas;
}

function schemaKeys(schema) {
  return Object.keys(schemaProperties(schema) || {});
}

/** Add request schema evidence and mirror top-level keys into legacy hints. */
function addRequestSchema(io, bucket, value) {
  if (!REQUEST_BUCKETS.includes(bucket) || !value) return;
  const schemas = ensureSchemas(io);
  schemas.request[bucket] = mergeContract(
    schemas.request[bucket],
    value,
    `request.${bucket}`,
    schemas.conflicts,
  );
  io.request[bucket] = [
    ...new Set([...(io.request[bucket] || []), ...schemaKeys(value.schema)]),
  ].sort();
}

function responseIndex(schemas, status) {
  return schemas.responses.findIndex((item) => item.status === status);
}

/** Add response schema evidence and preserve the legacy status/body-key view. */
function addResponseSchema(io, status, value) {
  if (!value) return;
  const schemas = ensureSchemas(io);
  const index = responseIndex(schemas, status);
  if (index < 0) schemas.responses.push({ status, contract: value });
  else {
    schemas.responses[index].contract = mergeContract(
      schemas.responses[index].contract,
      value,
      `response.${status ?? "default"}`,
      schemas.conflicts,
    );
  }
  schemas.responses.sort((a, b) => (a.status ?? 0) - (b.status ?? 0));
  if (status != null && !io.statusCodes.includes(status)) io.statusCodes.push(status);
  io.statusCodes.sort((a, b) => a - b);
  const keys = schemaKeys(value.schema);
  if (status == null || keys.length === 0) return;
  const existing = io.responses.find((item) => item.status === status);
  if (existing) {
    if (existing.bodyKeys !== null) {
      existing.bodyKeys = [...new Set([...(existing.bodyKeys || []), ...keys])].sort();
    }
  } else io.responses.push({ status, bodyKeys: keys });
  io.responses.sort((a, b) => (a.status ?? 0) - (b.status ?? 0));
}

/** Attach low-confidence structured contracts for the existing flat hints. */
function addInferredSchemas(io, source = null) {
  for (const bucket of REQUEST_BUCKETS) {
    if (io.request[bucket]?.length) {
      addRequestSchema(
        io,
        bucket,
        contract(schemaFromFields(io.request[bucket]), evidence("field-access", "low", source)),
      );
    }
  }
}

/** Merge all structured contracts from one I/O record into another. */
function mergeSchemas(target, incoming) {
  if (!incoming?.schemas) return target;
  for (const bucket of REQUEST_BUCKETS) {
    if (incoming.schemas.request?.[bucket]) {
      addRequestSchema(target, bucket, incoming.schemas.request[bucket]);
    }
  }
  for (const response of incoming.schemas.responses || []) {
    addResponseSchema(target, response.status, response.contract);
  }
  const schemas = ensureSchemas(target);
  for (const conflict of incoming.schemas.conflicts || []) addConflict(schemas.conflicts, conflict);
  return target;
}

module.exports = {
  addInferredSchemas,
  addRequestSchema,
  addResponseSchema,
  contract,
  dataObject,
  ensureSchemas,
  evidence,
  mergeSchemas,
  schemaFromExpression,
  schemaFromFields,
  staticValue,
};
