"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { classify } = require("./classify");
const { discoverFromRegistry } = require("./discover");
const { evaluatePolicies } = require("./policies");
const { ANALYSIS_STATE, listSourceFiles, scan, scanLimits } = require("./static/scan");
const { validateConfig } = require("./config");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

function snapshotId(root, options, sourceManifest, resolutionManifest, scanScopeFingerprint) {
  const evidence = {
    root,
    options,
    scanScopeFingerprint,
    sources: sourceManifest.map(({ file, sha256 }) => ({
      file: path.relative(root, file),
      sha256,
    })),
    resolutionInputs: resolutionManifest.map(({ file, exists, isFile, sha256 }) => ({
      file: path.relative(root, file),
      exists,
      ...(exists ? { isFile, sha256: sha256 || null } : {}),
    })),
  };
  return `analysis_${crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(evidence)))
    .digest("hex")
    .slice(0, 24)}`;
}

function sourceChanged(message) {
  const error = new Error(`analysis source changed during workflow: ${message}`);
  error.code = "SOURCE_CHANGED";
  return error;
}

/** Internal workflow snapshot: one parse, many consistent derived views. */
class AnalysisSession {
  constructor(rootDir, options = {}) {
    this.root = fs.realpathSync(path.resolve(rootDir));
    this.options = Object.freeze({ ...options });
    this.registry = scan(this.root, this.options);
    const state = this.registry[ANALYSIS_STATE];
    this.sourceManifest = state.sourceManifest;
    this.resolutionManifest = state.resolutionManifest;
    this.scanScopeFingerprint = state.scanScopeFingerprint;
    this.sourceFiles = state.sourceFiles;
    this.parsedModels = state.parsedModels;
    this.resolver = state.resolver;
    this.metrics = state.metrics;
    this.snapshotId = snapshotId(
      this.root,
      this.options,
      this.sourceManifest,
      this.resolutionManifest,
      this.scanScopeFingerprint,
    );
    this.assertCurrent();
    Object.freeze(this);
  }

  assertCurrent() {
    const limits = scanLimits(this.options);
    let currentScope;
    let currentFiles;
    try {
      currentFiles = listSourceFiles(this.root, {
        ...this.options,
        maxFiles: limits.maxFiles,
        deadline: Date.now() + limits.timeoutMs,
        onScope(evidence) {
          currentScope = evidence;
        },
      });
    } catch (error) {
      throw sourceChanged(`scan scope metadata is no longer readable: ${error.message}`);
    }
    if (currentScope?.fingerprint !== this.scanScopeFingerprint) {
      throw sourceChanged("the effective scan scope changed after analysis");
    }
    if (
      currentFiles.length !== this.sourceFiles.length ||
      currentFiles.some((file, index) => file !== this.sourceFiles[index])
    ) {
      throw sourceChanged("the analyzed source file set changed after analysis");
    }
    for (const entry of this.sourceManifest) {
      let stat;
      try {
        stat = fs.statSync(entry.file);
      } catch {
        throw sourceChanged(`${path.relative(this.root, entry.file)} is no longer readable`);
      }
      if (
        stat.size !== entry.size ||
        stat.mtimeMs !== entry.mtimeMs ||
        stat.ctimeMs !== entry.ctimeMs ||
        stat.ino !== entry.ino
      ) {
        throw sourceChanged(`${path.relative(this.root, entry.file)} changed after analysis`);
      }
      let sha256;
      try {
        sha256 = crypto
          .createHash("sha256")
          .update(fs.readFileSync(entry.file, "utf8"))
          .digest("hex");
      } catch {
        throw sourceChanged(`${path.relative(this.root, entry.file)} is no longer readable`);
      }
      if (sha256 !== entry.sha256) {
        throw sourceChanged(`${path.relative(this.root, entry.file)} changed after analysis`);
      }
    }
    for (const entry of this.resolutionManifest) {
      let stat;
      try {
        stat = fs.statSync(entry.file);
      } catch (error) {
        if (!entry.exists && (error.code === "ENOENT" || error.code === "ENOTDIR")) continue;
        throw sourceChanged(
          `${path.relative(this.root, entry.file)} resolution metadata changed after analysis`,
        );
      }
      if (!entry.exists || stat.isFile() !== entry.isFile) {
        throw sourceChanged(
          `${path.relative(this.root, entry.file)} resolution metadata changed after analysis`,
        );
      }
      if (entry.isFile) {
        let sha256;
        try {
          sha256 = crypto.createHash("sha256").update(fs.readFileSync(entry.file)).digest("hex");
        } catch {
          throw sourceChanged(
            `${path.relative(this.root, entry.file)} resolution metadata changed after analysis`,
          );
        }
        if (sha256 !== entry.sha256) {
          throw sourceChanged(
            `${path.relative(this.root, entry.file)} resolution metadata changed after analysis`,
          );
        }
      }
    }
    return true;
  }

  inventory() {
    this.assertCurrent();
    return this.registry;
  }

  audit(config = {}) {
    this.assertCurrent();
    const normalized = validateConfig(config);
    return evaluatePolicies(classify(this.registry, normalized), normalized.policies, {
      authWrappers: normalized.authWrappers,
    });
  }

  discover() {
    this.assertCurrent();
    const result = discoverFromRegistry(this.root, this.options, this.registry);
    this.assertCurrent();
    return result;
  }
}

function createAnalysisSession(rootDir, options) {
  return new AnalysisSession(rootDir, options);
}

module.exports = { AnalysisSession, createAnalysisSession };
