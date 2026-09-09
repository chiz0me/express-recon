"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Ajv = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const { REPORT_SCHEMA } = require("./schema");
const { loadOrganizationSnapshot, referencedRepositoryScan } = require("./organization-compare");
const { validateOpenApiDocument } = require("./openapi-validation");
const { loadSpec, describeRenderableSpecification } = require("./docs");
const {
  CHECKPOINT_COMPATIBILITY_VERSION,
  atomicWriteJson,
  loadCheckpoint,
} = require("./organization-checkpoint");
const pkg = require("../package.json");
const { validateSavedContract, validateSavedToolVersion } = require("./saved-state-schema");
const MANIFEST = "organization-manifest.json";
let routeValidator;

function validateRouteReport(report) {
  if (!routeValidator) {
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    routeValidator = ajv.compile(REPORT_SCHEMA);
  }
  if (!routeValidator(report))
    throw new Error(
      `Invalid saved route report: ${routeValidator.errors[0].instancePath} ${routeValidator.errors[0].message}`,
    );
}

function containedFile(root, reference) {
  if (
    typeof reference !== "string" ||
    !reference ||
    reference.includes("\\") ||
    [...reference].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    path.isAbsolute(reference) ||
    reference.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Saved artifact path must be a safe relative path");
  let file = fs.realpathSync(root);
  for (const part of reference.split("/")) {
    file = path.join(file, part);
    if (fs.lstatSync(file).isSymbolicLink())
      throw new Error("Saved artifact paths cannot contain symbolic links");
  }
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 128 * 1024 * 1024)
    throw new Error("Saved artifact is not a bounded regular file");
  return file;
}

function json(root, reference) {
  return JSON.parse(fs.readFileSync(containedFile(root, reference), "utf8"));
}

function validateReferences(document) {
  const { anchors, references } = require("./specification-references").specificationReferences(
    document,
  );
  for (const reference of references) {
    const value = { $ref: reference };
    if (!value.$ref.startsWith("#"))
      throw new Error(
        `Offline validation requires self-contained OpenAPI references: ${value.$ref}`,
      );
    if (value.$ref !== "#") {
      const pointer = decodeURIComponent(value.$ref.slice(1));
      if (!pointer.startsWith("/")) {
        if (!anchors.has(pointer))
          throw new Error(`Unresolved OpenAPI reference anchor: ${value.$ref}`);
        continue;
      }
      let target = document;
      for (const raw of pointer.slice(1).split("/")) {
        if (/~(?![01])/.test(raw)) throw new Error("Invalid OpenAPI JSON pointer escape");
        const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
        if (!target || !Object.hasOwn(target, key))
          throw new Error(`Unresolved OpenAPI reference: ${value.$ref}`);
        target = target[key];
      }
    }
  }
}

function declaredArtifacts(report) {
  const files = new Set(["organization-inventory.json"]);
  for (const entry of report.repositories)
    for (const [name, reference] of Object.entries(entry.artifacts || {})) {
      if (name === "specifications") {
        for (const item of reference) {
          files.add(item.artifact);
          if (item.reconciliation?.artifact) files.add(item.reconciliation.artifact);
          if (item.reconciliation?.reportArtifact) files.add(item.reconciliation.reportArtifact);
        }
      } else files.add(reference);
    }
  if (report.delta) files.add("organization-delta.json");
  if (report.resume?.checkpoint) files.add(report.resume.checkpoint);
  return [...files].sort();
}

function writeOrganizationManifest(root, report) {
  const integrity = Object.fromEntries(
    declaredArtifacts(report).map((reference) => {
      const bytes = fs.readFileSync(containedFile(root, reference));
      return [
        reference,
        { bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") },
      ];
    }),
  );
  atomicWriteJson(path.join(root, MANIFEST), {
    schemaVersion: "1.0",
    kind: "express-recon-organization-manifest",
    toolVersion: pkg.version,
    integrity,
  });
}

function verifyIntegrity(root, reference, expected) {
  if (
    !expected ||
    !Number.isSafeInteger(expected.bytes) ||
    expected.bytes < 0 ||
    !/^[a-f0-9]{64}$/.test(expected.sha256)
  )
    throw new Error(`Invalid saved integrity entry: ${reference}`);
  const bytes = fs.readFileSync(containedFile(root, reference));
  if (
    bytes.length !== expected.bytes ||
    crypto.createHash("sha256").update(bytes).digest("hex") !== expected.sha256
  )
    throw new Error(`Saved artifact failed its integrity check: ${reference}`);
}

/** Validate all declared organization artifacts and hashes without acquiring source. */
function loadOrganizationInventory(input) {
  const snapshot = loadOrganizationSnapshot(input);
  const report = snapshot.report;
  validateSavedContract("organization", report);
  validateSavedToolVersion(report.toolVersion);
  if (
    report.schemaVersion !== "1.0" ||
    report.tool !== "express-recon" ||
    typeof report.toolVersion !== "string"
  )
    throw new Error("Unsupported saved organization inventory contract");
  if (
    report.evidenceCompatibilityVersion !== undefined &&
    report.evidenceCompatibilityVersion !== CHECKPOINT_COMPATIBILITY_VERSION
  )
    throw new Error(
      "Unsupported organization evidence compatibility version; rescan before enrichment",
    );
  const validation = { integrity: "legacy-unhashed", warnings: [] };
  if (fs.existsSync(path.join(snapshot.root, MANIFEST))) {
    const manifest = json(snapshot.root, MANIFEST);
    validateSavedContract("organizationManifest", manifest);
    validateSavedToolVersion(manifest.toolVersion);
    if (
      manifest.schemaVersion !== "1.0" ||
      manifest.kind !== "express-recon-organization-manifest" ||
      !manifest.integrity ||
      typeof manifest.integrity !== "object" ||
      Array.isArray(manifest.integrity)
    )
      throw new Error("Unsupported saved organization integrity manifest");
    if (
      JSON.stringify(Object.keys(manifest.integrity).sort()) !==
      JSON.stringify(declaredArtifacts(report))
    )
      throw new Error(
        "Organization integrity manifest does not cover exactly the declared artifacts",
      );
    for (const [reference, expected] of Object.entries(manifest.integrity))
      verifyIntegrity(snapshot.root, reference, expected);
    validation.integrity = "verified";
  } else
    validation.warnings.push(
      "Legacy inventory has no complete integrity manifest; available checkpoint hashes are checked, but missing historical hashes cannot be reconstructed offline.",
    );
  const scans = new Map();
  for (const entry of report.repositories) {
    if (
      !entry.repository.fullName
        .toLowerCase()
        .startsWith(`${report.organization.login.toLowerCase()}/`)
    )
      throw new Error("Saved repository does not belong to the organization");
    if (!entry.scan && !entry.artifacts?.repositoryScan) {
      if (entry.scanned)
        throw new Error(`Missing repository scan for ${entry.repository.fullName}`);
      continue;
    }
    const scan = referencedRepositoryScan(snapshot, entry);
    validateRouteReport(scan.inventory);
    if (scan.repository?.commit !== entry.commit || !/^[a-f0-9]{40,64}$/.test(entry.commit))
      throw new Error(`Saved source commit mismatch: ${entry.repository.fullName}`);
    for (const [name, reference] of Object.entries(entry.artifacts || {})) {
      if (name === "specifications") {
        for (const specification of reference) {
          const file = containedFile(snapshot.root, specification.artifact);
          const document = loadSpec(file, { allowSwagger2: true, maxFileBytes: 32 * 1024 * 1024 });
          describeRenderableSpecification(document);
          if (document.openapi) validateOpenApiDocument(document);
          validateReferences(document);
          if (specification.reconciliation?.artifact) {
            const enriched = json(snapshot.root, specification.reconciliation.artifact);
            validateOpenApiDocument(enriched);
            validateReferences(enriched);
          }
          if (specification.reconciliation?.reportArtifact)
            json(snapshot.root, specification.reconciliation.reportArtifact);
        }
      } else {
        const value = json(snapshot.root, reference);
        if (name === "routes") {
          validateRouteReport(value);
          if (JSON.stringify(value) !== JSON.stringify(scan.inventory))
            throw new Error("Repository scan and saved routes disagree");
        }
        if (name === "openapi") {
          validateOpenApiDocument(value);
          validateReferences(value);
        }
      }
    }
    scans.set(entry.repository.fullName.toLowerCase(), scan);
  }
  const checkpointFile = path.join(snapshot.root, "organization-checkpoint.json");
  if (fs.existsSync(checkpointFile)) {
    const checkpoint = json(snapshot.root, "organization-checkpoint.json");
    if (
      checkpoint.kind !== "github-organization-scan-checkpoint" ||
      checkpoint.schemaVersion !== "1.0" ||
      !Array.isArray(checkpoint.completed) ||
      checkpoint.organization?.toLowerCase() !== report.organization.login.toLowerCase()
    )
      throw new Error("Unsupported saved organization checkpoint");
    if (checkpoint.compatibilityVersion !== CHECKPOINT_COMPATIBILITY_VERSION)
      throw new Error("Unsupported saved checkpoint compatibility version");
    for (const key of [
      "configHash",
      "scanHash",
      "includeArchived",
      "includeForks",
      "maxRepositories",
    ])
      if (checkpoint.scope?.[key] !== report.scope?.[key])
        throw new Error("Saved checkpoint scope differs from organization inventory");
    const loaded = loadCheckpoint(
      checkpointFile,
      report.organization.login,
      { fingerprint: checkpoint.fingerprint },
      snapshot.root,
    );
    if (loaded.diagnostics.length)
      throw new Error(`Saved checkpoint is invalid: ${loaded.diagnostics.join("; ")}`);
    for (const entry of loaded.entries) {
      const current = report.repositories.find(
        (item) =>
          item.repository.fullName.toLowerCase() === entry.repository.fullName.toLowerCase(),
      );
      if (
        !current ||
        current.commit !== entry.commit ||
        JSON.stringify(current.artifacts) !== JSON.stringify(entry.artifacts)
      )
        throw new Error("Saved checkpoint repository evidence differs from organization inventory");
    }
  }
  return { ...snapshot, scans, validation };
}

/** Load supported saved organization/refresh state, validating all declared evidence offline. */
function loadSavedState(input, options = {}) {
  const file = path.resolve(input);
  const directory = fs.statSync(file).isDirectory() ? file : path.dirname(file);
  if (fs.existsSync(path.join(directory, "refresh-manifest.json"))) {
    return {
      kind: "refresh-workspace",
      ...require("./refresh").loadRefreshWorkspace(directory, options),
    };
  }
  return { kind: "organization-inventory", ...loadOrganizationInventory(input) };
}

module.exports = {
  loadSavedState,
  loadOrganizationInventory,
  validateRouteReport,
  validateReferences,
  containedFile,
  writeOrganizationManifest,
};
