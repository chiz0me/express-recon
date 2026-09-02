"use strict";

const fs = require("node:fs");
const path = require("node:path");
const pkg = require("../package.json");
const { compareReports } = require("./compare");
const { isFrameworkStatus } = require("./frameworks");

const MAX_JSON_BYTES = 128 * 1024 * 1024;
const MAX_REPOSITORY_DETAILS = 100;
const MAX_TOTAL_DETAILS = 5_000;
const MAX_DIAGNOSTICS = 100;

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function boundedText(value, maximum = 1_000) {
  const normalized = [...String(value ?? "")]
    .map((character) => {
      const code = character.codePointAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("");
  return normalized.length > maximum ? `${normalized.slice(0, maximum - 1)}…` : normalized;
}

function assertOrganizationReport(report, label) {
  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    report.kind !== "github-organization-inventory" ||
    typeof report.organization?.login !== "string" ||
    !Array.isArray(report.repositories)
  ) {
    throw new Error(`${label} must be an express-recon GitHub organization inventory`);
  }
}

function comparableScope(report) {
  const scope = object(report.scope);
  return {
    fingerprint: scope.fingerprint,
    includeArchived: scope.includeArchived === true,
    includeForks: scope.includeForks === true,
    maxRepositories: scope.maxRepositories,
    configHash: scope.configHash,
    scanHash: scope.scanHash,
    repositoryInclude: Array.isArray(scope.repositoryInclude) ? scope.repositoryInclude : [],
    repositoryExclude: Array.isArray(scope.repositoryExclude) ? scope.repositoryExclude : [],
  };
}

function assertComparableOrganizations(baseline, current) {
  const beforeName = baseline.organization.login.toLowerCase();
  const afterName = current.organization.login.toLowerCase();
  if (beforeName !== afterName) {
    throw new Error(
      `baseline organization ${JSON.stringify(baseline.organization.login)} does not match ${JSON.stringify(current.organization.login)}`,
    );
  }
  const before = comparableScope(baseline);
  const after = comparableScope(current);
  if (
    before.fingerprint &&
    after.fingerprint &&
    before.fingerprint !== after.fingerprint &&
    baseline.toolVersion === current.toolVersion
  ) {
    throw new Error(
      "baseline and current organization scopes differ; use the same repository cap, filters, configuration, and scan scope",
    );
  }
  for (const key of [
    "includeArchived",
    "includeForks",
    "maxRepositories",
    "configHash",
    "scanHash",
    "repositoryInclude",
    "repositoryExclude",
  ]) {
    if (
      before[key] !== undefined &&
      after[key] !== undefined &&
      JSON.stringify(before[key]) !== JSON.stringify(after[key])
    ) {
      throw new Error(
        "baseline and current organization scopes differ; use the same repository cap, filters, configuration, and scan scope",
      );
    }
  }
}

function repositoryMap(report, label) {
  const entries = new Map();
  for (const [index, value] of report.repositories.entries()) {
    const entry = object(value);
    const repository = object(entry.repository);
    const fullName = repository.fullName;
    if (typeof fullName !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
      throw new Error(`${label}.repositories[${index}] has an invalid repository.fullName`);
    }
    const expectedName = fullName.split("/")[1];
    if (
      typeof repository.name !== "string" ||
      repository.name.toLowerCase() !== expectedName.toLowerCase()
    ) {
      throw new Error(`${label}.repositories[${index}] has an inconsistent repository.name`);
    }
    const key = fullName.toLowerCase();
    if (entries.has(key)) throw new Error(`${label} contains duplicate repository ${fullName}`);
    entries.set(key, entry);
  }
  return entries;
}

function repositoryState(entry) {
  if (!entry) return null;
  const evidence = Object.keys(object(entry.frameworks)).length
    ? object(entry.frameworks)
    : object(entry.express);
  const frameworks = Array.isArray(entry.frameworks?.names)
    ? entry.frameworks.names.filter((name) => typeof name === "string")
    : entry.status === "express" || entry.express?.detected === true
      ? ["express"]
      : [];
  return {
    status: typeof entry.status === "string" ? entry.status : "unknown",
    commit: typeof entry.commit === "string" ? entry.commit : null,
    coverageComplete: entry.coverageComplete === true && entry.routeGraphComplete !== false,
    frameworks,
    applications: count(evidence.applicationCount),
    routes: count(evidence.routeCount),
    documentationStatus:
      typeof evidence.documentation?.reconciliationStatus === "string"
        ? evidence.documentation.reconciliationStatus
        : null,
  };
}

function repositoryIdentity(before, after) {
  const repository = object((after || before).repository);
  return {
    name:
      typeof repository.name === "string"
        ? repository.name
        : String(repository.fullName).split("/").at(-1),
    fullName: repository.fullName,
  };
}

function compactRoute(route) {
  const source = object(route.source);
  return {
    applicationId:
      route.applicationId === null || route.applicationId === undefined
        ? null
        : boundedText(route.applicationId, 500),
    method: boundedText(route.method, 40),
    path: boundedText(route.path, 2_000),
    ...(route.authStatus ? { authStatus: boundedText(route.authStatus, 40) } : {}),
    ...(route.from ? { from: boundedText(route.from, 40) } : {}),
    ...(route.to ? { to: boundedText(route.to, 40) } : {}),
    ...(Array.isArray(route.changedFields)
      ? { changedFields: route.changedFields.map((field) => boundedText(field, 100)).slice(0, 20) }
      : {}),
    source: source.file
      ? { file: boundedText(source.file, 1_000), ...(source.line ? { line: source.line } : {}) }
      : null,
  };
}

function hasRouteChanges(summary) {
  return (
    summary.addedRoutes > 0 ||
    summary.removedRoutes > 0 ||
    count(summary.changedRoutes) > 0 ||
    summary.authRegressions > 0 ||
    summary.authImprovements > 0 ||
    summary.newFindings > 0 ||
    summary.resolvedFindings > 0
  );
}

function comparisonDetails(delta, budget) {
  const details = {};
  let retained = 0;
  // Preserve the most actionable evidence first when a large organization
  // exhausts its shared detail budget.
  const ordered = [
    "authRegressions",
    "addedRoutes",
    "removedRoutes",
    "changedRoutes",
    "authImprovements",
  ];
  for (const name of ordered) {
    const available = Math.max(0, Math.min(MAX_REPOSITORY_DETAILS - retained, budget.remaining));
    const selected = delta[name].slice(0, available).map(compactRoute);
    if (selected.length) details[name] = selected;
    retained += selected.length;
    budget.remaining -= selected.length;
  }
  const total = ordered.reduce((sum, name) => sum + delta[name].length, 0);
  return {
    ...(retained ? { details } : {}),
    detailsRetained: retained,
    detailsTruncated: total > retained,
  };
}

function compactComparison(delta, budget) {
  return {
    summary: { ...delta.summary },
    ...comparisonDetails(delta, budget),
  };
}

function comparisonNeeded(before, after, baseline, current) {
  if (!before.coverageComplete || !after.coverageComplete) return false;
  if (!isFrameworkStatus(before.status) && !isFrameworkStatus(after.status)) return false;
  // Equal commits produced by the same scanner version and aggregate shape are
  // safe to skip; otherwise exact details are loaded even when counts happen to
  // match because route replacement can have a zero net delta.
  return !(
    before.commit &&
    before.commit === after.commit &&
    baseline.toolVersion === current.toolVersion &&
    before.status === after.status &&
    before.routes === after.routes &&
    before.applications === after.applications
  );
}

function changedEntry(beforeEntry, afterEntry, routeComparison) {
  const before = repositoryState(beforeEntry);
  const after = repositoryState(afterEntry);
  if (!before) {
    return {
      repository: repositoryIdentity(beforeEntry, afterEntry),
      change: "added",
      before: null,
      after,
    };
  }
  if (!after) {
    return {
      repository: repositoryIdentity(beforeEntry, afterEntry),
      change: "removed",
      before,
      after: null,
    };
  }
  const statusChanged = before.status !== after.status;
  const applicationsDelta = after.applications - before.applications;
  const routeCountDelta = after.routes - before.routes;
  const documentationChanged = before.documentationStatus !== after.documentationStatus;
  if (
    !statusChanged &&
    applicationsDelta === 0 &&
    routeCountDelta === 0 &&
    !documentationChanged &&
    (!routeComparison || !hasRouteChanges(routeComparison.summary))
  ) {
    return null;
  }
  return {
    repository: repositoryIdentity(beforeEntry, afterEntry),
    change: "changed",
    before,
    after,
    changes: {
      statusChanged,
      applicationsDelta,
      routeCountDelta,
      documentationChanged,
      ...(routeComparison ? { routes: routeComparison } : {}),
    },
  };
}

function diagnosticMessage(fullName, error) {
  return `${fullName}: ${boundedText(error instanceof Error ? error.message : error, 1_000)}`;
}

function reportReference(report) {
  return {
    schemaVersion: report.schemaVersion || null,
    toolVersion: report.toolVersion || null,
    coverageComplete: report.coverage?.complete === true,
    scopeFingerprint: report.scope?.fingerprint || null,
  };
}

function incrementSummary(summary, entry) {
  if (entry.change === "added") summary.repositoriesAdded++;
  if (entry.change === "removed") summary.repositoriesRemoved++;
  if (entry.changes?.statusChanged) summary.repositoryStatusChanges++;
  const beforeSupported = isFrameworkStatus(entry.before?.status);
  const afterSupported = isFrameworkStatus(entry.after?.status);
  if (!beforeSupported && afterSupported) summary.newlySupportedRepositories++;
  if (beforeSupported && !afterSupported) summary.noLongerSupportedRepositories++;
  if (
    !entry.before?.frameworks?.includes("express") &&
    entry.after?.frameworks?.includes("express")
  ) {
    summary.newlyExpressRepositories++;
  }
  if (
    entry.before?.frameworks?.includes("express") &&
    !entry.after?.frameworks?.includes("express")
  ) {
    summary.noLongerExpressRepositories++;
  }
  const routes = entry.changes?.routes?.summary;
  if (!routes) return;
  if (hasRouteChanges(routes)) summary.repositoriesWithRouteChanges++;
  for (const key of [
    "addedRoutes",
    "removedRoutes",
    "changedRoutes",
    "authRegressions",
    "authImprovements",
    "newFindings",
    "resolvedFindings",
  ]) {
    summary[key] += count(routes[key]);
  }
}

/**
 * Compare two scope-compatible organization inventories. Aggregate lifecycle
 * changes are always available; exact route/auth changes are loaded one
 * repository at a time and retained behind explicit detail bounds.
 */
function compareOrganizationReports(baseline, current, options = {}) {
  assertOrganizationReport(baseline, "baseline");
  assertOrganizationReport(current, "current report");
  assertComparableOrganizations(baseline, current);
  const beforeEntries = repositoryMap(baseline, "baseline");
  const afterEntries = repositoryMap(current, "current report");
  const names = [...new Set([...beforeEntries.keys(), ...afterEntries.keys()])].sort();
  const budget = { remaining: MAX_TOTAL_DETAILS };
  const diagnostics = [];
  const incompleteRepositories = [];
  let exactComparisons = 0;
  let exactComparisonFailures = 0;
  const repositories = [];
  const summary = {
    repositoriesAdded: 0,
    repositoriesRemoved: 0,
    repositoriesChanged: 0,
    repositoryStatusChanges: 0,
    newlySupportedRepositories: 0,
    noLongerSupportedRepositories: 0,
    newlyExpressRepositories: 0,
    noLongerExpressRepositories: 0,
    repositoriesWithRouteChanges: 0,
    routeCountDelta: count(current.summary?.routes) - count(baseline.summary?.routes),
    addedRoutes: 0,
    removedRoutes: 0,
    changedRoutes: 0,
    authRegressions: 0,
    authImprovements: 0,
    newFindings: 0,
    resolvedFindings: 0,
    exactComparisons: 0,
    exactComparisonFailures: 0,
    detailsRetained: 0,
    detailsTruncated: false,
  };

  for (const name of names) {
    const beforeEntry = beforeEntries.get(name) || null;
    const afterEntry = afterEntries.get(name) || null;
    const before = repositoryState(beforeEntry);
    const after = repositoryState(afterEntry);
    let routeComparison = null;
    // Added/removed repositories are lifecycle changes. Treating every route in
    // them as a code-level route addition/removal would inflate route drift and
    // make repository churn indistinguishable from application changes.
    if (beforeEntry && afterEntry && comparisonNeeded(before, after, baseline, current)) {
      try {
        if (
          typeof options.loadBaselineScan !== "function" ||
          typeof options.loadCurrentScan !== "function"
        ) {
          throw new Error("detailed repository artifacts were not provided");
        }
        const beforeScan = options.loadBaselineScan(beforeEntry);
        const afterScan = options.loadCurrentScan(afterEntry);
        const delta = compareReports(beforeScan.inventory, afterScan.inventory);
        routeComparison = compactComparison(delta, budget);
        exactComparisons++;
      } catch (error) {
        exactComparisonFailures++;
        if (incompleteRepositories.length < MAX_DIAGNOSTICS) {
          incompleteRepositories.push(repositoryIdentity(beforeEntry, afterEntry).fullName);
        }
        if (diagnostics.length < MAX_DIAGNOSTICS) {
          diagnostics.push(
            diagnosticMessage(repositoryIdentity(beforeEntry, afterEntry).fullName, error),
          );
        }
      }
    }
    const entry = changedEntry(beforeEntry, afterEntry, routeComparison);
    if (!entry) continue;
    repositories.push(entry);
    incrementSummary(summary, entry);
  }

  summary.repositoriesChanged = repositories.length;
  summary.exactComparisons = exactComparisons;
  summary.exactComparisonFailures = exactComparisonFailures;
  summary.detailsRetained = MAX_TOTAL_DETAILS - budget.remaining;
  summary.detailsTruncated = repositories.some(
    (entry) => entry.changes?.routes?.detailsTruncated === true,
  );
  const aggregateComplete =
    baseline.coverage?.complete === true && current.coverage?.complete === true;
  return {
    schemaVersion: "1.0",
    kind: "github-organization-inventory-delta",
    tool: "express-recon",
    toolVersion: pkg.version,
    organization: { login: current.organization.login },
    baseline: reportReference(baseline),
    current: reportReference(current),
    coverage: {
      complete: aggregateComplete && exactComparisonFailures === 0,
      baselineComplete: baseline.coverage?.complete === true,
      currentComplete: current.coverage?.complete === true,
      exactComparisons,
      exactComparisonFailures,
      incompleteRepositories,
      incompleteRepositoriesTruncated: exactComparisonFailures > incompleteRepositories.length,
    },
    summary,
    repositories,
    diagnostics,
  };
}

function readJson(file, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    throw new Error(`Could not read ${label}: ${error.code || "filesystem error"}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (stat.size <= 0 || stat.size > MAX_JSON_BYTES) {
    throw new Error(`${label} must be between 1 and ${MAX_JSON_BYTES} bytes`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse ${label}: ${error.message}`);
  }
}

function within(base, target) {
  const relative = path.relative(base, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function loadOrganizationSnapshot(inputPath) {
  const input = path.resolve(inputPath);
  let stat;
  try {
    stat = fs.lstatSync(input);
  } catch (error) {
    throw new Error(`Could not read organization baseline ${input}: ${error.message}`);
  }
  if (stat.isSymbolicLink()) throw new Error("organization baseline must not be a symbolic link");
  const file = stat.isDirectory() ? path.join(input, "organization-inventory.json") : input;
  if (!stat.isDirectory() && !stat.isFile()) {
    throw new Error("organization baseline must be a report file or output directory");
  }
  const report = readJson(file, "organization baseline");
  assertOrganizationReport(report, "baseline");
  repositoryMap(report, "baseline");
  return {
    input,
    directoryInput: stat.isDirectory(),
    file,
    root: path.dirname(file),
    realRoot: fs.realpathSync(path.dirname(file)),
    report,
  };
}

function referencedRepositoryScan(snapshot, entry) {
  if (entry.scan && typeof entry.scan === "object" && !Array.isArray(entry.scan)) {
    if (entry.scan.kind !== "repository-scan") {
      throw new Error("embedded repository scan has the wrong kind");
    }
    return entry.scan;
  }
  const reference = entry.artifacts?.repositoryScan;
  if (
    typeof reference !== "string" ||
    !reference ||
    reference.includes("\\") ||
    path.posix.isAbsolute(reference) ||
    reference.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("repositoryScan artifact path must be a safe relative path");
  }
  const candidate = path.resolve(snapshot.root, ...reference.split("/"));
  if (!within(snapshot.root, candidate)) {
    throw new Error("repositoryScan artifact escapes the organization output directory");
  }
  let realCandidate;
  try {
    realCandidate = fs.realpathSync(candidate);
  } catch (error) {
    throw new Error(`repositoryScan artifact is unavailable (${error.code || "filesystem error"})`);
  }
  if (!within(snapshot.realRoot, realCandidate)) {
    throw new Error("repositoryScan artifact symlink escapes the organization output directory");
  }
  const scan = readJson(realCandidate, "repositoryScan artifact");
  if (scan.kind !== "repository-scan" || !scan.inventory || !Array.isArray(scan.inventory.routes)) {
    throw new Error("repositoryScan artifact has the wrong kind or no route inventory");
  }
  return scan;
}

function snapshotFromReport(report, root) {
  return {
    root: path.resolve(root),
    realRoot: fs.realpathSync(root),
    report,
  };
}

module.exports = {
  MAX_JSON_BYTES,
  MAX_REPOSITORY_DETAILS,
  MAX_TOTAL_DETAILS,
  assertComparableOrganizations,
  compareOrganizationReports,
  loadOrganizationSnapshot,
  referencedRepositoryScan,
  snapshotFromReport,
};
