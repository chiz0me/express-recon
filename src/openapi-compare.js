"use strict";

const { OPENAPI_METHODS: HTTP_METHOD_LIST } = require("./http-methods");

const crypto = require("node:crypto");

const HTTP_METHODS = new Set(HTTP_METHOD_LIST);
const MAX_REFERENCE_NODES = 50_000;
const MAX_REFERENCE_DEPTH = 256;
const REFERENCE_LIMIT_MARKER = Object.freeze({
  $expressReconReferenceLimit: true,
});

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function dataObject() {
  return Object.create(null);
}

// Reference caches and traversal budgets must see the same order for equivalent
// JSON objects, including mutually recursive schemas. Array order is preserved.
function contractEntries(value) {
  return Object.entries(value)
    .filter(([key]) => key !== "x-express-recon")
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

function markUncertain(state, scope) {
  state.uncertainScopes.add(scope || "operation");
  state.uncertaintyVersion++;
}

function limitedCanonical(state, scope) {
  state.limits.add("depth");
  markUncertain(state, scope);
  return { value: REFERENCE_LIMIT_MARKER, height: 0, object: true };
}

function canonicalNode(value, state, seen, depth, scope) {
  if (!value || typeof value !== "object") return { value, height: 0, object: false };
  const previous = seen.get(value);
  if (previous) {
    if (previous.pending || depth + previous.height > MAX_REFERENCE_DEPTH) {
      return limitedCanonical(state, scope);
    }
    if (previous.uncertain) markUncertain(state, scope);
    return { value: previous.output, height: previous.height, object: true };
  }
  if (Array.isArray(value)) {
    if (!chargeReferenceBudget(state, value.length + 1, depth, scope)) {
      return { value: REFERENCE_LIMIT_MARKER, height: 0, object: true };
    }
    const output = [];
    const beforeVersion = state.uncertaintyVersion;
    const record = { output, height: 0, pending: true, uncertain: false };
    seen.set(value, record);
    for (const entry of value) {
      const child = canonicalNode(entry, state, seen, depth + 1, scope);
      output.push(child.value);
      if (child.object) record.height = Math.max(record.height, child.height + 1);
    }
    record.pending = false;
    record.uncertain = state.uncertaintyVersion > beforeVersion;
    return { value: output, height: record.height, object: true };
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (!chargeReferenceBudget(state, entries.length + 1, depth, scope)) {
    return { value: REFERENCE_LIMIT_MARKER, height: 0, object: true };
  }
  const output = dataObject();
  const beforeVersion = state.uncertaintyVersion;
  const record = { output, height: 0, pending: true, uncertain: false };
  seen.set(value, record);
  for (const [key, child] of entries) {
    const canonicalChild = canonicalNode(child, state, seen, depth + 1, scope || key);
    output[key] = canonicalChild.value;
    if (canonicalChild.object) {
      record.height = Math.max(record.height, canonicalChild.height + 1);
    }
  }
  record.pending = false;
  record.uncertain = state.uncertaintyVersion > beforeVersion;
  return { value: output, height: record.height, object: true };
}

function canonical(value, state, seen = new WeakMap(), depth = 0, scope = "contract") {
  return canonicalNode(value, state, seen, depth, scope).value;
}

function structuralDigest(value, memo = new WeakMap(), visiting = new WeakSet()) {
  if (!value || typeof value !== "object") {
    return crypto
      .createHash("sha256")
      .update(`primitive:${JSON.stringify(value)}`)
      .digest("hex");
  }
  if (memo.has(value)) return memo.get(value);
  if (visiting.has(value)) {
    return crypto.createHash("sha256").update("cycle").digest("hex");
  }
  visiting.add(value);
  const digest = crypto.createHash("sha256");
  if (Array.isArray(value)) {
    digest.update("array\0");
    for (const child of value) digest.update(structuralDigest(child, memo, visiting)).update("\0");
  } else {
    digest.update("object\0");
    Object.keys(value)
      .sort()
      .forEach((key) => {
        digest
          .update(key)
          .update("\0")
          .update(structuralDigest(value[key], memo, visiting))
          .update("\0");
      });
  }
  visiting.delete(value);
  const result = digest.digest("hex");
  memo.set(value, result);
  return result;
}

function sameValue(left, right) {
  return structuralDigest(left) === structuralDigest(right);
}

function hash(value) {
  return `sha256:${structuralDigest(value)}`;
}

function contractValue(value, state, seen = new WeakMap(), depth = 0) {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    if (!chargeReferenceBudget(state, value.length + 1, depth, "schema")) {
      return REFERENCE_LIMIT_MARKER;
    }
    const output = [];
    seen.set(value, output);
    for (const entry of value) output.push(contractValue(entry, state, seen, depth + 1));
    return output;
  }
  const entries = contractEntries(value);
  if (!chargeReferenceBudget(state, entries.length + 1, depth, "schema")) {
    return REFERENCE_LIMIT_MARKER;
  }
  const output = dataObject();
  seen.set(value, output);
  for (const [key, child] of entries) {
    output[key] = contractValue(child, state, seen, depth + 1);
  }
  return output;
}

function pointerValue(document, reference) {
  if (!reference.startsWith("#/")) return undefined;
  let current = document;
  for (const raw of reference.slice(2).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function referenceState(seed) {
  return {
    external: new Set(seed?.external || []),
    unresolved: new Set(seed?.unresolved || []),
    limits: new Set(seed?.limits || []),
    uncertainScopes: new Set(seed?.uncertainScopes || []),
    uncertaintyVersion: 0,
    cache: new Map(),
    objects: new WeakMap(),
    remainingNodes: MAX_REFERENCE_NODES,
  };
}

function chargeReferenceBudget(state, amount, depth, scope = "contract") {
  if (depth > MAX_REFERENCE_DEPTH) {
    state.limits.add("depth");
    markUncertain(state, scope);
    return false;
  }
  if (amount > state.remainingNodes) {
    state.limits.add("nodes");
    markUncertain(state, scope);
    return false;
  }
  state.remainingNodes -= amount;
  return true;
}

function boundedCanonical(value, evidenceState, scope) {
  const traversalState = referenceState();
  const output = canonical(value, traversalState, new WeakMap(), 0, scope);
  for (const limit of traversalState.limits) evidenceState.limits.add(limit);
  for (const uncertainScope of traversalState.uncertainScopes) {
    evidenceState.uncertainScopes.add(uncertainScope);
  }
  evidenceState.uncertaintyVersion += traversalState.uncertaintyVersion;
  return output;
}

function resolveReferences(value, document, state, stack = new Set(), depth = 0, scope = null) {
  if (value && typeof value === "object" && state.objects.has(value)) {
    const cachedObject = state.objects.get(value);
    if (cachedObject.pending) {
      state.limits.add("depth");
      markUncertain(state, scope);
      return REFERENCE_LIMIT_MARKER;
    }
    if (cachedObject.uncertain) markUncertain(state, scope);
    return cachedObject.resolved;
  }
  if (Array.isArray(value)) {
    if (!chargeReferenceBudget(state, value.length + 1, depth, scope)) return [];
    const output = [];
    const beforeVersion = state.uncertaintyVersion;
    const cachedObject = { resolved: output, pending: true, uncertain: false };
    state.objects.set(value, cachedObject);
    for (const entry of value) {
      output.push(resolveReferences(entry, document, state, stack, depth + 1, scope));
    }
    cachedObject.pending = false;
    cachedObject.uncertain = state.uncertaintyVersion > beforeVersion;
    return output;
  }
  if (!value || typeof value !== "object") return value;
  const entries = contractEntries(value);
  if (!chargeReferenceBudget(state, entries.length + 1, depth, scope)) {
    return REFERENCE_LIMIT_MARKER;
  }
  if (typeof value.$ref === "string") {
    if (!value.$ref.startsWith("#")) {
      const beforeVersion = state.uncertaintyVersion;
      state.external.add(value.$ref);
      markUncertain(state, scope);
      const output = dataObject();
      const cachedObject = { resolved: output, pending: true, uncertain: false };
      state.objects.set(value, cachedObject);
      for (const [key, child] of entries) {
        output[key] =
          key === "$ref"
            ? child
            : resolveReferences(child, document, state, stack, depth + 1, scope || key);
      }
      cachedObject.pending = false;
      cachedObject.uncertain = state.uncertaintyVersion > beforeVersion;
      return output;
    }
    const target = pointerValue(document, value.$ref);
    if (target === undefined) {
      const beforeVersion = state.uncertaintyVersion;
      state.unresolved.add(value.$ref);
      markUncertain(state, scope);
      const output = dataObject();
      const cachedObject = { resolved: output, pending: true, uncertain: false };
      state.objects.set(value, cachedObject);
      for (const [key, child] of entries) {
        output[key] =
          key === "$ref"
            ? child
            : resolveReferences(child, document, state, stack, depth + 1, scope || key);
      }
      cachedObject.pending = false;
      cachedObject.uncertain = state.uncertaintyVersion > beforeVersion;
      return output;
    }
    if (stack.has(value.$ref)) return { $ref: value.$ref };
    const beforeVersion = state.uncertaintyVersion;
    let cached = state.cache.get(value.$ref);
    if (!cached) {
      const next = new Set(stack).add(value.$ref);
      const beforeTargetVersion = state.uncertaintyVersion;
      const resolved = resolveReferences(
        target,
        document,
        state,
        next,
        depth + 1,
        scope || "operation",
      );
      cached = { resolved, uncertain: state.uncertaintyVersion > beforeTargetVersion };
      state.cache.set(value.$ref, cached);
    } else if (cached.uncertain) {
      markUncertain(state, scope);
    }
    const siblings = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref"));
    const output = Object.keys(siblings).length
      ? {
          ...object(cached.resolved),
          ...resolveReferences(siblings, document, state, stack, depth + 1, scope),
        }
      : cached.resolved;
    state.objects.set(value, {
      resolved: output,
      pending: false,
      uncertain: state.uncertaintyVersion > beforeVersion,
    });
    return output;
  }
  const output = dataObject();
  const beforeVersion = state.uncertaintyVersion;
  const cachedObject = { resolved: output, pending: true, uncertain: false };
  state.objects.set(value, cachedObject);
  for (const [key, child] of entries) {
    output[key] = resolveReferences(child, document, state, stack, depth + 1, scope || key);
  }
  cachedObject.pending = false;
  cachedObject.uncertain = state.uncertaintyVersion > beforeVersion;
  return output;
}

/** Resolve only Path Item references, leaving each operation body isolated. */
function resolvePathItem(value, document, state, stack = new Set(), depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const entries = contractEntries(value);
  if (!chargeReferenceBudget(state, entries.length + 1, depth, "pathItem")) {
    return REFERENCE_LIMIT_MARKER;
  }
  const reference = typeof value.$ref === "string" ? value.$ref : null;
  if (!reference) return Object.fromEntries(entries);

  let resolved = dataObject();
  if (!reference.startsWith("#")) {
    state.external.add(reference);
    markUncertain(state, "pathItem");
  } else {
    const target = pointerValue(document, reference);
    if (target === undefined || stack.has(reference)) {
      state.unresolved.add(reference);
      markUncertain(state, "pathItem");
    } else {
      resolved = object(
        resolvePathItem(target, document, state, new Set(stack).add(reference), depth + 1),
      );
    }
  }
  const output = dataObject();
  for (const [key, child] of Object.entries(resolved)) output[key] = child;
  for (const [key, child] of entries) {
    if (key !== "$ref") output[key] = child;
  }
  return output;
}

function securitySchemeNames(security) {
  return new Set(
    (Array.isArray(security) ? security : []).flatMap((requirement) =>
      requirement && typeof requirement === "object" ? Object.keys(requirement) : [],
    ),
  );
}

function operationMap(document) {
  const operations = new Map();
  const pathUncertainties = new Map();
  for (const pathName of Object.keys(object(document?.paths)).sort()) {
    const pathState = referenceState();
    const pathItem = object(resolvePathItem(document.paths[pathName], document, pathState));
    if (pathState.external.size || pathState.unresolved.size || pathState.limits.size) {
      pathUncertainties.set(pathName, {
        external: new Set(pathState.external),
        unresolved: new Set(pathState.unresolved),
        limits: new Set(pathState.limits),
      });
    }
    for (const [methodName, operation] of Object.entries(pathItem)) {
      const method = methodName.toLowerCase();
      if (!HTTP_METHODS.has(method) || !operation || typeof operation !== "object") continue;
      const key = `${method.toUpperCase()} ${pathName}`;
      const state = referenceState(pathState);
      const resolvedOperation = resolveReferences(operation, document, state);
      const effectiveSecurity = Object.hasOwn(object(operation), "security")
        ? resolvedOperation.security
        : resolveReferences(document.security || [], document, state, new Set(), 0, "security");
      const effectiveServers = Object.hasOwn(object(operation), "servers")
        ? resolvedOperation.servers
        : Object.hasOwn(pathItem, "servers")
          ? pathItem.servers
          : resolveReferences(document.servers || [], document, state, new Set(), 0, "pathServers");
      const allSchemes = object(object(document.components).securitySchemes);
      const effectiveSchemes = dataObject();
      for (const name of securitySchemeNames(effectiveSecurity)) {
        if (Object.hasOwn(allSchemes, name)) {
          effectiveSchemes[name] = resolveReferences(
            allSchemes[name],
            document,
            state,
            new Set(),
            0,
            "securitySchemes",
          );
        } else {
          state.unresolved.add(`#/components/securitySchemes/${name}`);
          markUncertain(state, "securitySchemes");
        }
      }
      const resolvedPathParameters = resolveReferences(
        pathItem.parameters || [],
        document,
        state,
        new Set(),
        0,
        "pathParameters",
      );
      const resolvedPathServers = resolveReferences(
        effectiveServers || [],
        document,
        state,
        new Set(),
        0,
        "pathServers",
      );
      const contract = dataObject();
      contract.pathParameters = boundedCanonical(resolvedPathParameters, state, "pathParameters");
      contract.pathServers = boundedCanonical(resolvedPathServers, state, "pathServers");
      contract.effectiveSecurity = boundedCanonical(effectiveSecurity || [], state, "security");
      contract.securitySchemes = boundedCanonical(effectiveSchemes, state, "securitySchemes");
      contract.operation = boundedCanonical(resolvedOperation, state, null);
      contract.externalReferences = [...state.external].sort();
      contract.unresolvedReferences = [...state.unresolved].sort();
      contract.referenceExpansionLimits = [...state.limits].sort();
      operations.set(key, {
        key,
        method: method.toUpperCase(),
        path: pathName,
        contract,
        uncertainScopes: new Set(state.uncertainScopes),
      });
    }
  }
  return { operations, pathUncertainties };
}

function schemaMap(document) {
  const schemas = new Map();
  const limits = new Map();
  for (const [name, value] of Object.entries(object(object(document?.components).schemas))) {
    const state = referenceState();
    schemas.set(name, boundedCanonical(contractValue(value, state), state, "schema"));
    if (state.limits.size) limits.set(name, new Set(state.limits));
  }
  return { schemas, limits };
}

function referenceNames(value) {
  const names = new Set();
  const state = referenceState();
  const seen = new WeakSet();
  const pending = [{ value, depth: 0 }];
  while (pending.length) {
    const current = pending.pop();
    const item = current.value;
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    const entries = contractEntries(item);
    if (!chargeReferenceBudget(state, entries.length + 1, current.depth, "document")) continue;
    if (typeof item.$ref === "string" && item.$ref.startsWith("#/components/schemas/")) {
      const raw = item.$ref.slice("#/components/schemas/".length).split("/", 1)[0];
      try {
        names.add(decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~"));
      } catch {
        names.add(raw.replaceAll("~1", "/").replaceAll("~0", "~"));
      }
    }
    for (let index = entries.length - 1; index >= 0; index--) {
      pending.push({ value: entries[index][1], depth: current.depth + 1 });
    }
  }
  return { names, limits: state.limits };
}

function parameters(contract) {
  const values = [
    ...array(contract.pathParameters),
    ...array(object(contract.operation).parameters),
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
  if (!sameValue(before.pathParameters, after.pathParameters)) {
    values.push("pathParameters");
  }
  if (!sameValue(before.pathServers, after.pathServers)) {
    values.push("pathServers");
  }
  if (!sameValue(before.effectiveSecurity, after.effectiveSecurity)) {
    values.push("security");
  }
  if (!sameValue(before.securitySchemes, after.securitySchemes)) {
    values.push("securitySchemes");
  }
  if (!sameValue(before.externalReferences, after.externalReferences)) {
    values.push("externalReferences");
  }
  if (!sameValue(before.unresolvedReferences, after.unresolvedReferences)) {
    values.push("unresolvedReferences");
  }
  if (!sameValue(before.referenceExpansionLimits, after.referenceExpansionLimits)) {
    values.push("referenceExpansionLimits");
  }
  for (const field of new Set([...Object.keys(beforeOperation), ...Object.keys(afterOperation)])) {
    if (!sameValue(beforeOperation[field], afterOperation[field])) {
      values.push(field);
    }
  }
  return [...new Set(values)].sort();
}

function typeSet(schema) {
  const value = schema?.type;
  const types = new Set(Array.isArray(value) ? value : typeof value === "string" ? [value] : []);
  // JSON Schema's number domain includes integers.
  if (types.has("number")) types.add("integer");
  return types;
}

function setContains(container, values) {
  for (const value of values) if (!container.has(value)) return false;
  return true;
}

function schemaDirectionalBreak(
  beforeSchema,
  afterSchema,
  direction,
  location,
  seen = new WeakMap(),
) {
  const before = object(beforeSchema);
  const after = object(afterSchema);
  let compared = seen.get(before);
  if (compared?.has(after)) return null;
  if (!compared) {
    compared = new WeakSet();
    seen.set(before, compared);
  }
  compared.add(after);
  const beforeTypes = typeSet(before);
  const afterTypes = typeSet(after);
  if (beforeTypes.size && afterTypes.size) {
    const compatible =
      direction === "request"
        ? setContains(afterTypes, beforeTypes)
        : setContains(beforeTypes, afterTypes);
    if (!compatible) return { direction, location, reason: "type-domain-changed" };
  }
  if (Array.isArray(before.enum) && Array.isArray(after.enum)) {
    const beforeValues = new Set(before.enum.map((value) => structuralDigest(value)));
    const afterValues = new Set(after.enum.map((value) => structuralDigest(value)));
    const compatible =
      direction === "request"
        ? setContains(afterValues, beforeValues)
        : setContains(beforeValues, afterValues);
    if (!compatible) return { direction, location, reason: "enum-domain-changed" };
  }
  // Object-only keywords cannot narrow or widen a domain that excludes objects.
  if (
    (beforeTypes.size && !beforeTypes.has("object")) ||
    (afterTypes.size && !afterTypes.has("object"))
  )
    return null;
  const beforeRequired = new Set(array(before.required));
  const afterRequired = new Set(array(after.required));
  const incompatibleRequired =
    direction === "request"
      ? [...afterRequired].some((name) => !beforeRequired.has(name))
      : [...beforeRequired].some((name) => !afterRequired.has(name));
  if (incompatibleRequired) return { direction, location, reason: "required-properties-changed" };
  const beforeProperties = object(before.properties);
  const afterProperties = object(after.properties);
  for (const name of new Set([...Object.keys(beforeProperties), ...Object.keys(afterProperties)])) {
    if (!beforeProperties[name] || !afterProperties[name]) continue;
    const nested = schemaDirectionalBreak(
      beforeProperties[name],
      afterProperties[name],
      direction,
      `${location}.properties.${name}`,
      seen,
    );
    if (nested) return nested;
  }
  if (
    direction === "request" &&
    before.additionalProperties !== false &&
    after.additionalProperties === false
  ) {
    return { direction, location, reason: "additional-properties-disallowed" };
  }
  if (
    direction === "response" &&
    before.additionalProperties === false &&
    after.additionalProperties !== false
  ) {
    return { direction, location, reason: "additional-properties-allowed" };
  }
  return null;
}

function mediaSchemas(content) {
  return new Map(
    Object.entries(object(content)).map(([mediaType, media]) => [mediaType, object(media).schema]),
  );
}

function directionalOperationBreaks(beforeEntry, afterEntry) {
  const output = [];
  const beforeOperation = object(beforeEntry.contract.operation);
  const afterOperation = object(afterEntry.contract.operation);
  const beforeBody = mediaSchemas(object(beforeOperation.requestBody).content);
  const afterBody = mediaSchemas(object(afterOperation.requestBody).content);
  for (const [mediaType, schema] of beforeBody) {
    if (!afterBody.has(mediaType)) {
      output.push({
        kind: "request-media-type-removed",
        operation: afterEntry.key,
        mediaType,
      });
      continue;
    }
    const detail = schemaDirectionalBreak(
      schema,
      afterBody.get(mediaType),
      "request",
      "requestBody",
    );
    if (detail)
      output.push({ kind: "request-schema-narrowed", operation: afterEntry.key, ...detail });
  }
  const beforeResponses = object(beforeOperation.responses);
  const afterResponses = object(afterOperation.responses);
  for (const [status, response] of Object.entries(beforeResponses)) {
    if (!Object.hasOwn(afterResponses, status)) continue;
    const beforeContent = mediaSchemas(object(response).content);
    const afterContent = mediaSchemas(object(afterResponses[status]).content);
    for (const [mediaType, schema] of beforeContent) {
      if (!afterContent.has(mediaType)) {
        output.push({
          kind: "response-media-type-removed",
          operation: afterEntry.key,
          status,
          mediaType,
        });
        continue;
      }
      const detail = schemaDirectionalBreak(
        schema,
        afterContent.get(mediaType),
        "response",
        `responses.${status}`,
      );
      if (detail)
        output.push({
          kind: "response-schema-widened",
          operation: afterEntry.key,
          status,
          ...detail,
        });
    }
  }
  return output;
}

function allowsAnonymous(security) {
  const requirements = array(security);
  return (
    requirements.length === 0 ||
    requirements.some(
      (requirement) =>
        requirement &&
        typeof requirement === "object" &&
        !Array.isArray(requirement) &&
        Object.keys(requirement).length === 0,
    )
  );
}

function parameterContractBreak(before, after) {
  if (before.schema !== undefined && after.schema !== undefined) {
    return Boolean(schemaDirectionalBreak(before.schema, after.schema, "request", "parameter"));
  }
  // A change between schema and content encodings remains advisory: comparing
  // their raw objects cannot establish directional compatibility.
  if (!before.content || !after.content) return false;
  const beforeMedia = mediaSchemas(before.content);
  const afterMedia = mediaSchemas(after.content);
  for (const [mediaType, schema] of beforeMedia) {
    if (
      !afterMedia.has(mediaType) ||
      schemaDirectionalBreak(schema, afterMedia.get(mediaType), "request", "parameter")
    )
      return true;
  }
  return false;
}

function operationBreaks(beforeEntry, afterEntry) {
  const output = [];
  const before = beforeEntry.contract;
  const after = afterEntry.contract;
  if (allowsAnonymous(before.effectiveSecurity) && !allowsAnonymous(after.effectiveSecurity)) {
    output.push({ kind: "security-requirement-added", operation: afterEntry.key });
  }
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
      parameterContractBreak(previous, parameter)
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
  output.push(...directionalOperationBreaks(beforeEntry, afterEntry));
  return output;
}

function breakUncertaintyScopes(change) {
  if (change.kind.startsWith("security-")) return ["security"];
  if (change.kind.includes("parameter")) return ["parameters", "pathParameters"];
  if (change.kind.startsWith("request-")) return ["requestBody"];
  if (change.kind.startsWith("response-")) return ["responses"];
  return ["operation"];
}

function uncertaintyBlocksBreak(change, beforeEntry, afterEntry) {
  const scopes = new Set([
    ...(beforeEntry.uncertainScopes || []),
    ...(afterEntry.uncertainScopes || []),
  ]);
  if (["contract", "operation", "pathItem"].some((scope) => scopes.has(scope))) return true;
  return breakUncertaintyScopes(change).some((scope) => scopes.has(scope));
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
  const beforeIndex = baseline
    ? operationMap(baseline)
    : { operations: new Map(), pathUncertainties: new Map() };
  const afterIndex = operationMap(current);
  const before = beforeIndex.operations;
  const after = afterIndex.operations;
  const addedOperations = [];
  const removedOperations = [];
  const changedOperations = [];
  const breakingChanges = [];
  const potentiallyBreakingChanges = [];
  const uncertainties = [];

  for (const [side, index] of [
    ["baseline", beforeIndex],
    ["current", afterIndex],
  ]) {
    for (const [pathName, evidence] of index.pathUncertainties) {
      for (const reference of evidence.external) {
        uncertainties.push({
          kind: "external-reference-unresolved",
          side,
          path: pathName,
          reference,
        });
      }
      for (const reference of evidence.unresolved) {
        uncertainties.push({
          kind: "local-reference-unresolved",
          side,
          path: pathName,
          reference,
        });
      }
      for (const limit of evidence.limits) {
        uncertainties.push({
          kind: "reference-expansion-limited",
          side,
          path: pathName,
          limit,
        });
      }
    }
    const operations = index.operations;
    for (const entry of operations.values()) {
      const pathEvidence = index.pathUncertainties.get(entry.path);
      for (const reference of entry.contract.externalReferences || []) {
        if (pathEvidence?.external.has(reference)) continue;
        uncertainties.push({
          kind: "external-reference-unresolved",
          side,
          operation: entry.key,
          reference,
        });
      }
      for (const reference of entry.contract.unresolvedReferences || []) {
        if (pathEvidence?.unresolved.has(reference)) continue;
        uncertainties.push({
          kind: "local-reference-unresolved",
          side,
          operation: entry.key,
          reference,
        });
      }
      for (const limit of entry.contract.referenceExpansionLimits || []) {
        if (pathEvidence?.limits.has(limit)) continue;
        uncertainties.push({
          kind: "reference-expansion-limited",
          side,
          operation: entry.key,
          limit,
        });
      }
    }
  }

  for (const [key, entry] of after) {
    const previous = before.get(key);
    if (!previous) {
      if (!beforeIndex.pathUncertainties.has(entry.path)) {
        addedOperations.push(operationSummary(entry));
      }
      continue;
    }
    if (sameValue(previous.contract, entry.contract)) continue;
    const fields = changedFields(previous.contract, entry.contract);
    changedOperations.push({
      ...operationSummary(entry),
      changedFields: fields,
      beforeFingerprint: hash(previous.contract),
      afterFingerprint: hash(entry.contract),
    });
    const candidates = operationBreaks(previous, entry);
    const definite = candidates.filter(
      (change) => !uncertaintyBlocksBreak(change, previous, entry),
    );
    const blocked = candidates.filter((change) => uncertaintyBlocksBreak(change, previous, entry));
    breakingChanges.push(...definite);
    if (
      fields.includes("security") &&
      !definite.some((item) => item.kind.startsWith("security-"))
    ) {
      potentiallyBreakingChanges.push({
        kind: "security-requirement-changed",
        operation: key,
      });
    }
    if (fields.includes("securitySchemes")) {
      potentiallyBreakingChanges.push({ kind: "security-scheme-changed", operation: key });
    }
    if (
      fields.some((field) =>
        [
          "parameters",
          "pathParameters",
          "requestBody",
          "responses",
          "externalReferences",
          "unresolvedReferences",
          "referenceExpansionLimits",
        ].includes(field),
      ) &&
      (definite.length === 0 || blocked.length > 0)
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
      if (afterIndex.pathUncertainties.has(entry.path)) continue;
      removedOperations.push(operationSummary(entry));
      breakingChanges.push({ kind: "operation-removed", operation: key });
    }
  }

  const beforeSchemaIndex = baseline
    ? schemaMap(baseline)
    : { schemas: new Map(), limits: new Map() };
  const afterSchemaIndex = schemaMap(current);
  const beforeSchemas = beforeSchemaIndex.schemas;
  const afterSchemas = afterSchemaIndex.schemas;
  for (const [side, index] of [
    ["baseline", beforeSchemaIndex],
    ["current", afterSchemaIndex],
  ]) {
    for (const [schema, limits] of index.limits) {
      for (const limit of limits) {
        uncertainties.push({ kind: "contract-comparison-limited", side, schema, limit });
      }
    }
  }
  const beforeReferences = baseline
    ? referenceNames(baseline)
    : { names: new Set(), limits: new Set() };
  const afterReferences = referenceNames(current);
  for (const [side, evidence] of [
    ["baseline", beforeReferences],
    ["current", afterReferences],
  ]) {
    for (const limit of evidence.limits) {
      uncertainties.push({ kind: "reference-discovery-limited", side, limit });
    }
  }
  const references = new Set([...beforeReferences.names, ...afterReferences.names]);
  const addedSchemas = [];
  const removedSchemas = [];
  const changedSchemas = [];
  for (const [name, value] of afterSchemas) {
    if (!beforeSchemas.has(name)) addedSchemas.push(name);
    else if (!sameValue(beforeSchemas.get(name), value)) {
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
    schemaVersion: "1.1",
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
      uncertainties: uncertainties.length,
    },
    addedOperations,
    removedOperations,
    changedOperations,
    addedSchemas,
    removedSchemas,
    changedSchemas,
    breakingChanges,
    potentiallyBreakingChanges,
    uncertainties,
  };
}

module.exports = { compareOpenApiDocuments };
