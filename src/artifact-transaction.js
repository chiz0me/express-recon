"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function sibling(output, suffix) {
  return path.join(path.dirname(output), `.${path.basename(output)}.express-recon-${suffix}`);
}

function writeJsonExclusive(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function ownerIsAlive(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function acquireArtifactLock(output) {
  const lock = sibling(output, "lock");
  try {
    writeJsonExclusive(lock, {
      kind: "express-recon-artifact-lock",
      pid: process.pid,
      createdAt: new Date().toISOString(),
      output,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let owner = null;
    try {
      owner = readJson(lock);
    } catch {
      // Invalid abandoned locks are recoverable because this path is tool-owned.
    }
    if (ownerIsAlive(owner)) {
      throw new Error(`Artifact output is locked by writer process ${owner.pid}: ${output}`);
    }
    fs.rmSync(lock, { force: true });
    writeJsonExclusive(lock, {
      kind: "express-recon-artifact-lock",
      pid: process.pid,
      createdAt: new Date().toISOString(),
      output,
      recoveredAbandonedLock: true,
    });
  }
  return () => fs.rmSync(lock, { force: true });
}

function safeTransaction(record, output) {
  const parent = path.dirname(output);
  return (
    record?.kind === "express-recon-artifact-transaction" &&
    record.output === output &&
    path.dirname(record.staging) === parent &&
    path.dirname(record.backup) === parent &&
    path.basename(record.staging).startsWith(`.${path.basename(output)}.express-recon-staging-`) &&
    path.basename(record.backup).startsWith(`.${path.basename(output)}.express-recon-backup-`)
  );
}

function recoverArtifactTransaction(output) {
  const marker = sibling(output, "transaction.json");
  if (!fs.existsSync(marker)) return null;
  let record;
  try {
    record = readJson(marker);
  } catch (error) {
    throw new Error(`Artifact transaction marker is unreadable: ${error.message}`);
  }
  if (!safeTransaction(record, output)) {
    throw new Error(
      `Artifact transaction marker is unsafe or belongs to another output: ${marker}`,
    );
  }
  if (
    record.phase === "prepared" &&
    record.expectedGeneration === null &&
    !fs.existsSync(output) &&
    fs.existsSync(record.staging)
  ) {
    // A first render has no prior output or backup to restore. The staging
    // directory was fully built before the marker was written, so recovery can
    // safely finish the atomic install.
    fs.renameSync(record.staging, output);
  }
  if (!fs.existsSync(output) && fs.existsSync(record.backup)) {
    fs.renameSync(record.backup, output);
  }
  if (!fs.existsSync(output)) {
    throw new Error(`Artifact transaction cannot recover ${output}; its backup is missing`);
  }
  if (fs.existsSync(record.backup)) fs.rmSync(record.backup, { recursive: true, force: true });
  if (fs.existsSync(record.staging)) fs.rmSync(record.staging, { recursive: true, force: true });
  fs.rmSync(marker, { force: true });
  return { recovered: true, phase: record.phase };
}

function files(directory, root = directory, output = []) {
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`Artifact generation cannot hash symlink ${target}`);
    if (stat.isDirectory()) files(target, root, output);
    else if (stat.isFile()) output.push(path.relative(root, target).split(path.sep).join("/"));
  }
  return output;
}

function artifactGeneration(output) {
  if (!fs.existsSync(output)) return null;
  const hash = crypto.createHash("sha256");
  for (const reference of files(output).sort()) {
    hash
      .update(reference)
      .update("\0")
      .update(fs.readFileSync(path.join(output, reference)));
  }
  return `sha256:${hash.digest("hex")}`;
}

function replaceArtifactDirectory({ staging, output, expectedGeneration, hooks = {} }) {
  hooks.beforeCompareAndSwap?.();
  const actualGeneration = artifactGeneration(output);
  if (actualGeneration !== expectedGeneration) {
    throw new Error(
      `Artifact output changed after it was read; refusing to overwrite concurrent edits: ${output}`,
    );
  }
  const marker = sibling(output, "transaction.json");
  const backup = fs.mkdtempSync(
    path.join(path.dirname(output), `.${path.basename(output)}.express-recon-backup-`),
  );
  fs.rmdirSync(backup);
  const record = {
    kind: "express-recon-artifact-transaction",
    output,
    staging,
    backup,
    expectedGeneration,
    phase: "prepared",
  };
  writeJsonExclusive(marker, record);
  let oldMoved = false;
  let installed = false;
  try {
    hooks.beforeReplace?.();
    if (fs.existsSync(output)) {
      fs.renameSync(output, backup);
      oldMoved = true;
      record.phase = "old-moved";
      writeJson(marker, record);
      hooks.afterOldMoved?.();
    }
    fs.renameSync(staging, output);
    installed = true;
    record.phase = "installed";
    writeJson(marker, record);
    hooks.afterInstall?.();
    if (oldMoved) fs.rmSync(backup, { recursive: true, force: true });
    fs.rmSync(marker, { force: true });
  } catch (error) {
    if (installed && fs.existsSync(output)) fs.rmSync(output, { recursive: true, force: true });
    if (oldMoved && fs.existsSync(backup) && !fs.existsSync(output)) fs.renameSync(backup, output);
    if (!oldMoved || fs.existsSync(output)) fs.rmSync(marker, { force: true });
    throw error;
  }
}

function withArtifactLock(output, callback) {
  const release = acquireArtifactLock(output);
  try {
    const recovery = recoverArtifactTransaction(output);
    return callback(recovery);
  } finally {
    release();
  }
}

module.exports = {
  acquireArtifactLock,
  artifactGeneration,
  recoverArtifactTransaction,
  replaceArtifactDirectory,
  withArtifactLock,
};
