"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { normalizeHost, repositoryKey, validateBindings } = require("./domain-openapi");

const DOMAIN_INVENTORY_FILE = "domain-inventory.json";
const DOMAIN_BINDINGS_FILE = "domain-bindings.json";
const MAX_DOMAIN_BYTES = 64 * 1024 * 1024;

function readSidecar(root, name) {
  const file = path.join(root, name);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`${name} must be a regular non-symbolic file`);
  if (stat.size > MAX_DOMAIN_BYTES) throw new Error(`${name} exceeds the 64 MiB limit`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function validateDomainInventory(catalog) {
  if (
    catalog?.schemaVersion !== 1 ||
    catalog.kind !== "deployment-domain-inventory" ||
    !Array.isArray(catalog.repositories)
  )
    throw new Error("Unsupported domain inventory contract");
  const seen = new Set();
  for (const repo of catalog.repositories) {
    if (
      repositoryKey(repo.repository?.fullName) !== repo.repository.key ||
      seen.has(repo.repository.key) ||
      !Array.isArray(repo.domains) ||
      !["complete", "partial", "error"].includes(repo.status)
    )
      throw new Error("Invalid domain repository entry");
    seen.add(repo.repository.key);
    const hosts = new Set();
    for (const domain of repo.domains) {
      if (
        normalizeHost(domain.hostname)?.hostname !== domain.hostname ||
        hosts.has(domain.hostname) ||
        !Array.isArray(domain.observations)
      )
        throw new Error("Invalid or duplicated domain hostname");
      hosts.add(domain.hostname);
      for (const observation of domain.observations) {
        if (
          observation.hostname !== domain.hostname ||
          !["internal", "external"].includes(observation.scope) ||
          ![null, "http", "https"].includes(observation.scheme) ||
          !Array.isArray(observation.paths) ||
          !observation.paths.every((p) => typeof p === "string") ||
          !Number.isFinite(Date.parse(observation.source?.observedAt)) ||
          typeof observation.source?.file !== "string" ||
          typeof observation.source?.pointer !== "string" ||
          (observation.port !== null &&
            (typeof observation.port !== "string" ||
              !/^\d+$/.test(observation.port) ||
              Number(observation.port) < 1 ||
              Number(observation.port) > 65535)) ||
          (observation.urlPath !== null &&
            (typeof observation.urlPath !== "string" ||
              !/^\/(?!\/)[^\s?#{}\\]*$/.test(observation.urlPath)))
        )
          throw new Error("Invalid domain observation");
      }
      // Treat observations as the authoritative source for these projections.
      domain.scopes = [...new Set(domain.observations.map((o) => o.scope))].sort();
      domain.environments = [
        ...new Set(
          domain.observations.map((o) => o.environment).filter((v) => typeof v === "string" && v),
        ),
      ].sort();
    }
  }
  return catalog;
}

/** Optional producer-owned evidence; never modify the saved route inventory. */
function loadDomainInventory(root, entries, diagnostics) {
  let catalog;
  let bindings;
  let artifact = DOMAIN_INVENTORY_FILE;
  const warning = (artifactPath, message, repository) =>
    diagnostics.add(
      {
        code: "artifact-unavailable",
        category: "artifact",
        artifactPath,
        repository,
        message,
      },
      `Deployment domains: ${message}`,
    );
  try {
    catalog = readSidecar(root, DOMAIN_INVENTORY_FILE);
    if (catalog === undefined) return null;
    validateDomainInventory(catalog);
    artifact = DOMAIN_BINDINGS_FILE;
    bindings = validateBindings(readSidecar(root, DOMAIN_BINDINGS_FILE));
  } catch (error) {
    warning(artifact, `Domain sidecar ignored: ${String(error.message).split(root).join(".")}`);
    return null;
  }
  const byKey = new Map(catalog.repositories.map((repo) => [repo.repository.key, repo]));
  const matches = entries.map((entry) => {
    const fullName = entry.repository?.fullName;
    let key;
    try {
      key = repositoryKey(fullName);
    } catch {
      return null;
    }
    const repo = byKey.get(key);
    if (!repo) return null;
    if (entry.repository.id && repo.repository.id && entry.repository.id !== repo.repository.id) {
      warning(
        DOMAIN_INVENTORY_FILE,
        `Repository ID mismatch for ${fullName}; domain evidence ignored`,
        fullName,
      );
      return null;
    }
    return repo;
  });
  const matched = [...new Set(matches.filter(Boolean))];
  const unmatched = catalog.repositories.filter((repo) => !matched.includes(repo));
  return {
    bindings,
    matches,
    summary: {
      schemaVersion: 1,
      kind: "deployment-domain-merge",
      catalogUpdatedAt: catalog.updatedAt || null,
      matchedRepositories: matched.length,
      uniqueHosts: new Set(matched.flatMap((repo) => repo.domains.map((d) => d.hostname))).size,
      incompleteRepositories: matched.filter((repo) => repo.status !== "complete").length,
      unmatchedCatalogRepositories: unmatched.map((repo) => repo.repository.key),
      repositories: matched,
    },
  };
}

module.exports = {
  DOMAIN_INVENTORY_FILE,
  DOMAIN_BINDINGS_FILE,
  loadDomainInventory,
  validateDomainInventory,
};
