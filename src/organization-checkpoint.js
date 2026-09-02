"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const pkg = require("../package.json");
const { COMPLETE_REPOSITORY_STATUSES } = require("./frameworks");

const CHECKPOINT_FILENAME = "organization-checkpoint.json";
const CHECKPOINT_KIND = "github-organization-scan-checkpoint";
const CHECKPOINT_SCHEMA_VERSION = "1.0";
// Bump this whenever previously completed repository evidence is no longer safe
// to reuse. Add only audited pre-generation releases to the legacy allowlist.
const CHECKPOINT_COMPATIBILITY_VERSION = "3";
const LEGACY_COMPATIBLE_TOOL_VERSIONS = new Set(["0.6.0", "0.7.0", "0.7.1", "0.7.2"]);
const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;

function canonical(value, seen = new Set()) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") {
    if (["function", "symbol", "bigint"].includes(typeof value)) {
      throw new Error(`resume fingerprint cannot represent ${typeof value} values`);
    }
    return value;
  }
  if (seen.has(value)) throw new Error("resume fingerprint cannot represent cyclic values");
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((item) => canonical(item, seen) ?? null)
    : Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key], seen)])
          .filter(([, normalized]) => normalized !== undefined),
      );
  seen.delete(value);
  return result;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function externalIgnoreIdentity(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`Could not fingerprint external scan ignore file ${file}: ${err.message}`);
  }
  return {
    external: true,
    name: path.basename(file),
    sha256: sha256(text),
  };
}

function checkpointConfig(config) {
  const normalized = canonical(config || {});
  const ignoreFile = normalized.scan?.ignoreFile;
  if (typeof ignoreFile === "string" && path.isAbsolute(ignoreFile)) {
    normalized.scan.ignoreFile = externalIgnoreIdentity(ignoreFile);
  }
  return normalized;
}

function checkpointScan(scan) {
  const normalized = canonical(scan || {});
  const ignoreFile = normalized.ignoreFile;
  if (typeof ignoreFile === "string" && path.isAbsolute(ignoreFile)) {
    normalized.ignoreFile = externalIgnoreIdentity(ignoreFile);
  }
  return normalized;
}

function checkpointFingerprint(scope, compatibilityVersion = CHECKPOINT_COMPATIBILITY_VERSION) {
  return sha256(
    JSON.stringify(
      canonical({
        checkpointSchemaVersion: CHECKPOINT_SCHEMA_VERSION,
        checkpointCompatibilityVersion: compatibilityVersion,
        ...scope,
      }),
    ),
  );
}

function legacyCheckpointFingerprint(scope, toolVersion) {
  return sha256(
    JSON.stringify(
      canonical({
        checkpointSchemaVersion: CHECKPOINT_SCHEMA_VERSION,
        toolVersion,
        ...scope,
      }),
    ),
  );
}

function organizationCheckpointIdentity(organization, options) {
  const configHash = sha256(JSON.stringify(checkpointConfig(options.config)));
  const scanHash = sha256(JSON.stringify(checkpointScan(options.scan)));
  const scope = {
    organization: organization.toLowerCase(),
    maxRepositories: options.maxRepositories,
    includeArchived: options.includeArchived === true,
    includeForks: options.includeForks === true,
    repositoryInclude: canonical(options.repositoryInclude || []),
    repositoryExclude: canonical(options.repositoryExclude || []),
    configHash,
    scanHash,
  };
  return {
    compatibilityVersion: CHECKPOINT_COMPATIBILITY_VERSION,
    fingerprint: checkpointFingerprint(scope),
    scopeFingerprint: sha256(JSON.stringify(canonical(scope))),
    scope,
  };
}

function checkpointPath(outDir) {
  return path.join(outDir, CHECKPOINT_FILENAME);
}

function initialCheckpoint(organization, identity) {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    kind: CHECKPOINT_KIND,
    tool: "express-recon",
    toolVersion: pkg.version,
    compatibilityVersion: identity.compatibilityVersion,
    organization,
    fingerprint: identity.fingerprint,
    scope: identity.scope,
    completed: [],
  };
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } catch (err) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
    throw new Error(`Could not persist organization checkpoint: ${err.message}`);
  }
}

function safeRelativeArtifact(value) {
  if (typeof value !== "string" || !value || value.includes("\\")) return false;
  if (path.posix.isAbsolute(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

function resolveArtifact(outDir, relative) {
  if (!safeRelativeArtifact(relative)) {
    throw new Error(`checkpoint contains unsafe artifact path ${JSON.stringify(relative)}`);
  }
  const resolved = path.resolve(outDir, ...relative.split("/"));
  const relation = path.relative(outDir, resolved);
  if (relation === ".." || relation.startsWith(".." + path.sep) || path.isAbsolute(relation)) {
    throw new Error(`checkpoint artifact escapes the output directory: ${relative}`);
  }
  return resolved;
}

function fileIntegrity(outDir, relative) {
  const file = resolveArtifact(outDir, relative);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    throw new Error(`artifact ${relative} is unavailable: ${err.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`artifact ${relative} must be a regular file`);
  }
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const descriptor = fs.openSync(file, "r");
  try {
    let bytes;
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return { path: relative, bytes: stat.size, sha256: hash.digest("hex") };
}

function artifactPaths(artifacts) {
  const paths = [];
  for (const [name, value] of Object.entries(artifacts)) {
    if (name !== "specifications") {
      if (typeof value !== "string") throw new Error(`artifact ${name} must be a path`);
      paths.push(value);
      continue;
    }
    if (!Array.isArray(value)) throw new Error("specification artifacts must be an array");
    for (const specification of value) {
      if (!specification || typeof specification !== "object" || Array.isArray(specification)) {
        throw new Error("specification artifact must be an object");
      }
      if (typeof specification.artifact !== "string") {
        throw new Error("specification artifact is missing its source path");
      }
      paths.push(specification.artifact);
      const reconciliation = specification.reconciliation;
      if (reconciliation?.artifact !== undefined) paths.push(reconciliation.artifact);
      if (reconciliation?.reportArtifact !== undefined) paths.push(reconciliation.reportArtifact);
    }
  }
  return [...new Set(paths)].sort();
}

function checkpointEntry(payload, artifacts, outDir) {
  if (payload.coverageComplete !== true || !COMPLETE_REPOSITORY_STATUSES.has(payload.status)) {
    return null;
  }
  const commit = payload.scan.repository?.commit;
  if (typeof commit !== "string" || !/^[a-f0-9]{40,64}$/.test(commit)) {
    throw new Error("Completed repository scan did not return a valid Git object id");
  }
  const files = artifactPaths(artifacts).map((file) => fileIntegrity(outDir, file));
  return {
    repository: payload.repository,
    status: payload.status,
    scanned: true,
    express: payload.express,
    ...(payload.frameworks ? { frameworks: payload.frameworks } : {}),
    coverageComplete: true,
    routeGraphComplete:
      payload.routeGraphComplete ?? payload.scan.inventory?.routeGraph?.complete !== false,
    command: payload.scan.inventory?.command || "inventory",
    auditSummary: payload.scan.inventory?.summary || null,
    commit,
    artifacts,
    files,
  };
}

function withCompleted(checkpoint, entry) {
  const completed = new Map(
    checkpoint.completed.map((item) => [item.repository.fullName.toLowerCase(), item]),
  );
  completed.set(entry.repository.fullName.toLowerCase(), entry);
  return {
    ...checkpoint,
    completed: [...completed.values()].sort((left, right) =>
      left.repository.fullName < right.repository.fullName
        ? -1
        : left.repository.fullName > right.repository.fullName
          ? 1
          : 0,
    ),
  };
}

function readCheckpointFile(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    throw new Error(`Could not read organization checkpoint ${file}: ${err.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Organization checkpoint must be a regular file: ${file}`);
  }
  if (stat.size > MAX_CHECKPOINT_BYTES) {
    throw new Error("Organization checkpoint exceeds the 16 MiB limit");
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Could not parse organization checkpoint ${file}: ${err.message}`);
  }
}

function validateCheckpointShape(value, organization, identity) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Organization checkpoint must contain an object");
  }
  if (
    value.schemaVersion !== CHECKPOINT_SCHEMA_VERSION ||
    value.kind !== CHECKPOINT_KIND ||
    value.tool !== "express-recon"
  ) {
    throw new Error("Organization checkpoint has an unsupported contract");
  }
  if (
    typeof value.organization !== "string" ||
    value.organization.toLowerCase() !== organization.toLowerCase()
  ) {
    throw new Error(
      `Organization checkpoint belongs to ${value.organization}, not ${organization}`,
    );
  }
  const current =
    value.compatibilityVersion === CHECKPOINT_COMPATIBILITY_VERSION &&
    value.fingerprint === identity.fingerprint;
  const legacy =
    value.compatibilityVersion === undefined &&
    LEGACY_COMPATIBLE_TOOL_VERSIONS.has(value.toolVersion) &&
    value.fingerprint === legacyCheckpointFingerprint(identity.scope, value.toolVersion);
  if (!current && !legacy) {
    throw new Error(
      "Organization checkpoint does not match this checkpoint compatibility version, configuration, scan scope, or repository limit",
    );
  }
  if (!Array.isArray(value.completed)) {
    throw new Error("Organization checkpoint completed must be an array");
  }
  return { legacy };
}

function resumableEntries(checkpoint, outDir) {
  const entries = [];
  const diagnostics = [];
  const names = new Set();
  for (const [index, entry] of checkpoint.completed.entries()) {
    const label = `checkpoint.completed[${index}]`;
    const fullName = entry?.repository?.fullName;
    if (
      typeof fullName !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName) ||
      names.has(fullName.toLowerCase())
    ) {
      throw new Error(`${label} has an invalid or duplicate repository name`);
    }
    names.add(fullName.toLowerCase());
    if (
      !COMPLETE_REPOSITORY_STATUSES.has(entry.status) ||
      entry.coverageComplete !== true ||
      (entry.routeGraphComplete !== undefined && typeof entry.routeGraphComplete !== "boolean") ||
      !entry.express ||
      !["inventory", "audit"].includes(entry.command) ||
      !entry.artifacts ||
      typeof entry.artifacts !== "object" ||
      Array.isArray(entry.artifacts) ||
      !Array.isArray(entry.files)
    ) {
      throw new Error(`${label} is not a complete resumable entry`);
    }
    const documentation = entry.frameworks?.documentation || entry.express?.documentation || {};
    if (
      Number.isSafeInteger(documentation.specifications) &&
      documentation.specifications > 0 &&
      !Array.isArray(entry.artifacts.specifications)
    ) {
      diagnostics.push(
        `${fullName}: saved evidence predates retained specification catalogs; repository will be scanned again`,
      );
      continue;
    }
    const expectedPaths = artifactPaths(entry.artifacts);
    const recordedPaths = entry.files.map((file) => file?.path).sort();
    if (
      expectedPaths.length !== recordedPaths.length ||
      expectedPaths.some((file, fileIndex) => file !== recordedPaths[fileIndex])
    ) {
      throw new Error(`${label} artifact integrity records do not match its artifact paths`);
    }
    try {
      for (const expected of entry.files) {
        if (
          !expected ||
          !Number.isSafeInteger(expected.bytes) ||
          expected.bytes < 0 ||
          !/^[a-f0-9]{64}$/.test(expected.sha256)
        ) {
          throw new Error("contains an invalid integrity record");
        }
        const actual = fileIntegrity(outDir, expected.path);
        if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
          throw new Error(`artifact ${expected.path} failed its integrity check`);
        }
      }
      entries.push(entry);
    } catch (err) {
      diagnostics.push(`${fullName}: ${err.message}; repository will be scanned again`);
    }
  }
  return { entries, diagnostics };
}

function loadCheckpoint(file, organization, identity, outDir) {
  const source = readCheckpointFile(file);
  const compatibility = validateCheckpointShape(source, organization, identity);
  const unsafeLegacyEntries = compatibility.legacy
    ? source.completed.filter((entry) => entry.status !== "express")
    : [];
  const checkpoint = compatibility.legacy
    ? {
        ...source,
        toolVersion: pkg.version,
        compatibilityVersion: identity.compatibilityVersion,
        fingerprint: identity.fingerprint,
        scope: identity.scope,
        // A legacy positive Express result remains useful. A legacy negative
        // predates the Fastify/NestJS adapters and must be scanned again.
        completed: source.completed.filter((entry) => entry.status === "express"),
      }
    : source;
  const resume = resumableEntries(checkpoint, outDir);
  if (unsafeLegacyEntries.length) {
    resume.diagnostics.unshift(
      `${unsafeLegacyEntries.length} legacy non-Express checkpoint entr${unsafeLegacyEntries.length === 1 ? "y was" : "ies were"} invalidated so newly supported frameworks can be discovered`,
    );
  }
  return {
    checkpoint,
    migratedFromToolVersion: compatibility.legacy ? source.toolVersion : null,
    ...resume,
  };
}

module.exports = {
  CHECKPOINT_FILENAME,
  CHECKPOINT_COMPATIBILITY_VERSION,
  atomicWriteJson,
  checkpointEntry,
  checkpointPath,
  initialCheckpoint,
  loadCheckpoint,
  organizationCheckpointIdentity,
  withCompleted,
};
