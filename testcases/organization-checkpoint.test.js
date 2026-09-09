"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  atomicWriteJson,
  CHECKPOINT_COMPATIBILITY_VERSION,
  checkpointEntry,
  checkpointPath,
  initialCheckpoint,
  loadCheckpoint,
  organizationCheckpointIdentity,
  withCompleted,
} = require("../src/organization-checkpoint");

function canonical(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

function legacyFingerprint(toolVersion, scope) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          checkpointSchemaVersion: "1.0",
          toolVersion,
          ...scope,
        }),
      ),
    )
    .digest("hex");
}

function identity(overrides = {}) {
  return organizationCheckpointIdentity("acme", {
    config: {},
    scan: {},
    maxRepositories: 100,
    includeArchived: false,
    includeForks: false,
    ...overrides,
  });
}

function writeArtifacts(root, name) {
  const relativeRoot = `repositories/${name}`;
  const directory = path.join(root, "repositories", name);
  fs.mkdirSync(directory, { recursive: true });
  const artifacts = {
    repositoryScan: `${relativeRoot}/repo-scan.json`,
    discovery: `${relativeRoot}/discovery.json`,
    routes: `${relativeRoot}/routes.json`,
  };
  for (const [key, file] of Object.entries(artifacts)) {
    fs.writeFileSync(path.join(root, ...file.split("/")), JSON.stringify({ key, name }) + "\n");
  }
  return artifacts;
}

function payload(name, overrides = {}) {
  return {
    repository: { id: name.length, name, fullName: `acme/${name}` },
    status: "express",
    coverageComplete: true,
    express: {
      detected: true,
      packageCount: 1,
      packages: [],
      applicationCount: 1,
      routeCount: 1,
      documentation: {},
    },
    scan: {
      repository: { commit: "a".repeat(40) },
      inventory: { command: "audit", summary: { public: 1 } },
    },
    ...overrides,
  };
}

test("organization checkpoint fingerprints are canonical and fail on executable values", () => {
  const left = identity({ config: { z: 1, a: { ignored: undefined, value: 2 } } });
  const right = identity({ config: { a: { value: 2 }, z: 1 } });
  assert.equal(left.fingerprint, right.fingerprint);
  assert.notEqual(left.fingerprint, identity({ maxRepositories: 101 }).fingerprint);
  assert.throws(() => identity({ config: { callback() {} } }), /cannot represent function/);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => identity({ config: cyclic }), /cyclic/);
});

test("organization resume fingerprints external ignore content without retaining its host path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-checkpoint-ignore-"));
  try {
    const firstDir = path.join(root, "first");
    const secondDir = path.join(root, "second");
    fs.mkdirSync(firstDir);
    fs.mkdirSync(secondDir);
    const first = path.join(firstDir, "trusted.ignore");
    const second = path.join(secondDir, "trusted.ignore");
    fs.writeFileSync(first, "generated/**\n");
    fs.writeFileSync(second, "generated/**\n");

    const left = identity({ scan: { ignoreFile: first } });
    const right = identity({ scan: { ignoreFile: second } });
    assert.equal(left.fingerprint, right.fingerprint);
    assert.doesNotMatch(JSON.stringify(left), new RegExp(firstDir));

    fs.writeFileSync(second, "vendor/**\n");
    assert.notEqual(left.fingerprint, identity({ scan: { ignoreFile: second } }).fingerprint);
    assert.throws(
      () => identity({ scan: { ignoreFile: path.join(root, "missing.ignore") } }),
      /Could not fingerprint external scan ignore file/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("organization checkpoints validate contracts and artifact integrity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-checkpoint-"));
  const currentIdentity = identity();
  const file = checkpointPath(root);
  try {
    assert.throws(
      () => loadCheckpoint(file, "acme", currentIdentity, root),
      /Could not read organization checkpoint/,
    );

    const artifacts = writeArtifacts(root, "z-api");
    assert.equal(
      checkpointEntry(payload("z-api", { coverageComplete: false }), artifacts, root)
        .coverageComplete,
      false,
    );
    assert.throws(
      () =>
        checkpointEntry(
          payload("z-api", { scan: { repository: { commit: "bad" }, inventory: {} } }),
          artifacts,
          root,
        ),
      /valid Git object id/,
    );
    const entry = checkpointEntry(payload("z-api", { routeGraphComplete: false }), artifacts, root);
    assert.equal(entry.routeGraphComplete, false);
    let checkpoint = withCompleted(initialCheckpoint("acme", currentIdentity), entry);
    const earlier = { ...entry, repository: { ...entry.repository, fullName: "acme/a-api" } };
    checkpoint = withCompleted(checkpoint, earlier);
    assert.deepEqual(
      checkpoint.completed.map((item) => item.repository.fullName),
      ["acme/a-api", "acme/z-api"],
    );
    checkpoint = withCompleted(checkpoint, entry);
    checkpoint.completed = checkpoint.completed.filter(
      (item) => item.repository.fullName === "acme/z-api",
    );
    atomicWriteJson(file, checkpoint);

    const loaded = loadCheckpoint(file, "ACME", currentIdentity, root);
    assert.equal(loaded.entries.length, 1);
    assert.equal(loaded.entries[0].routeGraphComplete, false);
    assert.deepEqual(loaded.diagnostics, []);

    const legacyCatalog = structuredClone(checkpoint);
    legacyCatalog.completed[0].artifacts.specifications = [];
    // Catalog migration is a resume decision, not a reason to reject valid saved hashes offline.
    const specPath = "repositories/z-api/spec.json";
    fs.writeFileSync(path.join(root, specPath), "{}\n");
    const currentCatalogEntry = checkpointEntry(
      payload("z-api"),
      { ...artifacts, specifications: [{ artifact: specPath }] },
      root,
    );
    delete currentCatalogEntry.specificationValidationVersion;
    legacyCatalog.completed = [currentCatalogEntry];
    atomicWriteJson(file, legacyCatalog);
    assert.match(
      loadCheckpoint(file, "acme", currentIdentity, root).diagnostics[0],
      /predates reference validation/,
    );
    assert.equal(
      loadCheckpoint(file, "acme", currentIdentity, root, { verifyOnly: true }).entries.length,
      1,
    );
    atomicWriteJson(file, checkpoint);

    const preCatalog = structuredClone(entry);
    preCatalog.express.documentation = { specifications: 1 };
    atomicWriteJson(file, {
      ...checkpoint,
      completed: [preCatalog],
    });
    const refresh = loadCheckpoint(file, "acme", currentIdentity, root);
    assert.equal(refresh.entries.length, 0);
    assert.match(refresh.diagnostics[0], /predates retained specification catalogs/);
    atomicWriteJson(file, checkpoint);

    fs.appendFileSync(path.join(root, "repositories", "z-api", "routes.json"), "damaged");
    const damaged = loadCheckpoint(file, "acme", currentIdentity, root);
    assert.equal(damaged.entries.length, 0);
    assert.match(damaged.diagnostics[0], /integrity check/);

    const mismatched = structuredClone(checkpoint);
    mismatched.completed[0].artifacts.routes = "repositories/z-api/other.json";
    atomicWriteJson(file, mismatched);
    assert.throws(
      () => loadCheckpoint(file, "acme", currentIdentity, root),
      /integrity records do not match/,
    );

    const unsafe = structuredClone(checkpoint);
    unsafe.completed[0].artifacts.routes = "../routes.json";
    unsafe.completed[0].files.find((item) => item.path.endsWith("routes.json")).path =
      "../routes.json";
    atomicWriteJson(file, unsafe);
    const rejected = loadCheckpoint(file, "acme", currentIdentity, root);
    assert.equal(rejected.entries.length, 0);
    assert.match(rejected.diagnostics[0], /unsafe artifact path/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pre-generation and generation-3 checkpoints are rejected after proof changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-checkpoint-legacy-"));
  const currentIdentity = identity();
  const file = checkpointPath(root);
  try {
    const artifacts = writeArtifacts(root, "api");
    const entry = checkpointEntry(payload("api"), artifacts, root);
    const negativeArtifacts = writeArtifacts(root, "worker");
    const negative = checkpointEntry(
      payload("worker", {
        status: "not-express",
        express: {
          detected: false,
          packageCount: 0,
          packages: [],
          applicationCount: 0,
          routeCount: 0,
          documentation: {},
        },
      }),
      negativeArtifacts,
      root,
    );
    const legacy = withCompleted(
      withCompleted(initialCheckpoint("acme", currentIdentity), entry),
      negative,
    );
    legacy.toolVersion = "0.7.1";
    delete legacy.compatibilityVersion;
    legacy.fingerprint = legacyFingerprint(legacy.toolVersion, legacy.scope);
    atomicWriteJson(file, legacy);

    const preGeneration = loadCheckpoint(file, "acme", currentIdentity, root);
    assert.equal(preGeneration.entries.length, 0);
    assert.equal(preGeneration.checkpoint.completed.length, 0);
    assert.match(preGeneration.diagnostics[0], /all repositories will be rescanned/);

    const generation3 = initialCheckpoint("acme", currentIdentity);
    generation3.compatibilityVersion = "3";
    atomicWriteJson(file, generation3);
    const oldGeneration = loadCheckpoint(file, "acme", currentIdentity, root);
    assert.equal(oldGeneration.entries.length, 0);
    assert.equal(oldGeneration.checkpoint.compatibilityVersion, CHECKPOINT_COMPATIBILITY_VERSION);
    assert.match(oldGeneration.diagnostics[0], /generation 3/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("organization checkpoints reject malformed or incompatible top-level state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-checkpoint-invalid-"));
  const currentIdentity = identity();
  const file = checkpointPath(root);
  try {
    fs.writeFileSync(file, "not json");
    assert.throws(() => loadCheckpoint(file, "acme", currentIdentity, root), /Could not parse/);

    for (const [value, pattern] of [
      [[], /must contain an object/],
      [{}, /unsupported contract/],
      [initialCheckpoint("other", currentIdentity), /belongs to other/],
      [{ ...initialCheckpoint("acme", currentIdentity), completed: {} }, /must be an array/],
    ]) {
      atomicWriteJson(file, value);
      assert.throws(() => loadCheckpoint(file, "acme", currentIdentity, root), pattern);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
