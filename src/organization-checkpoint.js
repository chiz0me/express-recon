"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const pkg = require("../package.json");

const CHECKPOINT_FILENAME = "organization-checkpoint.json";
const CHECKPOINT_KIND = "github-organization-scan-checkpoint";
const CHECKPOINT_SCHEMA_VERSION = "1.0";
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

function organizationCheckpointIdentity(organization, options) {
  const configHash = sha256(JSON.stringify(checkpointConfig(options.config)));
  const scanHash = sha256(JSON.stringify(checkpointScan(options.scan)));
  const scope = {
    organization: organization.toLowerCase(),
    maxRepositories: options.maxRepositories,
    includeArchived: options.includeArchived === true,
    includeForks: options.includeForks === true,
    configHash,
    scanHash,
  };
  return {
    fingerprint: sha256(
      JSON.stringify(
        canonical({
          checkpointSchemaVersion: CHECKPOINT_SCHEMA_VERSION,
          toolVersion: pkg.version,
          ...scope,
        }),
      ),
    ),
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

function checkpointEntry(payload, artifacts, outDir) {
  if (payload.coverageComplete !== true || !["express", "not-express"].includes(payload.status)) {
    return null;
  }
  const commit = payload.scan.repository?.commit;
  if (typeof commit !== "string" || !/^[a-f0-9]{40,64}$/.test(commit)) {
    throw new Error("Completed repository scan did not return a valid Git object id");
  }
  const files = [...new Set(Object.values(artifacts))]
    .sort()
    .map((file) => fileIntegrity(outDir, file));
  return {
    repository: payload.repository,
    status: payload.status,
    scanned: true,
    express: payload.express,
    coverageComplete: true,
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
  if (value.fingerprint !== identity.fingerprint) {
    throw new Error(
      "Organization checkpoint does not match this tool version, configuration, scan scope, or repository limit",
    );
  }
  if (!Array.isArray(value.completed)) {
    throw new Error("Organization checkpoint completed must be an array");
  }
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
      !["express", "not-express"].includes(entry.status) ||
      entry.coverageComplete !== true ||
      !entry.express ||
      !["inventory", "audit"].includes(entry.command) ||
      !entry.artifacts ||
      typeof entry.artifacts !== "object" ||
      Array.isArray(entry.artifacts) ||
      !Array.isArray(entry.files)
    ) {
      throw new Error(`${label} is not a complete resumable entry`);
    }
    const expectedPaths = Object.values(entry.artifacts).sort();
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
  const checkpoint = readCheckpointFile(file);
  validateCheckpointShape(checkpoint, organization, identity);
  const resume = resumableEntries(checkpoint, outDir);
  return { checkpoint, ...resume };
}

module.exports = {
  CHECKPOINT_FILENAME,
  atomicWriteJson,
  checkpointEntry,
  checkpointPath,
  initialCheckpoint,
  loadCheckpoint,
  organizationCheckpointIdentity,
  withCompleted,
};
