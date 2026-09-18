"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createGitHubTokenProvider } = require("./github-auth");
const { atomicWriteJson } = require("./organization-checkpoint");
const { acquireArtifactLock } = require("./artifact-transaction");
const pkg = require("../package.json");
const { CLASSIFICATION_SCHEMA } = require("./organization-classification-schema");
const validateSchema = new (require("ajv/dist/2020"))({ strict: true }).compile(
  CLASSIFICATION_SCHEMA,
);

// Bump independently from route/audit compatibility when classification changes.
const CLASSIFIER_VERSION = "1";
const CLASSIFICATION_FILENAME = "repository-classification.json";
const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_MANIFESTS = 100;
const SHA = /^[a-f0-9]{40,64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;
const DECISIONS = new Set(["candidate", "not-applicable", "unknown"]);
const SELECTIONS = new Set([
  "eligible",
  "empty",
  "skipped-disabled",
  "skipped-archived",
  "skipped-fork",
  "skipped-filter",
  "skipped-limit",
]);
const SETTINGS = { maxManifestBytes: MAX_MANIFEST_BYTES, maxManifests: MAX_MANIFESTS };
// These limits belong to the immutable source tree. Reusing them is safe:
// incomplete classifications cannot exclude either scanner. Transport/decoding
// failures are deliberately absent so the next run can retry them.
const STABLE_UNCERTAINTY = new Set([
  "submodule-or-symbolic-link",
  "truncated-tree",
  "invalid-tree-entry",
  "manifest-count-limit",
  "manifest-size-or-identity",
]);

function reusableClassification(data) {
  return (
    data.complete ||
    (data.diagnostics.length > 0 &&
      data.diagnostics.every((reason) => STABLE_UNCERTAINTY.has(reason)))
  );
}

function digest(value) {
  function stable(item) {
    if (Array.isArray(item)) return item.map(stable);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, stable(item[key])]),
      );
    return item;
  }
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function checkPath(file) {
  const resolved = path.resolve(file);
  for (let current = resolved; ; current = path.dirname(current)) {
    if (fs.existsSync(current) || fs.lstatSync(current, { throwIfNoEntry: false })) {
      if (fs.lstatSync(current).isSymbolicLink())
        throw new Error("Classification paths must not contain symbolic links");
    }
    if (current === path.dirname(current)) break;
  }
  return resolved;
}

function validateCatalog(value) {
  if (!validateSchema(value)) throw new Error("Invalid repository classification schema");
  if (
    value?.schemaVersion !== "1.0" ||
    value.kind !== "repository-classification" ||
    typeof value.organization !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value.organization) ||
    !Array.isArray(value.repositories) ||
    value.repositories.length > 10000 ||
    typeof value.coverage?.complete !== "boolean"
  )
    throw new Error("Invalid repository classification catalog");
  const names = new Set();
  for (const entry of value.repositories) {
    const repo = entry.repository;
    const data = entry.classification;
    if (
      !NAME.test(repo?.fullName) ||
      repo.fullName.split("/")[0].toLowerCase() !== value.organization.toLowerCase() ||
      names.has(repo.fullName.toLowerCase()) ||
      !SELECTIONS.has(entry.status) ||
      typeof entry.checked !== "boolean" ||
      !(repo.id === null || Number.isSafeInteger(repo.id)) ||
      !(repo.defaultBranch === null || typeof repo.defaultBranch === "string")
    )
      throw new Error("Invalid classification repository identity");
    names.add(repo.fullName.toLowerCase());
    if (data === null) continue;
    if (
      !data ||
      typeof data.classifierVersion !== "string" ||
      typeof data.complete !== "boolean" ||
      !(data.commit === null || SHA.test(data.commit)) ||
      (data.complete && !SHA.test(data.commit)) ||
      !DECISIONS.has(data.javascript) ||
      !DECISIONS.has(data.gin) ||
      (!data.complete && (data.javascript === "not-applicable" || data.gin === "not-applicable")) ||
      !Array.isArray(data.frameworks) ||
      !Array.isArray(data.modules) ||
      !Array.isArray(data.evidence) ||
      !Array.isArray(data.diagnostics) ||
      data.fingerprint !== digest({ ...data, fingerprint: undefined })
    )
      throw new Error("Invalid classification evidence or fingerprint");
  }
  return value;
}

/** Load and validate a bounded classification catalog without contacting GitHub. */
function loadRepositoryClassification(file) {
  const resolved = checkPath(file);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size > MAX_CATALOG_BYTES)
    throw new Error("Classification catalog exceeds the 32 MiB file limit");
  return validateCatalog(JSON.parse(fs.readFileSync(resolved, "utf8")));
}

// An explicit snapshot describes one point in time. Unlike a persistent cache,
// it must never refresh repositories or silently widen/narrow the saved scope.
function loadClassificationSnapshot(file, organization, opts) {
  const catalog = loadRepositoryClassification(file);
  const {
    initialStatus,
    repositoryPatterns,
    repositoryGlob,
    positiveInteger,
  } = require("./organization");
  if (
    catalog.organization.toLowerCase() !== organization.toLowerCase() ||
    catalog.classifierVersion !== CLASSIFIER_VERSION ||
    digest(catalog.settings) !== digest(SETTINGS) ||
    typeof catalog.coverage.enumeration?.complete !== "boolean"
  )
    throw new Error(
      "Classification snapshot organization, classifier or enumeration is incompatible",
    );
  const include = repositoryPatterns(opts.repositoryInclude, "repositoryInclude").map(
    repositoryGlob,
  );
  const exclude = repositoryPatterns(opts.repositoryExclude, "repositoryExclude").map(
    repositoryGlob,
  );
  const maximum = positiveInteger(opts.maxRepositories, 100, "maxRepositories", 10000);
  let selected = 0;
  for (const entry of catalog.repositories) {
    let status = initialStatus(entry.repository, opts, include, exclude);
    if (status === "eligible" && selected++ >= maximum) status = "skipped-limit";
    if (status !== entry.status)
      throw new Error("Classification snapshot scope differs from scan scope");
    if (
      status === "eligible" &&
      (!entry.checked ||
        !entry.classification ||
        entry.classification.classifierVersion !== CLASSIFIER_VERSION ||
        entry.classification.settingsFingerprint !== digest(SETTINGS))
    )
      throw new Error(
        "Classification snapshot contains pending or incompatible entries; finish classification first",
      );
  }
  return catalog;
}

/** Build conservative JavaScript/Gin scanner selections and native Gin targets. */
function buildScanPlan(catalog) {
  validateCatalog(catalog);
  const plan = {
    schemaVersion: "1.0",
    kind: "repository-scan-plan",
    organization: catalog.organization,
    coverage: catalog.coverage,
    javascript: [],
    gin: [],
    skipped: [],
    ginTargets: { version: 1, targets: [] },
  };
  for (const entry of catalog.repositories) {
    const repo = entry.repository;
    if (entry.status !== "eligible") {
      plan.skipped.push({ repository: repo.fullName, scanner: "all", reason: entry.status });
      continue;
    }
    const data =
      entry.checked &&
      entry.classification?.classifierVersion === CLASSIFIER_VERSION &&
      entry.classification?.settingsFingerprint === digest(SETTINGS)
        ? entry.classification
        : null;
    for (const scanner of ["javascript", "gin"]) {
      if (data?.complete && data[scanner] === "not-applicable") {
        plan.skipped.push({
          repository: repo.fullName,
          scanner,
          reason: "complete-tree-without-relevant-files",
          commit: data.commit,
        });
      } else {
        plan[scanner].push({
          repository: repo.fullName,
          commit: data?.commit || null,
          reason: data?.[scanner] || "unknown",
        });
      }
    }
    if (!(data?.complete && data.gin === "not-applicable")) {
      plan.ginTargets.targets.push({
        name: repo.fullName.split("/")[1],
        git: {
          url: `https://github.com/${repo.fullName}.git`,
          ref: data?.commit || repo.defaultBranch || "HEAD",
        },
        github: {
          id: repo.id,
          fullName: repo.fullName,
          defaultBranch: repo.defaultBranch,
          pushedAt: repo.pushedAt,
          private: repo.private,
          visibility: repo.visibility,
          archived: repo.archived,
          fork: repo.fork,
        },
      });
    }
  }
  return plan;
}

async function readApi(repository, suffix, opts, provider, metrics, maximum) {
  const { boundedResponseText, GITHUB_API_VERSION } = require("./organization");
  const token = await provider.getToken();
  metrics.apiRequests++;
  const response = await (opts.fetchImpl || globalThis.fetch)(
    new URL(`/repos/${repository.fullName}/${suffix}`, "https://api.github.com"),
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `express-recon/${pkg.version}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(opts.apiTimeoutMs || 30000),
    },
  );
  if (!response.ok) throw new Error(`classification-http-${response.status}`);
  const body = await boundedResponseText(response, maximum);
  metrics.bytesRead += Buffer.byteLength(body);
  return JSON.parse(body);
}

async function probe(repository, commit, opts, provider, metrics) {
  const data = {
    classifierVersion: CLASSIFIER_VERSION,
    settingsFingerprint: digest(SETTINGS),
    commit,
    complete: true,
    javascript: "unknown",
    gin: "unknown",
    frameworks: [],
    modules: [],
    evidence: [],
    diagnostics: [],
  };
  const uncertain = (reason) => {
    data.complete = false;
    data.diagnostics.push(reason);
  };
  try {
    const object = await readApi(
      repository,
      `git/commits/${commit}`,
      opts,
      provider,
      metrics,
      1024 * 1024,
    );
    if (!SHA.test(object.tree?.sha)) throw new Error("invalid-commit-tree");
    const tree = await readApi(
      repository,
      `git/trees/${object.tree.sha}?recursive=1`,
      opts,
      provider,
      metrics,
      16 * 1024 * 1024,
    );
    if (!Array.isArray(tree.tree) || typeof tree.truncated !== "boolean")
      throw new Error("invalid-tree-response");
    if (tree.truncated || tree.tree.length > 100000) uncertain("truncated-tree");
    const files = [];
    for (const item of tree.tree.slice(0, 100000)) {
      if (
        typeof item.path !== "string" ||
        item.path.length > 4096 ||
        item.path.startsWith("/") ||
        item.path.split("/").some((part) => part === ".." || part === "." || !part) ||
        /[\x00-\x1f\x7f]/.test(item.path) ||
        !["blob", "tree", "commit"].includes(item.type)
      ) {
        uncertain("invalid-tree-entry");
        break;
      }
      if (item.type === "commit" || item.mode === "120000") uncertain("submodule-or-symbolic-link");
      if (item.type === "blob") files.push(item);
    }
    const javascript = files.some((item) =>
      /\.(?:[cm]?jsx?|[cm]?tsx?|json|ya?ml)$/i.test(item.path),
    );
    const go = files.some((item) => /(?:\.go|(?:^|\/)(?:go\.mod|go\.work))$/i.test(item.path));
    const manifests = files
      .filter((item) => /(?:^|\/)(?:package\.json|go\.mod|go\.work)$/.test(item.path))
      .sort((a, b) => a.path.localeCompare(b.path));
    if (manifests.length > MAX_MANIFESTS) uncertain("manifest-count-limit");
    for (const item of manifests.slice(0, MAX_MANIFESTS)) {
      data.modules.push({ path: path.posix.dirname(item.path), manifest: item.path });
      if (
        !SHA.test(item.sha) ||
        !Number.isSafeInteger(item.size) ||
        item.size > MAX_MANIFEST_BYTES ||
        item.size < 0
      ) {
        uncertain("manifest-size-or-identity");
        continue;
      }
      const blob = await readApi(
        repository,
        `git/blobs/${item.sha}`,
        opts,
        provider,
        metrics,
        MAX_MANIFEST_BYTES * 2,
      );
      if (
        blob.encoding !== "base64" ||
        typeof blob.content !== "string" ||
        !/^[A-Za-z0-9+/=\s]*$/.test(blob.content)
      ) {
        uncertain("invalid-manifest-encoding");
        continue;
      }
      const bytes = Buffer.from(blob.content, "base64");
      if (bytes.length !== item.size || bytes.length > MAX_MANIFEST_BYTES) {
        uncertain("manifest-size-mismatch");
        continue;
      }
      const content = bytes.toString("utf8");
      let frameworks = [];
      if (item.path.endsWith("package.json")) {
        const manifest = JSON.parse(content);
        for (const field of [
          "dependencies",
          "devDependencies",
          "peerDependencies",
          "optionalDependencies",
        ]) {
          for (const [name, value] of Object.entries(manifest[field] || {})) {
            const dependency =
              typeof value === "string" && value.startsWith("npm:")
                ? value.slice(4).replace(/@[^@]*$/, "")
                : name;
            const framework = new Map(
              Object.entries({
                express: "express",
                fastify: "fastify",
                "@nestjs/core": "nestjs",
                "@nestjs/common": "nestjs",
              }),
            ).get(dependency);
            if (framework) frameworks.push(framework);
          }
        }
      } else if (/\bgithub\.com\/gin-gonic\/gin\b/.test(content)) frameworks.push("gin");
      frameworks = [...new Set(frameworks)].sort();
      for (const framework of frameworks) {
        data.frameworks.push(framework);
        data.evidence.push({ path: item.path, framework, kind: "manifest-dependency" });
      }
    }
    data.frameworks = [...new Set(data.frameworks)].sort();
    // Source files without a recognized dependency remain eligible: wrappers,
    // transitive dependencies and API specifications need the real scanner.
    data.javascript = data.frameworks.some((name) => name !== "gin")
      ? "candidate"
      : !javascript && data.complete
        ? "not-applicable"
        : "unknown";
    data.gin = data.frameworks.includes("gin")
      ? "candidate"
      : !go && data.complete
        ? "not-applicable"
        : "unknown";
  } catch {
    // Never reflect remote source text, request headers or credentials in output.
    uncertain("probe-failed");
  }
  if (!data.complete) {
    if (data.javascript === "not-applicable") data.javascript = "unknown";
    if (data.gin === "not-applicable") data.gin = "unknown";
  }
  data.fingerprint = digest(data);
  return data;
}

async function classifyListing(organization, listing, opts = {}) {
  const {
    repositoryPatterns,
    repositoryGlob,
    initialStatus,
    positiveInteger,
    runPool,
    repositoryHead,
  } = require("./organization");
  const provider = opts.tokenProvider || createGitHubTokenProvider(opts);
  const concurrency = positiveInteger(opts.concurrency, 1, "concurrency", 8);
  const maxRepositories = positiveInteger(opts.maxRepositories, 100, "maxRepositories", 10000);
  positiveInteger(opts.apiTimeoutMs, 30000, "apiTimeoutMs", 300000);
  if (opts.reclassify !== undefined && typeof opts.reclassify !== "boolean")
    throw new Error("reclassify must be a boolean");
  const include = repositoryPatterns(opts.repositoryInclude, "repositoryInclude").map(
    repositoryGlob,
  );
  const exclude = repositoryPatterns(opts.repositoryExclude, "repositoryExclude").map(
    repositoryGlob,
  );
  const file = opts.classificationCache ? checkPath(opts.classificationCache) : null;
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  const release = file ? acquireArtifactLock(file) : () => {};
  try {
    let previous = null;
    const diagnostics = [];
    if (file && fs.existsSync(file)) {
      try {
        previous = loadRepositoryClassification(file);
      } catch {
        diagnostics.push("Invalid classification cache; reclassifying repositories");
      }
    }
    const old = new Map(
      (previous?.organization.toLowerCase() === organization.toLowerCase()
        ? previous.repositories
        : []
      ).map((entry) => [entry.repository.fullName.toLowerCase(), entry]),
    );
    let selected = 0;
    const catalog = {
      schemaVersion: "1.0",
      kind: "repository-classification",
      tool: "express-recon",
      toolVersion: pkg.version,
      organization,
      classifierVersion: CLASSIFIER_VERSION,
      settings: SETTINGS,
      coverage: { complete: false, enumeration: listing.coverage },
      metrics: {
        repositories: 0,
        cacheHits: 0,
        cacheMisses: 0,
        apiRequests: 0,
        bytesRead: 0,
        durationMs: 0,
        invalidations: {},
      },
      diagnostics,
      repositories: listing.repositories.map((repository) => {
        let status = initialStatus(repository, opts, include, exclude);
        if (status === "eligible" && selected++ >= maxRepositories) status = "skipped-limit";
        const prior = old.get(repository.fullName.toLowerCase());
        return {
          repository,
          status,
          checked: false,
          reused: false,
          classification: prior?.classification || null,
        };
      }),
    };
    const started = Date.now();
    const save = () => {
      catalog.metrics.durationMs = Date.now() - started;
      if (file) {
        if (Buffer.byteLength(JSON.stringify(catalog)) > MAX_CATALOG_BYTES)
          throw new Error("Classification catalog exceeds the 32 MiB file limit");
        atomicWriteJson(file, catalog);
      }
    };
    const emit = (event) => {
      try {
        opts.onProgress?.({ kind: "repository-classification-progress", organization, ...event });
      } catch {
        /* Observational only. */
      }
    };
    save();
    emit({ event: "classification-started", repositories: Math.min(selected, maxRepositories) });
    await runPool(
      catalog.repositories.filter((entry) => entry.status === "eligible"),
      concurrency,
      async (entry) => {
        const prior = old.get(entry.repository.fullName.toLowerCase());
        let commit = null;
        let reason = "missing";
        try {
          catalog.metrics.apiRequests++;
          commit = await repositoryHead(entry.repository, opts, provider);
          if (opts.reclassify) reason = "forced";
          else if (!prior?.classification) reason = "missing";
          else if (
            prior.repository.id === null ||
            prior.repository.id !== entry.repository.id ||
            prior.repository.defaultBranch !== entry.repository.defaultBranch
          )
            reason = "identity";
          else if (
            prior.classification.classifierVersion !== CLASSIFIER_VERSION ||
            prior.classification.settingsFingerprint !== digest(SETTINGS)
          )
            reason = "classifier";
          else if (prior.classification.commit !== commit) reason = "commit";
          else if (!reusableClassification(prior.classification)) reason = "incomplete";
          else {
            entry.classification = prior.classification;
            entry.reused = true;
          }
        } catch {
          reason = "head-unavailable";
        }
        if (entry.reused) catalog.metrics.cacheHits++;
        else {
          catalog.metrics.cacheMisses++;
          catalog.metrics.invalidations[reason] = (catalog.metrics.invalidations[reason] || 0) + 1;
          entry.classification = commit
            ? await probe(entry.repository, commit, opts, provider, catalog.metrics)
            : {
                classifierVersion: CLASSIFIER_VERSION,
                settingsFingerprint: digest(SETTINGS),
                commit: null,
                complete: false,
                javascript: "unknown",
                gin: "unknown",
                frameworks: [],
                modules: [],
                evidence: [],
                diagnostics: ["head-unavailable"],
              };
          entry.classification.fingerprint = digest({
            ...entry.classification,
            fingerprint: undefined,
          });
        }
        entry.checked = true;
        catalog.metrics.repositories++;
        save();
        emit({
          event: entry.reused ? "classification-reused" : "classification-completed",
          repository: entry.repository.fullName,
          reason,
          classified: catalog.metrics.repositories,
        });
      },
    );
    catalog.coverage.complete =
      listing.coverage.complete &&
      !catalog.repositories.some(
        (entry) =>
          entry.status === "skipped-limit" ||
          (entry.status === "eligible" && !entry.classification?.complete),
      );
    save();
    emit({
      event: "classification-finished",
      ...catalog.metrics,
      complete: catalog.coverage.complete,
    });
    return catalog;
  } finally {
    release();
  }
}

/** Enumerate and classify current repository commits without cloning or executing code. */
async function classifyOrganization(organization, opts = {}) {
  const { validateOrganization, listOrganizationRepositories } = require("./organization");
  const login = validateOrganization(organization);
  const { positiveInteger, repositoryPatterns } = require("./organization");
  positiveInteger(opts.concurrency, 1, "concurrency", 8);
  positiveInteger(opts.maxRepositories, 100, "maxRepositories", 10000);
  positiveInteger(opts.apiTimeoutMs, 30000, "apiTimeoutMs", 300000);
  repositoryPatterns(opts.repositoryInclude, "repositoryInclude");
  repositoryPatterns(opts.repositoryExclude, "repositoryExclude");
  if (opts.reclassify !== undefined && typeof opts.reclassify !== "boolean")
    throw new Error("reclassify must be a boolean");
  if (opts.onProgress !== undefined && typeof opts.onProgress !== "function")
    throw new Error("onProgress must be a function");
  const tokenProvider = opts.tokenProvider || createGitHubTokenProvider(opts);
  const listing = await listOrganizationRepositories(login, { ...opts, tokenProvider });
  return classifyListing(login, listing, { ...opts, tokenProvider });
}

module.exports = {
  CLASSIFICATION_FILENAME,
  classifyListing,
  classifyOrganization,
  loadRepositoryClassification,
  loadClassificationSnapshot,
  buildScanPlan,
};
