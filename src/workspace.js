"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const pkg = require("../package.json");
const { acquireRepository, gitEnvironment } = require("./repository");
const { createAnalysisSession } = require("./analysis-session");
const { buildReport, SCHEMA_VERSION } = require("./report");
const { validateConfig } = require("./config");
const { loadPackageInfo } = require("./static/resolve");
const { reconcileDocumentation } = require("./docs");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}
function fingerprint(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function portableScanSettings(config = {}, scan = {}) {
  const settings = JSON.parse(JSON.stringify({ config, scan }));
  const ignore = scan.ignoreFile ?? config.scan?.ignoreFile;
  if (typeof ignore === "string" && path.isAbsolute(ignore)) {
    const stat = fs.statSync(ignore);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error("Workspace ignore settings exceed 1 MiB");
    settings.externalIgnore = {
      name: path.basename(ignore),
      content: fs.readFileSync(ignore, "utf8"),
    };
    if (settings.config.scan) delete settings.config.scan.ignoreFile;
    delete settings.scan.ignoreFile;
  }
  return settings;
}

function validateWorkspaceProvenance(source, applicationId) {
  require("./saved-state-schema").validateSavedContract("source", source);
  require("./saved-state-schema").validateSavedToolVersion(source.toolVersion);
  if (
    source?.schemaVersion !== "1.0" ||
    source.kind !== "express-recon-workspace-source" ||
    typeof source.repository !== "string" ||
    !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(source.repository) ||
    !/^[a-f0-9]{40,64}$/.test(source.commit) ||
    typeof source.applicationId !== "string" ||
    source.applicationId !== applicationId ||
    !source.scanSettings ||
    fingerprint(source.scanSettings) !== source.settingsFingerprint ||
    typeof source.toolVersion !== "string" ||
    source.reportSchemaVersion !== SCHEMA_VERSION
  )
    throw new Error("Workspace source identity/settings have an incompatible contract");
  validateConfig(source.scanSettings.config || {});
  const { includeTests, ...scan } = source.scanSettings.scan || {};
  if (includeTests !== undefined && typeof includeTests !== "boolean")
    throw new Error("Saved includeTests must be a boolean");
  validateConfig({ scan });
  if (
    source.scanSettings.externalIgnore &&
    (typeof source.scanSettings.externalIgnore.content !== "string" ||
      Buffer.byteLength(source.scanSettings.externalIgnore.content) > 1024 * 1024)
  )
    throw new Error("Invalid saved ignore settings");
  return source;
}

function gitRead(root, args) {
  const result = spawnSync("git", ["-c", `core.hooksPath=${os.devNull}`, "-C", root, ...args], {
    env: gitEnvironment(),
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw new Error("Could not verify local source Git identity/revision");
  return result.stdout.trim();
}

function verifySource(root, provenance) {
  const real = fs.realpathSync(root);
  if (fs.realpathSync(gitRead(real, ["rev-parse", "--show-toplevel"])) !== real)
    throw new Error("Source must be the repository root");
  const remote = gitRead(real, ["config", "--local", "--get", "remote.origin.url"]);
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/?#]+\/[^/?#]+?)(?:\.git)?\/?$/.exec(
      remote,
    );
  if (!match || match[1].toLowerCase() !== provenance.repository.toLowerCase())
    throw new Error("Local source origin differs from the workspace repository");
  if (gitRead(real, ["rev-parse", "HEAD"]) !== provenance.commit)
    throw new Error(`Local source revision differs from the expected commit ${provenance.commit}`);
  return real;
}

/** Refresh a provenance-bound workspace from the expected committed local snapshot. */
function refreshSourceWorkspace(options) {
  const { loadRefreshWorkspace, refreshDocumentation } = require("./refresh");
  const existing = fs.existsSync(path.join(options.output, "refresh-manifest.json"))
    ? loadRefreshWorkspace(options.output, { allowEditedOpenApi: options.acceptEnrichment })
    : null;
  const provenance = options.provenance || existing?.manifest.provenance;
  if (!provenance)
    throw new Error(
      "Workspace has no saved source provenance; prepare it from an organization inventory first",
    );
  validateWorkspaceProvenance(provenance, provenance.applicationId);
  if (
    existing?.manifest.provenance &&
    (existing.manifest.provenance.repository !== provenance.repository ||
      existing.manifest.provenance.applicationId !== provenance.applicationId)
  )
    throw new Error("Workspace belongs to another repository or application");
  const source = verifySource(options.root, provenance);
  const settings = structuredClone(provenance.scanSettings);
  const acquired = acquireRepository(source, {
    ref: provenance.commit,
    config: settings.config,
    scan: settings.scan,
  });
  try {
    acquired.snapshot = fs.realpathSync(acquired.snapshot);
    if (
      acquired.provenance.commit !== provenance.commit ||
      !acquired.provenance.acquisition.complete
    )
      throw new Error("Could not acquire the complete expected source snapshot");
    const scanOptions = { ...settings.config.scan, ...settings.scan };
    if (settings.externalIgnore) {
      const ignore = path.join(acquired.temp, "workspace.ignore");
      fs.writeFileSync(ignore, settings.externalIgnore.content);
      scanOptions.ignoreFile = ignore;
    }
    const session = createAnalysisSession(acquired.snapshot, scanOptions);
    const command = Object.keys(settings.config.openapi?.securityByTag || {}).length
      ? "audit"
      : "inventory";
    const registry = command === "audit" ? session.audit(settings.config) : session.inventory();
    const routes = buildReport(registry, {
      command,
      mode: "static",
      target: loadPackageInfo(acquired.snapshot),
      sourceRoot: acquired.snapshot,
      config: settings.config,
    });
    const discovery = session.discover();
    if (!routes.applications.some((application) => application.id === provenance.applicationId))
      throw new Error("Saved application identity is not present in the committed source snapshot");
    const documentation = reconcileDocumentation(routes, {
      root: acquired.snapshot,
      scan: scanOptions,
      discovery,
      applicationId: provenance.applicationId,
      ...(existing?.manifest.selection.spec ? { spec: existing.manifest.selection.spec } : {}),
      ...(existing?.manifest.selection.jsdoc ? { jsdoc: existing.manifest.selection.jsdoc } : {}),
    });
    return refreshDocumentation({
      ...options,
      root: acquired.snapshot,
      routes,
      discovery,
      documentation,
      provenance: { ...provenance, toolVersion: pkg.version },
      configurationExplicit: true,
      render: options.render ?? existing?.manifest.render ?? false,
      scopeChange:
        existing?.manifest.provenance?.settingsFingerprint !== undefined &&
        existing.manifest.provenance.settingsFingerprint !== provenance.settingsFingerprint,
    });
  } finally {
    acquired.cleanup();
  }
}

/** Prepare one or all stable application workspaces from inventory and matching local source. */
function prepareWorkspaces(options) {
  const saved = require("./saved-state").loadOrganizationInventory(options.input);
  const repository = (
    options.repository.includes("/")
      ? options.repository
      : `${saved.report.organization.login}/${options.repository}`
  ).toLowerCase();
  const entry = saved.report.repositories.find(
    (value) => value.repository.fullName.toLowerCase() === repository,
  );
  const scan = saved.scans.get(repository);
  if (!entry?.commit || !scan) throw new Error("Selected repository has no saved scan and commit");
  const applications = scan.inventory.applications || [];
  const selected =
    options.applicationId === "all"
      ? applications
      : applications.filter(
          (application) =>
            application.id ===
            (options.applicationId || (applications.length === 1 ? applications[0].id : null)),
        );
  if (!selected.length)
    throw new Error(
      `Select an application with --app-id (or all): ${applications.map((application) => application.id).join(", ")}`,
    );
  const settings = options.scanSettings || saved.report.scanSettings;
  if (!settings)
    throw new Error(
      "Inventory predates saved scan settings; supply the matching scanSettings/config explicitly or rescan",
    );
  const results = [];
  for (const application of selected) {
    const output =
      options.applicationId === "all"
        ? path.join(options.output, `app-${fingerprint(application.id).slice(0, 24)}`)
        : options.output;
    const provenance = {
      schemaVersion: "1.0",
      kind: "express-recon-workspace-source",
      repository,
      commit: entry.commit,
      applicationId: application.id,
      scanSettings: structuredClone(settings),
      settingsFingerprint: fingerprint(settings),
      toolVersion: pkg.version,
      inventoryToolVersion: saved.report.toolVersion,
      reportSchemaVersion: SCHEMA_VERSION,
      inventoryConfigHash: saved.report.scope?.configHash || null,
      inventoryScanHash: saved.report.scope?.scanHash || null,
    };
    results.push(refreshSourceWorkspace({ ...options, output, provenance }));
  }
  return {
    kind: "workspace-preparation-result",
    repository,
    commit: entry.commit,
    workspaces: results,
  };
}

module.exports = {
  portableScanSettings,
  validateWorkspaceProvenance,
  verifySource,
  prepareWorkspaces,
  refreshSourceWorkspace,
  fingerprint,
};
