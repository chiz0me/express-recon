"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { organizationCheckpointIdentity } = require("./organization-checkpoint");
const { scanRepository } = require("./repository");
const {
  COMPLETE_REPOSITORY_STATUSES,
  FRAMEWORK_NAMES,
  frameworkName,
  isFrameworkStatus,
  statusForFrameworks,
} = require("./frameworks");
const pkg = require("../package.json");

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_MAX_REPOSITORIES = 100;
const DEFAULT_CONCURRENCY = 1;
const MAX_REPOSITORIES = 10_000;
const MAX_CONCURRENCY = 8;
const MAX_API_PAGES = 1_000;
const MAX_API_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_API_TIMEOUT_MS = 30_000;

function hasControlCharacters(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function sanitizeText(value) {
  let output = "";
  let replacing = false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) {
      if (!replacing) output += " ";
      replacing = true;
    } else {
      output += character;
      replacing = false;
    }
  }
  return output;
}

function validateOrganization(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,99})$/.test(value) ||
    value.endsWith("-")
  ) {
    throw new Error("GitHub organization must contain only letters, numbers, or interior hyphens");
  }
  return value;
}

function validateToken(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 4096 || hasControlCharacters(value)) {
    throw new Error("GitHub token must be a non-empty string without control characters");
  }
  return value;
}

function positiveInteger(value, fallback, label, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function header(response, name) {
  return response?.headers?.get?.(name) ?? null;
}

function numericHeader(response, name) {
  const value = header(response, name);
  if (value === null || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function nextPage(link) {
  return (
    typeof link === "string" &&
    link.split(",").some((part) => /;\s*rel="next"\s*$/.test(part.trim()))
  );
}

function safeApiMessage(text) {
  try {
    const value = JSON.parse(text);
    if (typeof value?.message === "string" && value.message.trim()) {
      return sanitizeText(value.message.trim()).slice(0, 500);
    }
  } catch {
    // A non-JSON response is represented by its status, not reflected verbatim.
  }
  return null;
}

function canonicalRepository(value, organization) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub repository response contained a non-object entry");
  }
  if (
    typeof value.name !== "string" ||
    !/^[A-Za-z0-9_.-]+$/.test(value.name) ||
    value.name === "." ||
    value.name === ".." ||
    typeof value.full_name !== "string"
  ) {
    throw new Error("GitHub repository response contained an invalid name");
  }
  const expected = `${organization}/${value.name}`;
  if (value.full_name.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `GitHub repository ${JSON.stringify(value.full_name)} does not belong to ${organization}`,
    );
  }
  const defaultBranch =
    typeof value.default_branch === "string" &&
    value.default_branch.length <= 255 &&
    value.default_branch.trim() &&
    !hasControlCharacters(value.default_branch)
      ? value.default_branch
      : null;
  return {
    id: Number.isSafeInteger(value.id) ? value.id : null,
    name: value.name,
    fullName: value.full_name,
    url: `https://github.com/${value.full_name}`,
    defaultBranch,
    private: value.private === true,
    visibility: ["public", "private", "internal"].includes(value.visibility)
      ? value.visibility
      : value.private === true
        ? "private"
        : "public",
    archived: value.archived === true,
    disabled: value.disabled === true,
    fork: value.fork === true,
    empty: value.size === 0,
  };
}

async function readApiPage(fetchImpl, organization, page, token, timeoutMs) {
  const url = new URL(`/orgs/${encodeURIComponent(organization)}/repos`, GITHUB_API);
  url.searchParams.set("type", "all");
  url.searchParams.set("sort", "full_name");
  url.searchParams.set("direction", "asc");
  url.searchParams.set("per_page", "100");
  url.searchParams.set("page", String(page));
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `express-recon/${pkg.version}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err?.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : err.message;
    throw new Error(`GitHub repository enumeration failed: ${reason}`);
  }
  const declaredLength = Number(header(response, "content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_API_RESPONSE_BYTES) {
    throw new Error("GitHub repository response exceeded the 16 MiB page limit");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_API_RESPONSE_BYTES) {
    throw new Error("GitHub repository response exceeded the 16 MiB page limit");
  }
  if (!response.ok) {
    const detail = safeApiMessage(text);
    const remaining = numericHeader(response, "x-ratelimit-remaining");
    const rate = remaining === 0 ? "; GitHub API rate limit is exhausted" : "";
    throw new Error(
      `GitHub repository enumeration failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}${rate}`,
    );
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`GitHub repository response was not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(value)) throw new Error("GitHub repository response must be an array");
  return {
    repositories: value.map((repository) => canonicalRepository(repository, organization)),
    hasNext: nextPage(header(response, "link")),
    rateLimit: {
      limit: numericHeader(response, "x-ratelimit-limit"),
      remaining: numericHeader(response, "x-ratelimit-remaining"),
      reset: numericHeader(response, "x-ratelimit-reset"),
    },
  };
}

/**
 * Enumerate every repository visible through the GitHub organization API,
 * following pagination and retaining explicit partial-coverage evidence when
 * a later page cannot be fetched.
 */
async function listOrganizationRepositories(organization, opts = {}) {
  const login = validateOrganization(organization);
  const token = validateToken(opts.token);
  const timeoutMs = positiveInteger(
    opts.apiTimeoutMs,
    DEFAULT_API_TIMEOUT_MS,
    "apiTimeoutMs",
    300_000,
  );
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("This Node.js runtime does not provide fetch() for the GitHub API");
  }
  const byName = new Map();
  const diagnostics = [];
  let page = 1;
  let pagesFetched = 0;
  let complete = true;
  let rateLimit = { limit: null, remaining: null, reset: null };
  while (page <= MAX_API_PAGES) {
    let result;
    try {
      result = await readApiPage(fetchImpl, login, page, token, timeoutMs);
    } catch (err) {
      const failure = safeFailure(err, token);
      if (pagesFetched === 0) throw new Error(failure);
      complete = false;
      diagnostics.push(`github: pagination stopped at page ${page}: ${failure}`);
      break;
    }
    pagesFetched++;
    rateLimit = result.rateLimit;
    for (const repository of result.repositories) {
      const key = repository.fullName.toLowerCase();
      if (byName.has(key)) {
        complete = false;
        diagnostics.push(`github: duplicate paginated repository ${repository.fullName}`);
      } else {
        byName.set(key, repository);
      }
    }
    try {
      opts.onPage?.({
        page,
        pagesFetched,
        repositoriesThisPage: result.repositories.length,
        repositoriesDiscovered: byName.size,
        hasNext: result.hasNext,
        rateLimit,
      });
    } catch {
      // Enumeration progress is best-effort and never changes API evidence.
    }
    if (!result.hasNext) break;
    page++;
  }
  if (page > MAX_API_PAGES) {
    complete = false;
    diagnostics.push(`github: repository pagination exceeded ${MAX_API_PAGES} pages`);
  }
  const repositories = [...byName.values()].sort((left, right) =>
    left.fullName < right.fullName ? -1 : left.fullName > right.fullName ? 1 : 0,
  );
  return {
    organization: login,
    repositories,
    coverage: {
      complete,
      pagesFetched,
      repositoriesVisible: repositories.length,
      visibility: "api-visible",
      authenticated: Boolean(token),
    },
    rateLimit,
    diagnostics,
  };
}

function scanIsComplete(scan) {
  return (
    scan.repository?.acquisition?.complete === true &&
    scan.discovery?.discoveryCoverage?.complete === true &&
    scan.discovery?.scanCoverage?.complete === true &&
    scan.inventory?.scanCoverage?.complete === true
  );
}

function routeGraphIsComplete(scan) {
  return scan.inventory?.routeGraph?.complete !== false;
}

function packageFrameworkEvidence(scan) {
  const result = new Map(FRAMEWORK_NAMES.map((name) => [name, []]));
  for (const item of scan.discovery?.packages || []) {
    const frameworks = Array.isArray(item.frameworks) ? item.frameworks : [];
    for (const framework of frameworks) {
      if (!result.has(framework?.name) || !Array.isArray(framework.packages)) continue;
      result.get(framework.name).push({
        id: item.id,
        root: item.root,
        name: item.name,
        version: item.version,
        declarations: framework.packages,
        classification: framework.classification || null,
      });
    }
    if (!frameworks.some((framework) => framework?.name === "express") && item.express) {
      result.get("express").push({
        id: item.id,
        root: item.root,
        name: item.name,
        version: item.version,
        declarations: [{ package: "express", ...item.express }],
      });
    }
  }
  return result;
}

function dependencySignal(packages) {
  const declarations = packages.flatMap((item) =>
    (item.declarations || []).map((declaration) => ({
      ...declaration,
      packageRoot: item.root,
    })),
  );
  const count = (field) => declarations.filter((item) => item.field === field).length;
  return {
    signal: "package-json-direct-dependency",
    count: declarations.length,
    rootCount: declarations.filter((item) => item.packageRoot === ".").length,
    runtimeCount: count("dependencies"),
    optionalCount: count("optionalDependencies"),
    peerCount: count("peerDependencies"),
    developmentCount: count("devDependencies"),
  };
}

function frameworkClassification({ packages, applications, adapters, routes }) {
  const dependencies = dependencySignal(packages);
  const signals = [];
  if (dependencies.count) signals.push(dependencies.signal);
  if (applications.length) signals.push("application-root");
  if (adapters.length) signals.push("platform-adapter");
  if (routes.length) signals.push("route-registration");
  let role = "dependency-only";
  let confidence = "low";
  if (applications.length) {
    role = "application";
    confidence = "high";
  } else if (adapters.length) {
    role = "platform-adapter";
    confidence = "high";
  } else if (routes.length) {
    role = "route-provider";
    confidence = "medium";
  } else if (dependencies.runtimeCount || dependencies.optionalCount) {
    role = "runtime-dependency";
    confidence = "medium";
  } else if (dependencies.peerCount) {
    role = "peer-dependency";
  } else if (dependencies.developmentCount) {
    role = "development-dependency";
  }
  return { role, confidence, signals, directDependencies: dependencies };
}

function frameworkEvidence(scan) {
  const packages = packageFrameworkEvidence(scan);
  const discoveredApplications = scan.discovery?.applications || [];
  const applications = discoveredApplications.length
    ? discoveredApplications
    : scan.inventory?.applications || [];
  const applicationFrameworks = new Map(
    applications.map((application) => [application.id, frameworkName(application.framework)]),
  );
  const routes = scan.inventory?.routes || [];
  const items = FRAMEWORK_NAMES.map((name) => {
    const matchingApplications = applications.filter(
      (application) => frameworkName(application.framework) === name,
    );
    const matchingAdapters = applications.filter(
      (application) =>
        frameworkName(application.framework) !== name && application.adapter === name,
    );
    const matchingRoutes = routes.filter((route) => {
      if (route.framework) return frameworkName(route.framework) === name;
      const fromApplication = applicationFrameworks.get(route.applicationId);
      return (fromApplication || "express") === name;
    });
    return {
      name,
      detected:
        packages.get(name).length > 0 ||
        matchingApplications.length > 0 ||
        matchingRoutes.length > 0,
      packageCount: packages.get(name).length,
      packages: packages.get(name),
      applicationCount: matchingApplications.length,
      adapterCount: matchingAdapters.length,
      routeCount: matchingRoutes.length,
      classification: frameworkClassification({
        packages: packages.get(name),
        applications: matchingApplications,
        adapters: matchingAdapters,
        routes: matchingRoutes,
      }),
    };
  }).filter((item) => item.detected);
  const documentation = {
    specifications: scan.discovery?.documentation?.specifications?.length || 0,
    jsdocSources: scan.discovery?.documentation?.jsdoc?.length || 0,
    reconciliationStatus: scan.documentation?.status || null,
  };
  return {
    detected: items.length > 0,
    names: items.map((item) => item.name),
    items,
    packageCount: items.reduce((total, item) => total + item.packageCount, 0),
    applicationCount: applications.length,
    routeCount: routes.length,
    documentation,
  };
}

function expressEvidence(scan, frameworks = frameworkEvidence(scan)) {
  const express = frameworks.items.find((item) => item.name === "express");
  return {
    detected: Boolean(express),
    packageCount: express?.packageCount || 0,
    packages: (express?.packages || []).map((item) => ({
      id: item.id,
      root: item.root,
      name: item.name,
      version: item.version,
      declaration: item.declarations[0] || null,
    })),
    applicationCount: express?.applicationCount || 0,
    routeCount: express?.routeCount || 0,
    documentation: frameworks.documentation,
  };
}

function normalizeResumeEntries(value) {
  if (value === undefined) return new Map();
  if (!Array.isArray(value)) throw new Error("resumeEntries must be an array");
  const entries = new Map();
  for (const [index, item] of value.entries()) {
    const label = `resumeEntries[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${label} must be an object`);
    }
    const fullName = item.repository?.fullName;
    if (typeof fullName !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
      throw new Error(`${label}.repository.fullName is invalid`);
    }
    if (!COMPLETE_REPOSITORY_STATUSES.has(item.status) || item.coverageComplete !== true) {
      throw new Error(`${label} is not a complete resumable repository result`);
    }
    const hasExpress =
      item.express && typeof item.express === "object" && !Array.isArray(item.express);
    const hasFrameworks =
      item.frameworks && typeof item.frameworks === "object" && !Array.isArray(item.frameworks);
    if (!hasExpress && !hasFrameworks) {
      throw new Error(`${label} must contain framework evidence`);
    }
    const expectedStatus =
      hasFrameworks && item.frameworks.detected
        ? statusForFrameworks(item.frameworks.names || [])
        : hasExpress && item.express.detected
          ? "express"
          : "not-express";
    if (item.status !== expectedStatus) {
      throw new Error(`${label} framework evidence does not match its status`);
    }
    if (!["inventory", "audit"].includes(item.command)) {
      throw new Error(`${label}.command must be inventory or audit`);
    }
    if (typeof item.commit !== "string" || !/^[a-f0-9]{40,64}$/.test(item.commit)) {
      throw new Error(`${label}.commit must be a Git object id`);
    }
    const key = fullName.toLowerCase();
    if (entries.has(key)) throw new Error(`resumeEntries contains duplicate ${fullName}`);
    entries.set(key, structuredClone(item));
  }
  return entries;
}

function safeFailure(err, token) {
  let message = err instanceof Error ? err.message : String(err);
  if (token) {
    for (const secret of [token, Buffer.from(`x-access-token:${token}`).toString("base64")]) {
      message = message.split(secret).join("[REDACTED]");
    }
  }
  return sanitizeText(message).slice(0, 2_000);
}

function scanInWorker(source, options, onProgress) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env };
    delete environment.GH_TOKEN;
    delete environment.GITHUB_TOKEN;
    const worker = new Worker(path.join(__dirname, "organization-worker.js"), {
      workerData: { source, options },
      env: environment,
    });
    let settled = false;
    worker.on("message", (message) => {
      if (message?.type === "progress") {
        try {
          onProgress?.(message.progress);
        } catch {
          // Progress observers must never change repository scan results.
        }
        return;
      }
      settled = true;
      if (message?.ok) resolve(message.scan);
      else reject(new Error(message?.error || "Organization scan worker failed"));
    });
    worker.once("error", (err) => {
      settled = true;
      reject(err);
    });
    worker.once("exit", (code) => {
      if (!settled && code !== 0) reject(new Error(`Organization scan worker exited ${code}`));
      else if (!settled) reject(new Error("Organization scan worker exited without a result"));
    });
  });
}

function createProgressEmitter(organization, callback, token) {
  const diagnostics = [];
  const startedAt = Date.now();
  let enabled = typeof callback === "function";
  function emit(event) {
    if (!enabled) return;
    try {
      const returned = callback({
        schemaVersion: "1.0",
        kind: "organization-scan-progress",
        timestamp: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        organization,
        ...event,
      });
      if (returned && typeof returned.then === "function") {
        enabled = false;
        diagnostics.push("organization progress callback disabled: onProgress must be synchronous");
        Promise.resolve(returned).catch(() => {});
      }
    } catch (err) {
      enabled = false;
      diagnostics.push(`organization progress callback disabled: ${safeFailure(err, token)}`);
    }
  }
  return { diagnostics, emit, startedAt };
}

async function runPool(entries, concurrency, task) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
    while (cursor < entries.length) {
      const index = cursor++;
      await task(entries[index]);
    }
  });
  await Promise.all(runners);
}

function initialStatus(repository, opts) {
  if (repository.disabled) return "skipped-disabled";
  if (repository.empty) return "empty";
  if (repository.archived && !opts.includeArchived) return "skipped-archived";
  if (repository.fork && !opts.includeForks) return "skipped-fork";
  return "eligible";
}

function aggregateSummary(entries, auditMode) {
  const count = (status) => entries.filter((entry) => entry.status === status).length;
  const supported = entries.filter((entry) => isFrameworkStatus(entry.status));
  const hasApplicationEvidence = (entry) => {
    const evidence = entry.frameworks || entry.express || {};
    if ((evidence.applicationCount || 0) > 0 || (evidence.routeCount || 0) > 0) return true;
    return (evidence.items || []).some((item) =>
      ["application", "platform-adapter", "route-provider"].includes(item.classification?.role),
    );
  };
  const applicationRepositories = supported.filter(hasApplicationEvidence);
  const includesFramework = (entry, name) =>
    entry.frameworks?.names?.includes(name) || (name === "express" && entry.status === "express");
  const summary = {
    repositoriesDiscovered: entries.length,
    repositoriesScanned: entries.filter((entry) => entry.scanned === true).length,
    incompleteRouteGraphs: entries.filter((entry) => entry.routeGraphComplete === false).length,
    supportedRepositories: supported.length,
    applicationRepositories: applicationRepositories.length,
    dependencyOnlyRepositories: supported.length - applicationRepositories.length,
    expressRepositories: supported.filter((entry) => includesFramework(entry, "express")).length,
    fastifyRepositories: supported.filter((entry) => includesFramework(entry, "fastify")).length,
    nestjsRepositories: supported.filter((entry) => includesFramework(entry, "nestjs")).length,
    nonExpressRepositories: count("not-express"),
    inconclusiveRepositories: count("inconclusive"),
    failedRepositories: count("failed"),
    skippedArchived: count("skipped-archived"),
    skippedForks: count("skipped-fork"),
    skippedDisabled: count("skipped-disabled"),
    emptyRepositories: count("empty"),
    skippedByLimit: count("skipped-limit"),
    applications: supported.reduce(
      (total, entry) => total + (entry.frameworks || entry.express).applicationCount,
      0,
    ),
    routes: supported.reduce(
      (total, entry) => total + (entry.frameworks || entry.express).routeCount,
      0,
    ),
  };
  if (auditMode) {
    summary.auth = { public: 0, unknown: 0, proven: 0, accepted: 0, policyViolations: 0 };
    for (const entry of supported) {
      const report = entry.auditSummary || {};
      for (const key of Object.keys(summary.auth)) summary.auth[key] += report[key] || 0;
    }
  }
  return summary;
}

/**
 * Scan a bounded set of organization repositories with failure isolation and
 * per-repository cleanup. Progress callbacks are observational: their failure
 * is recorded but cannot change inventory evidence.
 */
async function scanOrganization(organization, opts = {}) {
  const login = validateOrganization(organization);
  const token = validateToken(opts.token);
  if (opts.onProgress !== undefined && typeof opts.onProgress !== "function") {
    throw new Error("onProgress must be a function");
  }
  const maxRepositories = positiveInteger(
    opts.maxRepositories,
    DEFAULT_MAX_REPOSITORIES,
    "maxRepositories",
    MAX_REPOSITORIES,
  );
  const concurrency = positiveInteger(
    opts.concurrency,
    DEFAULT_CONCURRENCY,
    "concurrency",
    MAX_CONCURRENCY,
  );
  const resumeEntries = normalizeResumeEntries(opts.resumeEntries);
  if (resumeEntries.size && opts.retainScans !== false) {
    throw new Error("resumeEntries requires retainScans: false because checkpoints are compact");
  }
  if (concurrency > 1 && !opts.scanRepositoryImpl) {
    try {
      structuredClone({
        config: opts.config || {},
        scan: opts.scan || {},
        githubToken: token || undefined,
      });
    } catch (err) {
      throw new Error(
        `concurrency greater than 1 requires cloneable scan configuration: ${err.message}`,
      );
    }
  }
  const identity = organizationCheckpointIdentity(login, {
    config: opts.config || {},
    scan: opts.scan || {},
    maxRepositories,
    includeArchived: opts.includeArchived,
    includeForks: opts.includeForks,
  });
  const progress = createProgressEmitter(login, opts.onProgress, token);
  progress.emit({ event: "enumeration-started" });
  let listing;
  try {
    listing = await listOrganizationRepositories(login, {
      token,
      fetchImpl: opts.fetchImpl,
      apiTimeoutMs: opts.apiTimeoutMs,
      onPage(event) {
        progress.emit({ event: "enumeration-page", ...event });
      },
    });
  } catch (err) {
    progress.emit({ event: "enumeration-failed", error: safeFailure(err, token) });
    throw err;
  }
  const entries = listing.repositories.map((repository) => ({
    repository,
    status: initialStatus(repository, opts),
  }));
  const eligible = entries.filter((entry) => entry.status === "eligible");
  for (const entry of eligible.slice(maxRepositories)) entry.status = "skipped-limit";
  const selected = eligible.slice(0, maxRepositories);
  const pending = [];
  for (const entry of selected) {
    const resumed = resumeEntries.get(entry.repository.fullName.toLowerCase());
    if (
      !resumed ||
      (resumed.repository.id !== null &&
        entry.repository.id !== null &&
        resumed.repository.id !== entry.repository.id)
    ) {
      pending.push(entry);
      continue;
    }
    entry.status = resumed.status;
    entry.scanned = true;
    entry.resumed = true;
    entry.express = resumed.express;
    if (resumed.frameworks) entry.frameworks = resumed.frameworks;
    entry.coverageComplete = true;
    entry.routeGraphComplete = resumed.routeGraphComplete !== false;
    entry.command = resumed.command;
    entry.auditSummary = resumed.auditSummary || null;
    entry.commit = resumed.commit || null;
    if (resumed.artifacts) entry.artifacts = resumed.artifacts;
  }
  const selectedIndexes = new Map(
    selected.map((entry, index) => [entry.repository.fullName.toLowerCase(), index + 1]),
  );
  const resumed = selected.filter((entry) => entry.resumed === true);
  progress.emit({
    event: "enumeration-completed",
    discovered: entries.length,
    eligible: eligible.length,
    selected: selected.length,
    pending: pending.length,
    resumed: resumed.length,
    skipped: entries.length - selected.length,
    total: selected.length,
    concurrency,
    pagesFetched: listing.coverage.pagesFetched,
    enumerationComplete: listing.coverage.complete,
  });
  for (const entry of entries.filter(
    (item) => item.status.startsWith("skipped-") || item.status === "empty",
  )) {
    progress.emit({
      event: "repository-skipped",
      repository: entry.repository.fullName,
      status: entry.status,
    });
  }
  let processed = 0;
  let failed = 0;
  let active = 0;
  for (const entry of resumed) {
    processed++;
    progress.emit({
      event: "repository-resumed",
      repository: entry.repository.fullName,
      index: selectedIndexes.get(entry.repository.fullName.toLowerCase()),
      status: entry.status,
      routeGraphComplete: entry.routeGraphComplete,
      routes: (entry.frameworks || entry.express).routeCount,
      applications: (entry.frameworks || entry.express).applicationCount,
      processed,
      total: selected.length,
      active,
      failed,
      concurrency,
    });
  }
  const scanner = async (source, options, onProgress) => {
    if (opts.scanRepositoryImpl) {
      return opts.scanRepositoryImpl(source, { ...options, onProgress });
    }
    if (concurrency > 1) return scanInWorker(source, options, onProgress);
    return scanRepository(source, { ...options, onProgress });
  };
  await runPool(pending, concurrency, async (entry) => {
    const startedAt = Date.now();
    const repositoryName = entry.repository.fullName;
    const index = selectedIndexes.get(repositoryName.toLowerCase());
    active++;
    progress.emit({
      event: "repository-started",
      repository: repositoryName,
      index,
      processed,
      total: selected.length,
      active,
      failed,
      concurrency,
    });
    try {
      const scan = await scanner(
        entry.repository.fullName,
        {
          ref: "HEAD",
          config: opts.config || {},
          scan: opts.scan || {},
          githubToken: token || undefined,
        },
        (event) => {
          progress.emit({
            event: "repository-phase",
            repository: repositoryName,
            index,
            phase: event?.phase || "scanning",
            processed,
            total: selected.length,
            active,
            failed,
            concurrency,
          });
        },
      );
      const frameworks = frameworkEvidence(scan);
      const evidence = expressEvidence(scan, frameworks);
      const coverageComplete = scanIsComplete(scan);
      const routeGraphComplete = routeGraphIsComplete(scan);
      entry.scanned = true;
      entry.express = evidence;
      entry.frameworks = frameworks;
      entry.coverageComplete = coverageComplete;
      entry.routeGraphComplete = routeGraphComplete;
      entry.command = scan.inventory?.command || "inventory";
      entry.auditSummary = scan.inventory?.summary || null;
      entry.commit = scan.repository?.commit || null;
      entry.status = frameworks.detected
        ? statusForFrameworks(frameworks.names)
        : coverageComplete
          ? "not-express"
          : "inconclusive";
      if (typeof opts.onRepository === "function") {
        const artifacts = await opts.onRepository({
          repository: entry.repository,
          status: entry.status,
          express: evidence,
          frameworks,
          coverageComplete,
          routeGraphComplete,
          scan,
        });
        if (artifacts) entry.artifacts = artifacts;
      }
      if (opts.retainScans !== false) entry.scan = scan;
      active--;
      processed++;
      progress.emit({
        event: "repository-completed",
        repository: repositoryName,
        index,
        status: entry.status,
        routes: frameworks.routeCount,
        applications: frameworks.applicationCount,
        coverageComplete,
        routeGraphComplete,
        durationMs: Date.now() - startedAt,
        processed,
        total: selected.length,
        active,
        failed,
        concurrency,
      });
    } catch (err) {
      entry.scanned = entry.scanned === true;
      entry.status = "failed";
      entry.error = safeFailure(err, token);
      active--;
      processed++;
      failed++;
      progress.emit({
        event: "repository-failed",
        repository: repositoryName,
        index,
        error: entry.error,
        durationMs: Date.now() - startedAt,
        processed,
        total: selected.length,
        active,
        failed,
        concurrency,
      });
    }
  });
  const auditMode = entries.some((entry) => entry.command === "audit");
  const summary = aggregateSummary(entries, auditMode);
  summary.repositoriesResumed = entries.filter((entry) => entry.resumed === true).length;
  const incompleteRepositories = entries
    .filter(
      (entry) =>
        entry.status === "failed" ||
        entry.status === "inconclusive" ||
        entry.status === "skipped-limit" ||
        entry.coverageComplete === false ||
        entry.routeGraphComplete === false,
    )
    .map((entry) => entry.repository.fullName);
  const complete = listing.coverage.complete && incompleteRepositories.length === 0;
  const result = {
    schemaVersion: "1.0",
    tool: "express-recon",
    toolVersion: pkg.version,
    kind: "github-organization-inventory",
    organization: {
      login: listing.organization,
      api: GITHUB_API,
      authenticated: Boolean(token),
      repositoryVisibility: "api-visible",
    },
    scope: {
      includeArchived: opts.includeArchived === true,
      includeForks: opts.includeForks === true,
      maxRepositories,
      concurrency,
      resumeEntriesProvided: resumeEntries.size,
      executionMode: "static",
      executedTargetCode: false,
      fingerprint: identity.fingerprint,
      configHash: identity.scope.configHash,
      scanHash: identity.scope.scanHash,
    },
    coverage: {
      complete,
      enumeration: listing.coverage,
      incompleteRepositories,
    },
    rateLimit: listing.rateLimit,
    summary,
    repositories: entries,
    diagnostics: [],
  };
  progress.emit({
    event: "scan-finished",
    complete,
    completed: processed,
    processed,
    total: selected.length,
    active,
    failed,
    expressRepositories: summary.expressRepositories,
    supportedRepositories: summary.supportedRepositories,
    fastifyRepositories: summary.fastifyRepositories,
    nestjsRepositories: summary.nestjsRepositories,
    failedRepositories: summary.failedRepositories,
    inconclusiveRepositories: summary.inconclusiveRepositories,
    incompleteRouteGraphs: summary.incompleteRouteGraphs,
    repositoriesResumed: summary.repositoriesResumed,
    durationMs: Date.now() - progress.startedAt,
  });
  result.diagnostics = [...listing.diagnostics, ...progress.diagnostics];
  return result;
}

module.exports = {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_REPOSITORIES,
  GITHUB_API_VERSION,
  listOrganizationRepositories,
  scanRepositoryInWorker: scanInWorker,
  scanOrganization,
  validateOrganization,
};
