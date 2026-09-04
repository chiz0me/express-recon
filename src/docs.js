"use strict";

const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { build: buildOpenApi } = require("./formatters/openapi");
const { discover } = require("./discover");
const { scanLimits } = require("./static/scan");
const { MODULE_EXTENSIONS, loadStaticDocumentModule } = require("./static/document-module");

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

function relative(root, file) {
  const value = path.relative(root, file).split(path.sep).join("/");
  return value || ".";
}

function within(root, file) {
  const value = path.relative(root, file);
  return value === "" || (value !== ".." && !value.startsWith(".." + path.sep));
}

function resolveInput(root, value, label, limits) {
  const file = path.resolve(root, value);
  if (!within(root, file)) throw new Error(`${label} must stay inside the scan root`);
  let realFile;
  let stat;
  try {
    realFile = fs.realpathSync(file);
    if (!within(root, realFile)) throw new Error("symbolic-link target leaves the scan root");
    stat = fs.statSync(realFile);
  } catch (err) {
    throw new Error(`Could not read ${label} ${file}: ${err.message}`);
  }
  if (!stat.isFile()) throw new Error(`${label} must name a file: ${realFile}`);
  if (limits && stat.size > limits.maxFileBytes) {
    throw new Error(
      `${label} ${realFile} is ${stat.size} bytes, exceeding scan.maxFileBytes (${limits.maxFileBytes})`,
    );
  }
  return realFile;
}

function parseData(text, file) {
  try {
    return path.extname(file).toLowerCase() === ".json" ? JSON.parse(text) : YAML.parse(text);
  } catch (err) {
    throw new Error(`Could not parse API documentation ${file}: ${err.message}`);
  }
}

function validateDocumentationTree(value, label, active = new Set(), depth = 0) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object") {
    throw new Error(`${label} contains a value that is not JSON-compatible`);
  }
  if (depth > 100) throw new Error(`${label} exceeds the maximum nesting depth (100)`);
  if (active.has(value)) throw new Error(`${label} contains a cyclic YAML alias`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} contains a non-JSON object`);
  }
  active.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    validateDocumentationTree(child, label, active, depth + 1);
  }
  active.delete(value);
}

function loadSpec(file, options = {}) {
  const limits = scanLimits(options);
  const size = fs.statSync(file).size;
  if (size > limits.maxFileBytes) {
    throw new Error(
      `API documentation ${file} is ${size} bytes, exceeding scan.maxFileBytes (${limits.maxFileBytes})`,
    );
  }
  const extension = path.extname(file).toLowerCase();
  const value = MODULE_EXTENSIONS.has(extension)
    ? loadStaticDocumentModule(file, {
        root: options.root || path.dirname(file),
        ...options,
      }).value
    : parseData(fs.readFileSync(file, "utf8"), file);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`API documentation ${file} must contain an object`);
  }
  validateDocumentationTree(value, `API documentation ${file}`);
  if (value.swagger && (!options.allowSwagger2 || value.swagger !== "2.0")) {
    throw new Error(
      value.swagger === "2.0"
        ? `Swagger 2 document ${file} cannot be merged safely; convert it to OpenAPI 3 first`
        : `API documentation ${file} uses unsupported Swagger version ${value.swagger}`,
    );
  }
  if (value.openapi && !/^3\.\d+\.\d+(?:[-+].*)?$/.test(value.openapi)) {
    throw new Error(`API documentation ${file} uses unsupported OpenAPI version ${value.openapi}`);
  }
  if (
    value.paths !== undefined &&
    (!value.paths || typeof value.paths !== "object" || Array.isArray(value.paths))
  ) {
    throw new Error(`API documentation ${file} has a non-object paths field`);
  }
  return value;
}

/**
 * Validate the minimal contract required by the offline Swagger UI renderer.
 * Swagger 2 is accepted for viewing even though reconciliation remains limited
 * to OpenAPI 3, keeping display and merge trust decisions separate.
 */
function describeRenderableSpecification(value, label = "API documentation") {
  const hasOpenApi = typeof value?.openapi === "string";
  const hasSwagger = typeof value?.swagger === "string";
  if (hasOpenApi && hasSwagger) {
    throw new Error(`${label} cannot declare both openapi and swagger versions`);
  }
  let format;
  let version;
  if (hasOpenApi) {
    if (!/^3\.\d+\.\d+(?:[-+].*)?$/.test(value.openapi)) {
      throw new Error(`${label} uses unsupported OpenAPI version ${value.openapi}`);
    }
    format = "openapi";
    version = value.openapi;
  } else if (hasSwagger) {
    if (value.swagger !== "2.0") {
      throw new Error(`${label} uses unsupported Swagger version ${value.swagger}`);
    }
    format = "swagger";
    version = value.swagger;
  } else {
    throw new Error(`${label} does not declare an OpenAPI or Swagger version`);
  }
  if (typeof value.info?.title !== "string" || !value.info.title.trim()) {
    throw new Error(`${label} requires info.title`);
  }
  if (!value.paths || typeof value.paths !== "object" || Array.isArray(value.paths)) {
    throw new Error(`${label} requires an object paths field`);
  }
  return { format, version, title: value.info.title.trim() };
}

function stripCommentLine(line) {
  return line.replace(/^\s*\* ?/, "").replace(/\s+$/, "");
}

function jsdocFragments(file, options = {}) {
  const limits = scanLimits(options);
  const size = fs.statSync(file).size;
  if (size > limits.maxFileBytes) {
    throw new Error(
      `JSDoc source ${file} is ${size} bytes, exceeding scan.maxFileBytes (${limits.maxFileBytes})`,
    );
  }
  const code = fs.readFileSync(file, "utf8");
  const fragments = [];
  const comment = /\/\*\*([\s\S]*?)\*\//g;
  let match;
  while ((match = comment.exec(code))) {
    const body = match[1].split(/\r?\n/).map(stripCommentLine);
    const marker = body.findIndex((line) => /^\s*@(openapi|swagger)\b/.test(line));
    if (marker < 0) continue;
    const markerColumn = body[marker].search(/@(?:openapi|swagger)\b/);
    const inline = body[marker].replace(/^\s*@(openapi|swagger)\b\s*/, "");
    const yaml = [inline, ...body.slice(marker + 1)]
      .filter((line, index) => index > 0 || line)
      .join("\n");
    const before = code.slice(0, match.index);
    const line = before.split(/\r?\n/).length + marker + 1;
    let value;
    try {
      value = YAML.parse(yaml);
    } catch (err) {
      throw new Error(`Could not parse JSDoc block ${file}:${line}: ${err.message}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`JSDoc block ${file}:${line} must contain an object`);
    }
    validateDocumentationTree(value, `JSDoc block ${file}:${line}`);
    const directPaths = Object.keys(value).some((key) => key.startsWith("/"));
    fragments.push({
      value: directPaths ? { paths: value } : value,
      source: { file, line, column: Math.max(1, markerColumn + 1) },
    });
  }
  return fragments;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pointerSegment(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function pointerParts(pointer) {
  return pointer
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function removePointer(document, pointer) {
  const parts = pointerParts(pointer);
  const key = parts.pop();
  let parent = document;
  for (const part of parts) {
    if (!isObject(parent) || !Object.hasOwn(parent, part)) return;
    parent = parent[part];
  }
  if (isObject(parent) && key !== undefined) delete parent[key];
}

function stripPreviouslyGenerated(document) {
  const metadata = document?.["x-express-recon"];
  const reconciliation = metadata?.reconciliation;
  const currentMarker =
    reconciliation?.tool === "express-recon" && reconciliation?.schemaVersion === "1.0";
  const legacyMarker = metadata?.generated === true && metadata?.tool === "express-recon";
  if (!currentMarker && !legacyMarker) return document;
  const fields = reconciliation?.generatedFields;
  if (!Array.isArray(fields) || fields.some((field) => typeof field !== "string")) return document;
  // Parents are recorded instead of their descendants when an entire object
  // was generated, so descending length is defensive for hand-edited output.
  for (const pointer of fields.slice().sort((a, b) => b.length - a.length)) {
    removePointer(document, pointer);
  }
  return document;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nullSchema(value) {
  return (
    isObject(value) &&
    (value.type === "null" ||
      value.const === null ||
      (value.enum?.length === 1 && value.enum[0] === null))
  );
}

function openApi30Schema(value) {
  if (!isObject(value)) return clone(value);
  const output = clone(value);
  const schemaMaps = ["properties"];
  const schemaValues = ["additionalProperties", "items", "not"];
  const schemaArrays = ["allOf", "oneOf"];
  for (const field of schemaMaps) {
    if (isObject(output[field])) {
      output[field] = Object.fromEntries(
        Object.entries(output[field]).map(([name, schema]) => [name, openApi30Schema(schema)]),
      );
    }
  }
  for (const field of schemaValues) {
    if (isObject(output[field])) output[field] = openApi30Schema(output[field]);
  }
  for (const field of schemaArrays) {
    if (Array.isArray(output[field])) output[field] = output[field].map(openApi30Schema);
  }

  if (Object.hasOwn(output, "const")) {
    output.enum ||= [clone(output.const)];
    delete output.const;
  }
  if (Array.isArray(output.type)) {
    const types = [...new Set(output.type)];
    const nonNull = types.filter((type) => type !== "null");
    if (types.length !== nonNull.length) output.nullable = true;
    if (nonNull.length === 1) output.type = nonNull[0];
    else {
      delete output.type;
      if (nonNull.length > 1) {
        output.oneOf = [...(output.oneOf || []), ...nonNull.map((type) => ({ type }))];
      }
    }
  } else if (output.type === "null") {
    delete output.type;
    output.nullable = true;
    output.enum ||= [null];
  }

  if (Array.isArray(value.anyOf)) {
    const permitsNull = value.anyOf.some(nullSchema);
    const alternatives = value.anyOf.filter((schema) => !nullSchema(schema)).map(openApi30Schema);
    if (permitsNull && alternatives.length === 1) {
      delete output.anyOf;
      for (const [key, child] of Object.entries(alternatives[0])) {
        if (!Object.hasOwn(output, key)) output[key] = child;
      }
      output.nullable = true;
    } else if (alternatives.length === 0) {
      delete output.anyOf;
      if (permitsNull) {
        output.nullable = true;
        output.enum ||= [null];
      }
    } else {
      output.anyOf = permitsNull
        ? alternatives.map((schema) => ({ ...schema, nullable: true }))
        : alternatives;
    }
  }

  if (Array.isArray(value.prefixItems)) {
    const items = value.prefixItems.map(openApi30Schema);
    delete output.prefixItems;
    output.items = items.length === 0 ? {} : items.length === 1 ? items[0] : { oneOf: items };
    output.minItems ??= items.length;
    output.maxItems ??= items.length;
  }
  return output;
}

function adaptGeneratedOpenApi30(document) {
  const output = clone(document);
  const schemas = output.components?.schemas;
  if (isObject(schemas)) {
    output.components.schemas = Object.fromEntries(
      Object.entries(schemas).map(([name, schema]) => [name, openApi30Schema(schema)]),
    );
  }
  for (const operation of operations(output).values()) {
    for (const parameter of operation.parameters || []) {
      if (isObject(parameter.schema)) parameter.schema = openApi30Schema(parameter.schema);
      for (const media of Object.values(parameter.content || {})) {
        if (isObject(media?.schema)) media.schema = openApi30Schema(media.schema);
      }
    }
    for (const media of Object.values(operation.requestBody?.content || {})) {
      if (isObject(media?.schema)) media.schema = openApi30Schema(media.schema);
    }
    for (const response of Object.values(operation.responses || {})) {
      for (const media of Object.values(response?.content || {})) {
        if (isObject(media?.schema)) media.schema = openApi30Schema(media.schema);
      }
      for (const header of Object.values(response?.headers || {})) {
        if (isObject(header?.schema)) header.schema = openApi30Schema(header.schema);
      }
    }
  }
  return output;
}

function namedTagArray(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (item) => isObject(item) && typeof item.name === "string" && item.name.trim().length > 0,
    )
  );
}

function mergeTopLevelTags(target, incoming, context, pointer) {
  const byName = new Map(target.map((tag, index) => [tag.name, { tag, index }]));
  for (const incomingTag of incoming) {
    const existing = byName.get(incomingTag.name);
    if (existing) {
      fillMissing(existing.tag, incomingTag, context, `${pointer}/${existing.index}`);
      continue;
    }
    const index = target.length;
    const added = clone(incomingTag);
    target.push(added);
    byName.set(added.name, { tag: added, index });
    if (context.addedPointers) context.addedPointers.push(`${pointer}/${index}`);
  }
}

/**
 * Fill missing fields without changing higher-precedence authored values.
 * Conflicts are recorded only within authored layers (base OpenAPI/JSDoc), not
 * when generated placeholders differ from authored prose or schemas.
 */
function fillMissing(target, incoming, context, pointer = "") {
  for (const key of Object.keys(incoming).sort()) {
    const nextPointer = `${pointer}/${pointerSegment(key)}`;
    if (!Object.hasOwn(target, key)) {
      Object.defineProperty(target, key, {
        value: clone(incoming[key]),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      if (context.addedPointers) context.addedPointers.push(nextPointer);
      continue;
    }
    if (nextPointer === "/tags" && namedTagArray(target[key]) && namedTagArray(incoming[key])) {
      mergeTopLevelTags(target[key], incoming[key], context, nextPointer);
      continue;
    }
    if (isObject(target[key]) && isObject(incoming[key])) {
      fillMissing(target[key], incoming[key], context, nextPointer);
      continue;
    }
    if (context.recordConflicts && !sameValue(target[key], incoming[key])) {
      context.conflicts.push({
        pointer: nextPointer,
        keptLayer: context.keptLayer,
        ignoredLayer: context.incomingLayer,
        keptSource: context.keptSource,
        ignoredSource: context.incomingSource,
        keptValue: clone(target[key]),
        ignoredValue: clone(incoming[key]),
      });
    }
  }
  return target;
}

function operations(document) {
  const output = new Map();
  for (const pathName of Object.keys(document?.paths || {}).sort()) {
    const item = document.paths[pathName];
    if (!isObject(item)) continue;
    for (const method of Object.keys(item).sort()) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || !isObject(item[method])) continue;
      output.set(`${method.toUpperCase()} ${pathName}`, item[method]);
    }
  }
  return output;
}

function applicationSelectionError(message, ids) {
  const error = new Error(message);
  error.code = "APPLICATION_SELECTION_REQUIRED";
  error.applicationIds = ids;
  return error;
}

function selectApplication(report, requested, discovery, specification) {
  const ids = (report.applications || []).map((application) => application.id).sort();
  const discovered = new Map(
    (discovery.applications || []).map((application) => [application.id, application]),
  );
  const metadata = (id) => discovered.get(id) || {};
  if (requested === "all") return { id: "all", ids, reason: "explicit-all", packageId: null };
  if (requested) {
    if (!ids.includes(requested)) {
      throw new Error(
        `Unknown application ID ${JSON.stringify(requested)}; found: ${ids.join(", ") || "none"}`,
      );
    }
    return {
      id: requested,
      ids: [requested],
      reason: "explicit",
      packageId: metadata(requested).packageId || null,
    };
  }
  if (specification?.packageId) {
    const matching = ids.filter(
      (id) => metadata(id).packageId && metadata(id).packageId === specification.packageId,
    );
    if (matching.length === 1) {
      return {
        id: matching[0],
        ids: matching,
        reason: "documentation-package",
        packageId: specification.packageId,
      };
    }
    if (matching.length === 0 && ids.length > 0) {
      const knownPackages = ids.map((id) => metadata(id).packageId).filter(Boolean);
      if (knownPackages.length === ids.length) {
        throw applicationSelectionError(
          `OpenAPI document ${JSON.stringify(specification.path)} belongs to ${specification.packageId}, ` +
            `but the detected application package(s) are ${[...new Set(knownPackages)].join(", ")}. ` +
            "Choose --app-id <id> to confirm an intentional cross-package merge.",
          ids,
        );
      }
    }
  }
  if (!specification?.packageId && specification && ids.length === 1) {
    const applicationPackageId = metadata(ids[0]).packageId;
    if (applicationPackageId) {
      const applicationPackage = (discovery.packages || []).find(
        (item) => item.id === applicationPackageId,
      );
      throw applicationSelectionError(
        `OpenAPI document ${JSON.stringify(specification.path)} is outside the detected ` +
          `application package ${applicationPackage?.root || applicationPackageId}. ` +
          "Choose --app-id <id> to confirm an intentional cross-package merge.",
        ids,
      );
    }
  }
  if (ids.length === 1) {
    return {
      id: ids[0],
      ids,
      reason: "single-application",
      packageId: metadata(ids[0]).packageId || null,
    };
  }
  if (ids.length > 1) {
    throw applicationSelectionError(
      `Multiple applications were found; choose --app-id <id> or use --app-id all intentionally. Found: ${ids.join(", ")}`,
      ids,
    );
  }
  return { id: null, ids: [], reason: "no-application", packageId: null };
}

function selectReport(report, selection) {
  const ids = new Set(selection.ids);
  const routes = report.routes.filter((route) => {
    if (selection.id === "all") return true;
    if (selection.id === null) return route.applicationId === null;
    return ids.has(route.applicationId);
  });
  const applications = (report.applications || []).filter((application) => ids.has(application.id));
  return { ...report, routes, applications };
}

function packageForPath(discovery, file) {
  const normalized = file.split(path.sep).join("/").replace(/^\.\//, "");
  const owner = (discovery.packages || [])
    .filter((item) => {
      const root = item.root === "." ? "" : item.root.replace(/\/$/, "");
      return root === "" || normalized === root || normalized.startsWith(`${root}/`);
    })
    .sort((left, right) => right.root.length - left.root.length)[0];
  return owner?.id || null;
}

function autoSpec(root, opts, discovery, limits) {
  if (opts.spec) {
    const file = resolveInput(root, opts.spec, "--spec", limits);
    const relativeFile = relative(root, file);
    const discovered = discovery.documentation.specifications.find(
      (item) => item.path === relativeFile,
    );
    return {
      file,
      path: relativeFile,
      packageId: discovered?.packageId || packageForPath(discovery, relativeFile),
      format: discovered?.format || null,
    };
  }
  const candidates = discovery.documentation.specifications.filter(
    (item) =>
      item.format === "openapi" ||
      item.format === "candidate" ||
      item.format === "openapi-module" ||
      item.format === "openapi-module-candidate",
  );
  if (candidates.length > 1) {
    throw new Error(
      `Multiple OpenAPI documents were found; choose --spec <path>. Found: ${candidates.map((item) => item.path).join(", ")}`,
    );
  }
  if (candidates.length !== 1) return null;
  return {
    ...candidates[0],
    file: resolveInput(root, candidates[0].path, "discovered spec", limits),
  };
}

function selectedJSDoc(root, opts, discovery, limits) {
  if (opts.disableAutoJSDoc === true && !opts.jsdoc?.length) return [];
  const values = opts.jsdoc?.length ? opts.jsdoc : discovery.documentation.jsdoc;
  return [...new Set(values.map((value) => resolveInput(root, value, "--jsdoc", limits)))].sort();
}

function normalizeSource(root, source) {
  return source ? { ...source, file: relative(root, source.file) } : null;
}

function routeGraphUncertainty(report, selection) {
  const fallbackOrphans = (report.routes || []).filter(
    (route) => route.applicationId === null,
  ).length;
  const orphanRoutes = report.routeGraph?.orphanRoutes ?? fallbackOrphans;
  const partialRoutes = (report.routes || []).filter(
    (route) =>
      route.pathConfidence === "partial" &&
      (selection.id === "all" || route.applicationId === selection.id),
  ).length;
  const opaqueMounts = (report.routeGraph?.opaqueMounts || []).filter(
    (mount) =>
      selection.id === "all" ||
      mount.applicationId === null ||
      mount.applicationId === selection.id,
  );
  return {
    incomplete: orphanRoutes > 0 || partialRoutes > 0 || opaqueMounts.length > 0,
    orphanRoutes,
    partialRoutes,
    registrarRoutes: report.routeGraph?.registrarRoutes || 0,
    opaqueMounts,
  };
}

function operationPath(operation) {
  const separator = operation.indexOf(" ");
  return separator < 0 ? operation : operation.slice(separator + 1);
}

function underOpaqueMount(operation, mount) {
  if (mount.pathConfidence !== "full" || !mount.path) return true;
  const documentedPath = operationPath(operation);
  const wildcard = mount.path.indexOf("*");
  const rawPrefix = wildcard < 0 ? mount.path : mount.path.slice(0, wildcard);
  const prefix = rawPrefix.length > 1 ? rawPrefix.replace(/\/$/, "") : rawPrefix;
  return prefix === "/" || documentedPath === prefix || documentedPath.startsWith(`${prefix}/`);
}

/**
 * Merge authored OpenAPI, swagger-jsdoc blocks, and an inventory report using
 * deterministic precedence. Repository JavaScript is parsed as data and is
 * never imported or executed by this path.
 */
function reconcileDocumentation(report, opts = {}) {
  const root = fs.realpathSync(path.resolve(opts.root || process.cwd()));
  const limits = scanLimits(opts.scan || {});
  const deadline = Date.now() + limits.timeoutMs;
  const discovery = opts.discovery || discover(root, opts.scan || {});
  const specification = autoSpec(root, opts, discovery, limits);
  const selection = selectApplication(report, opts.applicationId, discovery, specification);
  const scopedReport = selectReport(report, selection);
  const generated = buildOpenApi(scopedReport);
  const specFile = specification?.file || null;
  const jsdocFiles = selectedJSDoc(root, opts, discovery, limits);
  const inputFiles = [...new Set([...(specFile ? [specFile] : []), ...jsdocFiles])];
  if (inputFiles.length > limits.maxFiles) {
    throw new Error(
      `API documentation inputs exceed scan.maxFiles (${limits.maxFiles}); narrow --jsdoc inputs`,
    );
  }
  const inputBytes = inputFiles.reduce((total, file) => total + fs.statSync(file).size, 0);
  if (inputBytes > limits.maxTotalBytes) {
    throw new Error(
      `API documentation inputs total ${inputBytes} bytes, exceeding scan.maxTotalBytes (${limits.maxTotalBytes})`,
    );
  }
  const base = specFile
    ? stripPreviouslyGenerated(clone(loadSpec(specFile, { ...limits, root })))
    : {};
  const conflicts = [];
  const merged = clone(base);
  const jsdoc = {};
  let jsdocBlockCount = 0;
  for (const file of jsdocFiles) {
    if (Date.now() >= deadline) {
      throw new Error(
        `API documentation reconciliation exceeded scan.timeoutMs (${limits.timeoutMs}ms)`,
      );
    }
    for (const fragment of jsdocFragments(file, limits)) {
      jsdocBlockCount++;
      fillMissing(jsdoc, fragment.value, {
        conflicts,
        recordConflicts: true,
        keptLayer: "jsdoc",
        incomingLayer: "jsdoc",
        keptSource: null,
        incomingSource: normalizeSource(root, fragment.source),
      });
    }
  }
  fillMissing(merged, jsdoc, {
    conflicts,
    recordConflicts: true,
    keptLayer: "base",
    incomingLayer: "jsdoc",
    keptSource: specFile ? { file: relative(root, specFile) } : null,
    incomingSource: { files: jsdocFiles.map((file) => relative(root, file)) },
  });
  const generatedForMerge = merged.openapi?.startsWith("3.0.")
    ? adaptGeneratedOpenApi30(generated)
    : generated;
  const generatedFields = [];
  fillMissing(merged, generatedForMerge, {
    conflicts,
    recordConflicts: false,
    keptLayer: specFile ? "base" : "jsdoc",
    incomingLayer: "generated",
    addedPointers: generatedFields,
  });

  if (!merged.openapi) merged.openapi = "3.1.0";
  if (!merged.info) merged.info = generated.info;
  if (!merged.paths) merged.paths = {};

  const codeOps = operations(generatedForMerge);
  const baseOps = operations(base);
  const jsdocOps = operations(jsdoc);
  const authoredKeys = new Set([...baseOps.keys(), ...jsdocOps.keys()]);
  const codeKeys = new Set(codeOps.keys());
  const codeOnlyOperations = [...codeKeys].filter((key) => !authoredKeys.has(key)).sort();
  const docsOnlyOperations = [...authoredKeys].filter((key) => !codeKeys.has(key)).sort();
  const documentedOperations = [...codeKeys].filter((key) => authoredKeys.has(key)).sort();
  const schemaConflicts = [...codeOps.entries()].flatMap(([operation, value]) =>
    (value["x-express-recon"]?.schemaConflicts || []).map((conflict) => ({
      operation,
      ...conflict,
    })),
  );
  const dynamicOperations = [...codeOps.keys()].filter((key) => key.includes("{dynamic}"));
  const duplicateOperations = generated["x-express-recon"]?.duplicateOperations || [];
  const pathVariantTruncations = generated["x-express-recon"]?.pathVariantTruncations || [];
  const graph = routeGraphUncertainty(report, selection);
  const incompleteInventory = report.scanCoverage?.complete === false || graph.incomplete;
  const incompleteDocumentationDiscovery =
    discovery.complete === false || discovery.discoveryCoverage?.complete === false;
  const unverifiedDocsOnlyOperations = docsOnlyOperations.filter(
    (operation) =>
      graph.orphanRoutes > 0 ||
      graph.opaqueMounts.some((mount) => underOpaqueMount(operation, mount)),
  );
  const unverifiedDocsOnly = new Set(unverifiedDocsOnlyOperations);
  const verifiedDocsOnlyOperations = docsOnlyOperations.filter(
    (operation) => !unverifiedDocsOnly.has(operation),
  );

  const reconciliation = {
    schemaVersion: "1.0",
    applicationId: selection.id,
    precedence: ["base", "jsdoc", "generated"],
    sources: {
      base: specFile ? relative(root, specFile) : null,
      basePackageId: specification?.packageId || null,
      jsdoc: jsdocFiles.map((file) => relative(root, file)),
      jsdocBlocks: jsdocBlockCount,
    },
    selection: {
      reason: selection.reason,
      applicationPackageId: selection.packageId,
      documentationPackageId: specification?.packageId || null,
    },
    summary: {
      codeOperations: codeKeys.size,
      authoredOperations: authoredKeys.size,
      documentedOperations: documentedOperations.length,
      codeOnlyOperations: codeOnlyOperations.length,
      docsOnlyOperations: docsOnlyOperations.length,
      verifiedDocsOnlyOperations: verifiedDocsOnlyOperations.length,
      unverifiedDocsOnlyOperations: unverifiedDocsOnlyOperations.length,
      conflicts: conflicts.length + schemaConflicts.length,
      authoredConflicts: conflicts.length,
      schemaConflicts: schemaConflicts.length,
      dynamicOperations: dynamicOperations.length,
      duplicateOperations: duplicateOperations.length,
      pathVariantTruncations: pathVariantTruncations.length,
      incompleteInventory,
      incompleteDocumentationDiscovery,
    },
    codeOnlyOperations,
    docsOnlyOperations,
    verifiedDocsOnlyOperations,
    unverifiedDocsOnlyOperations,
    documentedOperations,
    conflicts,
    schemaConflicts,
    dynamicOperations: dynamicOperations.sort(),
    duplicateOperations,
    pathVariantTruncations,
    scanCoverage: report.scanCoverage || null,
    routeGraph: {
      complete: !graph.incomplete,
      orphanRoutes: graph.orphanRoutes,
      partialRoutes: graph.partialRoutes,
      registrarRoutes: graph.registrarRoutes,
      opaqueMounts: graph.opaqueMounts,
    },
    diagnostics: [...new Set([...(discovery.diagnostics || []), ...(report.diagnostics || [])])],
  };
  merged["x-express-recon"] = {
    ...(isObject(merged["x-express-recon"]) ? merged["x-express-recon"] : {}),
    reconciliation: {
      tool: "express-recon",
      schemaVersion: "1.0",
      applicationId: selection.id,
      summary: reconciliation.summary,
      report: "docs-report.json",
      generatedFields: generatedFields.sort(),
    },
  };
  return { document: merged, report: reconciliation };
}

module.exports = {
  describeRenderableSpecification,
  jsdocFragments,
  loadSpec,
  operations,
  reconcileDocumentation,
};
