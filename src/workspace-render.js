"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { referencedRepositoryScan } = require("./organization-compare");

function discoverWorkspaces(root, state = { entries: 0 }, depth = 0) {
  if (!fs.existsSync(root)) return [];
  if (depth > 8) throw new Error("Workspace discovery exceeds 8 directory levels");
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Workspace discovery requires regular directories");
  if (fs.existsSync(path.join(root, "refresh-manifest.json"))) return [root];
  const found = [];
  for (const entry of fs
    .readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (++state.entries > 20000) throw new Error("Workspace discovery exceeds 20000 entries");
    if (entry.isDirectory() && !entry.name.startsWith("."))
      found.push(...discoverWorkspaces(path.join(root, entry.name), state, depth + 1));
  }
  return found;
}

function loadWorkspaceReferences(input, roots, warnings) {
  const { loadRefreshWorkspace } = require("./refresh");
  const directories = [
    ...new Set(
      (
        roots || [path.join(input.root, "workspaces"), path.join(input.discoveryRoot, "workspaces")]
      ).flatMap((root) => discoverWorkspaces(root)),
    ),
  ];
  const entries = new Map(
    input.value.repositories.map((entry) => [entry.repository.fullName.toLowerCase(), entry]),
  );
  const references = new Map();
  const identities = new Set();
  for (const directory of directories) {
    let workspace;
    try {
      workspace = loadRefreshWorkspace(directory);
    } catch (error) {
      throw new Error(`Invalid enrichment workspace ${directory}: ${error.message}`);
    }
    const source = workspace.manifest.provenance;
    if (!source) {
      warnings.push(
        `Workspace ${path.basename(directory)} has no native source provenance; prepare it from inventory`,
      );
      continue;
    }
    const entry = entries.get(source.repository.toLowerCase());
    if (!entry) {
      warnings.push(`Workspace repository ${source.repository} is absent from this inventory`);
      continue;
    }
    const identity = `${source.repository.toLowerCase()}\0${source.applicationId}`;
    if (identities.has(identity))
      throw new Error(
        `Ambiguous enrichment workspaces for ${source.repository} / ${source.applicationId}`,
      );
    identities.add(identity);
    const reasons = [];
    if (source.commit !== entry.commit) reasons.push("older-or-different-source");
    if (
      source.inventoryConfigHash !== (input.value.scope?.configHash || null) ||
      source.inventoryScanHash !== (input.value.scope?.scanHash || null)
    )
      reasons.push("scan-settings-changed");
    if (
      input.value.scanSettings &&
      require("./workspace").fingerprint(input.value.scanSettings) !== source.settingsFingerprint &&
      !reasons.includes("scan-settings-changed")
    )
      reasons.push("scan-settings-changed");
    if (
      source.inventoryToolVersion !== input.value.toolVersion ||
      source.toolVersion !== workspace.manifest.toolVersion
    )
      reasons.push("tool-version-changed");
    let scan;
    try {
      scan = referencedRepositoryScan({ ...input, realRoot: fs.realpathSync(input.root) }, entry);
    } catch {
      reasons.push("current-scan-unavailable");
    }
    if (
      scan &&
      !scan.inventory.applications.some((application) => application.id === source.applicationId)
    )
      reasons.push("application-not-in-current-scan");
    const enrichment = workspace.report.enrichment;
    if (enrichment.summary.staleOperations || enrichment.summary.staleSchemas)
      reasons.push("enrichment-needs-review");
    if (enrichment.summary.unreviewedOperations) reasons.push("unreviewed-operations");
    const accepted =
      workspace.enrichment.operations.length + workspace.enrichment.schemas.length > 0;
    if (!accepted) reasons.push("no-accepted-enrichment");
    const status = reasons.length ? reasons.join(", ") : "current";
    const item = {
      document: workspace.openapi,
      label: `Application ${source.applicationId} — ${status}`,
      source: source.applicationId,
      workspace: {
        source,
        status,
        reasons,
        enrichment,
        files: [
          { label: "Source identity", value: source },
          { label: "Accepted enrichment (including stale evidence)", value: workspace.enrichment },
        ],
      },
    };
    const selected = references.get(source.repository.toLowerCase()) || [];
    selected.push(item);
    references.set(source.repository.toLowerCase(), selected);
  }
  return references;
}

module.exports = { loadWorkspaceReferences };
