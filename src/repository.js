"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { inventory, audit } = require("./harness");
const { buildReport } = require("./report");
const { discover } = require("./discover");
const { describeRenderableSpecification, loadSpec, reconcileDocumentation } = require("./docs");
const { loadPackageInfo } = require("./static/resolve");
const { scanLimits } = require("./static/scan");
const pkg = require("../package.json");

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".cjs",
  ".mjs",
  ".ts",
  ".tsx",
  ".cts",
  ".mts",
  ".json",
  ".yaml",
  ".yml",
]);
const SPECIAL_FILES = new Set([".express-reconignore"]);
const SKIP_DIRS = new Set([
  ".git",
  ".express-recon",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
]);
const MAX_TREE_OUTPUT = 64 * 1024 * 1024;
const ACTIVE_TEMP_DIRS = new Set();

function registerTempDir(dir) {
  ACTIVE_TEMP_DIRS.add(dir);
}

function unregisterTempDir(dir) {
  if (!dir || typeof dir !== "string") return false;
  if (!ACTIVE_TEMP_DIRS.has(dir)) return false;
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    ACTIVE_TEMP_DIRS.delete(dir);
    return true;
  } catch {
    // Retain in ACTIVE_TEMP_DIRS so exit handler can retry
    return false;
  }
}

/**
 * Release and delete a materialized temporary repository directory.
 *
 * @param {string|{temp:string}} target directory path or object returned by acquireRepository
 * @returns {boolean} true if a registered temporary directory was released, false otherwise
 */
function releaseRepository(target) {
  const dir = typeof target === "string" ? target : target?.temp;
  return unregisterTempDir(dir);
}

process.once("exit", () => {
  for (const dir of ACTIVE_TEMP_DIRS) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      ACTIVE_TEMP_DIRS.delete(dir);
    } catch {
      // Best-effort cleanup
    }
  }
});

function hasControlCharacters(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function validRef(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.includes("//") &&
    !value.endsWith("/") &&
    !value.endsWith(".lock")
  );
}

function normalizeRepository(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("--repo must be a non-empty GitHub shorthand, HTTPS URL, or local Git path");
  }
  const input = value.trim();
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input)) {
    return {
      kind: "https",
      remote: `https://github.com/${input}.git`,
      display: `https://github.com/${input}`,
    };
  }
  if (/^https:\/\//i.test(input)) {
    let url;
    try {
      url = new URL(input);
    } catch (err) {
      throw new Error(`Invalid HTTPS repository URL: ${err.message}`);
    }
    if (url.username || url.password) {
      throw new Error(
        "Repository URLs must not embed credentials; use a credential-safe local clone instead",
      );
    }
    if (url.search || url.hash)
      throw new Error("Repository URLs must not contain query strings or fragments");
    return { kind: "https", remote: url.toString(), display: url.toString() };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(input) || /^git@/i.test(input)) {
    throw new Error("Only HTTPS repositories and explicit local Git paths are supported");
  }
  const local = path.resolve(input);
  let stat;
  try {
    stat = fs.statSync(local);
  } catch (err) {
    throw new Error(`Could not read local Git repository ${local}: ${err.message}`);
  }
  if (!stat.isDirectory()) throw new Error(`Local Git repository must be a directory: ${local}`);
  return { kind: "local", remote: local, display: local };
}

function gitEnvironment(config = []) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (
      name.startsWith("GIT_") ||
      name.startsWith("GCM_") ||
      name === "SSH_ASKPASS" ||
      name === "GH_TOKEN" ||
      name === "GITHUB_TOKEN"
    ) {
      delete environment[name];
    }
  }
  const isolated = {
    ...environment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
  if (config.length) {
    isolated.GIT_CONFIG_COUNT = String(config.length);
    for (const [index, item] of config.entries()) {
      isolated[`GIT_CONFIG_KEY_${index}`] = item.key;
      isolated[`GIT_CONFIG_VALUE_${index}`] = item.value;
    }
  }
  return isolated;
}

function git(args, opts = {}) {
  const result = spawnSync("git", args, {
    cwd: opts.cwd,
    env: gitEnvironment(opts.gitConfig),
    encoding: opts.encoding === undefined ? "utf8" : opts.encoding,
    timeout: opts.timeoutMs,
    maxBuffer: opts.maxBuffer || 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    if (result.error.code === "ETIMEDOUT")
      throw new Error(`Git command timed out after ${opts.timeoutMs}ms`);
    throw new Error(`Could not run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : String(result.stderr || "");
    throw new Error(`Git command failed: ${stderr.trim() || `exit ${result.status}`}`);
  }
  return result.stdout;
}

function githubGitConfig(repository, token) {
  if (!token) return [];
  if (typeof token !== "string" || token.length > 4096 || hasControlCharacters(token)) {
    throw new Error("GitHub token must not contain control characters");
  }
  if (repository.kind !== "https") return [];
  const url = new URL(repository.remote);
  if (url.hostname.toLowerCase() !== "github.com") {
    throw new Error("GitHub authentication is scoped to github.com repositories only");
  }
  return [
    {
      key: `http.${url.origin}/.extraHeader`,
      value: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    },
  ];
}

function gitArgs(repo, subcommand) {
  return [
    "-c",
    `core.hooksPath=${os.devNull}`,
    "-c",
    "credential.helper=",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
    "-c",
    `protocol.file.allow=${repo.kind === "local" ? "always" : "never"}`,
    ...subcommand,
  ];
}

function remaining(deadline) {
  const value = deadline - Date.now();
  if (value <= 0) throw new Error("Repository acquisition timed out");
  return value;
}

function safeTreePath(value, includeHidden = false) {
  if (!value || value.includes("\\") || path.posix.isAbsolute(value)) return false;
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  return !parts
    .slice(0, -1)
    .some((part) => SKIP_DIRS.has(part) || (!includeHidden && part.startsWith(".")));
}

function materializable(value) {
  const name = path.posix.basename(value);
  return SPECIAL_FILES.has(name) || SOURCE_EXTENSIONS.has(path.posix.extname(name).toLowerCase());
}

function parseTree(output) {
  return output
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf("\t");
      if (tab < 0) return null;
      const [mode, type, object, size] = record.slice(0, tab).trim().split(/\s+/);
      return { mode, type, object, size: Number(size), path: record.slice(tab + 1) };
    })
    .filter(Boolean);
}

function writeSnapshot(
  objectRepo,
  commit,
  snapshot,
  repository,
  limits,
  deadline,
  gitConfig,
  includeHidden,
) {
  const output = git(
    gitArgs(repository, ["-C", objectRepo, "ls-tree", "-rlz", "--full-tree", commit]),
    { timeoutMs: remaining(deadline), maxBuffer: MAX_TREE_OUTPUT, gitConfig },
  );
  const entries = parseTree(output);
  const diagnostics = [];
  let materializedFiles = 0;
  let materializedBytes = 0;
  let skippedFiles = 0;
  let skippedBytes = 0;
  let skippedSymlinks = 0;
  let skippedSubmodules = 0;
  let limited = false;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (Date.now() >= deadline) {
      limited = true;
      const omitted = entries
        .slice(index)
        .filter(
          (item) =>
            item.type === "blob" &&
            ["100644", "100755"].includes(item.mode) &&
            safeTreePath(item.path, includeHidden) &&
            materializable(item.path),
        );
      skippedFiles += omitted.length;
      skippedBytes += omitted.reduce(
        (total, item) => total + (Number.isFinite(item.size) && item.size > 0 ? item.size : 0),
        0,
      );
      diagnostics.push("repository: source materialization stopped at scan.timeoutMs");
      break;
    }
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
      if (entry.mode === "120000") skippedSymlinks++;
      if (entry.mode === "160000" || entry.type === "commit") skippedSubmodules++;
      continue;
    }
    if (!safeTreePath(entry.path, includeHidden) || !materializable(entry.path)) continue;
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limits.maxFileBytes) {
      skippedFiles++;
      skippedBytes += Number.isFinite(entry.size) && entry.size > 0 ? entry.size : 0;
      continue;
    }
    if (
      materializedFiles >= limits.maxFiles ||
      materializedBytes + entry.size > limits.maxTotalBytes
    ) {
      skippedFiles++;
      skippedBytes += entry.size;
      limited = true;
      continue;
    }
    const destination = path.resolve(snapshot, ...entry.path.split("/"));
    if (!within(snapshot, destination)) {
      diagnostics.push(`repository: rejected unsafe tree path ${JSON.stringify(entry.path)}`);
      skippedFiles++;
      continue;
    }
    const body = git(gitArgs(repository, ["-C", objectRepo, "cat-file", "blob", entry.object]), {
      timeoutMs: remaining(deadline),
      maxBuffer: limits.maxFileBytes + 1024,
      encoding: null,
      gitConfig,
    });
    if (body.length !== entry.size) {
      diagnostics.push(
        `repository: blob size changed for ${entry.path} (tree ${entry.size}, read ${body.length})`,
      );
      skippedFiles++;
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, body, { mode: 0o600 });
    materializedFiles++;
    materializedBytes += entry.size;
  }
  if (skippedFiles) {
    diagnostics.push(
      `repository: omitted ${skippedFiles} eligible file(s) outside configured file/count/byte limits`,
    );
  }
  if (skippedSymlinks) {
    diagnostics.push(`repository: did not materialize ${skippedSymlinks} symbolic link(s)`);
  }
  if (skippedSubmodules) {
    diagnostics.push(`repository: did not fetch ${skippedSubmodules} Git submodule(s)`);
  }
  return {
    treeEntries: entries.length,
    materializedFiles,
    materializedBytes,
    skippedFiles,
    skippedBytes,
    skippedSymlinks,
    skippedSubmodules,
    limited,
    complete: skippedFiles === 0 && skippedSymlinks === 0 && skippedSubmodules === 0 && !limited,
    diagnostics,
  };
}

function within(root, file) {
  const value = path.relative(root, file);
  return value === "" || (value !== ".." && !value.startsWith(".." + path.sep));
}

/**
 * Materialize a bounded, non-executing source snapshot for one Git ref.
 * Callers own the returned temporary directory and must remove `temp`; prefer
 * scanRepository() when only the completed report is needed.
 */
function acquireRepository(source, opts = {}) {
  const repository = normalizeRepository(source);
  const remoteGitConfig = githubGitConfig(repository, opts.githubToken);
  const scan = { ...opts.config?.scan, ...opts.scan };
  const limits = scanLimits(scan);
  const requestedRef = opts.ref || "HEAD";
  if (!validRef(requestedRef)) throw new Error(`Invalid Git ref ${JSON.stringify(requestedRef)}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-repository-"));
  registerTempDir(temp);
  const objectRepo = path.join(temp, "objects");
  const snapshot = path.join(temp, "snapshot");
  try {
    const deadline = Date.now() + limits.timeoutMs;
    fs.mkdirSync(snapshot, { recursive: true });
    git(["init", "--quiet", objectRepo], { timeoutMs: remaining(deadline) });
    git(gitArgs(repository, ["-C", objectRepo, "remote", "add", "origin", repository.remote]), {
      timeoutMs: remaining(deadline),
    });
    git(
      gitArgs(repository, [
        "-C",
        objectRepo,
        "fetch",
        "--quiet",
        "--depth=1",
        "--no-tags",
        `--filter=blob:limit=${limits.maxFileBytes}`,
        "origin",
        requestedRef,
      ]),
      {
        timeoutMs: remaining(deadline),
        maxBuffer: 16 * 1024 * 1024,
        gitConfig: remoteGitConfig,
      },
    );
    const commit = String(
      git(gitArgs(repository, ["-C", objectRepo, "rev-parse", "--verify", "FETCH_HEAD^{commit}"]), {
        timeoutMs: remaining(deadline),
        gitConfig: remoteGitConfig,
      }),
    ).trim();
    const acquisition = writeSnapshot(
      objectRepo,
      commit,
      snapshot,
      repository,
      limits,
      deadline,
      remoteGitConfig,
      Boolean(scan.includeHidden),
    );
    return {
      temp,
      snapshot,
      provenance: {
        kind: repository.kind,
        source: repository.display,
        requestedRef,
        commit,
        executedTargetCode: false,
        installedDependencies: false,
        followedSubmodules: false,
        followedSymlinks: false,
        acquisition,
      },
      cleanup: () => releaseRepository(temp),
    };
  } catch (err) {
    unregisterTempDir(temp);
    throw err;
  }
}

function repositoryProgress(callback, source) {
  let enabled = typeof callback === "function";
  return (event) => {
    if (!enabled) return;
    try {
      const returned = callback({
        schemaVersion: "1.0",
        kind: "repository-scan-progress",
        timestamp: new Date().toISOString(),
        source,
        event: "phase",
        ...event,
      });
      if (returned && typeof returned.then === "function") {
        enabled = false;
        Promise.resolve(returned).catch(() => {});
      }
    } catch {
      // Observability is best-effort and must not change scan evidence.
      enabled = false;
    }
  };
}

function safeDocumentationError(error, root) {
  let message = String(error instanceof Error ? error.message : error);
  for (const value of [root, fs.realpathSync(root)]) message = message.split(value).join(".");
  return message.slice(0, 2_000);
}

function specificationInput(root, relativePath, limits) {
  const realRoot = fs.realpathSync(root);
  const file = path.resolve(realRoot, ...String(relativePath).split("/"));
  if (!within(realRoot, file)) throw new Error("specification path leaves the repository snapshot");
  const realFile = fs.realpathSync(file);
  if (!within(realRoot, realFile)) {
    throw new Error("specification symlink leaves the repository snapshot");
  }
  const stat = fs.statSync(realFile);
  if (!stat.isFile()) throw new Error("specification input is not a file");
  if (stat.size > limits.maxFileBytes) {
    throw new Error(
      `specification is ${stat.size} bytes, exceeding scan.maxFileBytes (${limits.maxFileBytes})`,
    );
  }
  return { root: realRoot, file: realFile, bytes: stat.size };
}

/**
 * Parse discovered API contracts as bounded data before the temporary source
 * snapshot is removed. Documents are embedded only when a caller will persist
 * them immediately, keeping ordinary library scans and stdout compact.
 */
function catalogSpecifications(root, discovery, scan, retainDocuments) {
  const limits = scanLimits(scan);
  const deadline = Date.now() + limits.timeoutMs;
  const specifications = [];
  let totalBytes = 0;
  for (const discovered of discovery.documentation?.specifications || []) {
    const metadata = {
      path: discovered.path,
      format: discovered.format,
      version: discovered.version ?? null,
      packageId: discovered.packageId ?? null,
    };
    try {
      if (Date.now() >= deadline) {
        throw new Error(`specification catalog exceeded scan.timeoutMs (${limits.timeoutMs}ms)`);
      }
      const input = specificationInput(root, discovered.path, limits);
      totalBytes += input.bytes;
      if (totalBytes > limits.maxTotalBytes) {
        throw new Error(`specification inputs exceed scan.maxTotalBytes (${limits.maxTotalBytes})`);
      }
      const document = loadSpec(input.file, {
        ...limits,
        root: input.root,
        allowSwagger2: true,
      });
      const description = describeRenderableSpecification(
        document,
        `API documentation ${JSON.stringify(discovered.path)}`,
      );
      specifications.push({
        ...metadata,
        ...description,
        status: "available",
        bytes: input.bytes,
        ...(retainDocuments ? { document } : {}),
      });
    } catch (error) {
      specifications.push({
        ...metadata,
        status: "unavailable",
        reason: safeDocumentationError(error, root),
      });
    }
  }
  const available = specifications.filter((item) => item.status === "available");
  return {
    specifications,
    summary: {
      discovered: specifications.length,
      available: available.length,
      unavailable: specifications.length - available.length,
      openapi: available.filter((item) => item.format === "openapi").length,
      swagger: available.filter((item) => item.format === "swagger").length,
      reconciled: 0,
      documentsRetained: retainDocuments === true,
    },
  };
}

function scopedJSDoc(discovery, packageId) {
  return (discovery.documentation?.jsdoc || []).filter(
    (file) => packageForPath(discovery, file) === packageId,
  );
}

/**
 * Reconcile a catalog entry only when one OpenAPI document maps to one package
 * and one application. Multiple contracts in the same package deliberately
 * remain independent because route ownership cannot be inferred safely.
 */
function reconcileUnambiguousSpecifications(report, options, catalog) {
  if (!options.retainDocuments) return;
  const deadline = Date.now() + scanLimits(options.scan).timeoutMs;
  const candidates = catalog.specifications.filter(
    (item) => item.status === "available" && item.format === "openapi",
  );
  if (candidates.length < 2) return;
  const packageCounts = new Map();
  for (const item of candidates) {
    if (item.packageId)
      packageCounts.set(item.packageId, (packageCounts.get(item.packageId) || 0) + 1);
  }
  const reportApplications = new Set((report.applications || []).map((item) => item.id));
  for (const item of candidates) {
    if (Date.now() >= deadline) {
      item.reconciliation = { status: "not-attempted", reason: "catalog-timeout" };
      continue;
    }
    if (!item.packageId || packageCounts.get(item.packageId) !== 1) {
      item.reconciliation = { status: "not-attempted", reason: "ambiguous-route-ownership" };
      continue;
    }
    const applications = (options.discovery.applications || []).filter(
      (application) =>
        application.packageId === item.packageId && reportApplications.has(application.id),
    );
    if (applications.length !== 1) {
      item.reconciliation = { status: "not-attempted", reason: "ambiguous-application" };
      continue;
    }
    const jsdoc = scopedJSDoc(options.discovery, item.packageId);
    try {
      const result = reconcileDocumentation(report, {
        root: options.root,
        scan: options.scan,
        discovery: options.discovery,
        applicationId: applications[0].id,
        spec: item.path,
        jsdoc,
        disableAutoJSDoc: jsdoc.length === 0,
      });
      item.reconciliation = {
        status: "merged",
        applicationId: applications[0].id,
        document: result.document,
        report: result.report,
      };
      catalog.summary.reconciled++;
    } catch (error) {
      item.reconciliation = {
        status: "needs-input",
        reason: safeDocumentationError(error, options.root),
      };
    }
  }
}

/**
 * Acquire, statically scan, and document one repository, then remove its
 * temporary source snapshot in a finally block. Target code and dependencies
 * are never executed or installed.
 */
function scanRepository(source, opts = {}) {
  const scan = { ...opts.config?.scan, ...opts.scan };
  const progress = repositoryProgress(opts.onProgress, source);
  progress({ phase: "acquiring" });
  let acquired;
  try {
    acquired = acquireRepository(source, { ...opts, scan });
  } catch (err) {
    progress({ phase: "acquisition-failed" });
    throw err;
  }
  try {
    const root = acquired.snapshot;
    progress({
      phase: "discovering",
      commit: acquired.provenance.commit,
      materializedFiles: acquired.provenance.acquisition.materializedFiles,
    });
    const discovery = discover(root, scan);
    const config = opts.config || {};
    const command =
      Object.keys(config.authMiddleware || {}).length > 0 ||
      (config.authWrappers || []).length > 0 ||
      (config.acceptedPublic || []).length > 0 ||
      (config.policies || []).length > 0 ||
      Object.keys(config.openapi?.securityByTag || {}).length > 0
        ? "audit"
        : "inventory";
    progress({
      phase: "inventorying",
      packages: discovery.packages.length,
      applications: discovery.applications.length,
      specifications: discovery.documentation.specifications.length,
      jsdocSources: discovery.documentation.jsdoc.length,
    });
    const registry =
      command === "audit"
        ? audit({ mode: "static", src: root, ...scan }, config)
        : inventory({ mode: "static", src: root, ...scan });
    const inventoryReport = buildReport(registry, {
      command,
      mode: "static",
      target: loadPackageInfo(root),
      sourceRoot: root,
      config,
    });
    progress({
      phase: "documenting",
      command,
      routes: inventoryReport.routes.length,
    });
    const retainDocuments = opts.retainSpecificationDocuments === true;
    const catalog = catalogSpecifications(root, discovery, scan, retainDocuments);
    let documentation;
    const selected = opts.applicationId;
    const discoveredOpenApiCandidates = discovery.documentation.specifications.filter((item) =>
      ["openapi", "candidate", "openapi-module", "openapi-module-candidate"].includes(item.format),
    );
    const soleAvailableOpenApi = catalog.specifications.find(
      (item) => item.status === "available" && item.format === "openapi",
    );
    const selectedSpec =
      !opts.spec && discoveredOpenApiCandidates.length > 1 && catalog.summary.openapi === 1
        ? soleAvailableOpenApi.path
        : opts.spec;
    try {
      const result = reconcileDocumentation(inventoryReport, {
        root,
        scan,
        discovery,
        applicationId: selected,
        spec: selectedSpec,
        jsdoc: opts.jsdoc,
      });
      documentation = {
        status: "merged",
        document: result.document,
        report: result.report,
        specifications: catalog.specifications,
        summary: catalog.summary,
      };
    } catch (err) {
      const multipleOpenApi = !selectedSpec && catalog.summary.openapi > 1;
      if (multipleOpenApi && retainDocuments) {
        reconcileUnambiguousSpecifications(
          inventoryReport,
          { root, scan, discovery, retainDocuments },
          catalog,
        );
        documentation = {
          status: "cataloged",
          reason:
            `${catalog.summary.available} API contracts were retained independently ` +
            `(${catalog.summary.openapi} OpenAPI 3, ${catalog.summary.swagger} Swagger 2); ` +
            "no canonical OpenAPI merge was selected. Use scan-repo --spec <path> to request one explicitly.",
          specifications: catalog.specifications,
          summary: catalog.summary,
        };
      } else {
        documentation = {
          status:
            err.code === "APPLICATION_SELECTION_REQUIRED"
              ? "needs-application-selection"
              : "needs-input",
          reason: safeDocumentationError(err, root),
          specifications: catalog.specifications,
          summary: catalog.summary,
          ...(Array.isArray(err.applicationIds) ? { applicationIds: err.applicationIds } : {}),
        };
      }
    }
    progress({
      phase: "cleaning-up",
      documentationStatus: documentation.status,
      routes: inventoryReport.routes.length,
    });
    return {
      schemaVersion: "1.0",
      tool: "express-recon",
      toolVersion: pkg.version,
      kind: "repository-scan",
      repository: acquired.provenance,
      discovery,
      inventory: inventoryReport,
      documentation,
    };
  } finally {
    unregisterTempDir(acquired.temp);
  }
}

module.exports = {
  acquireRepository,
  githubGitConfig,
  normalizeRepository,
  releaseRepository,
  scanRepository,
  validRef,
};
