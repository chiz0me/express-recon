"use strict";

// Rendering adapter only: Gin's classifications are retained, never re-audited.
const fs = require("node:fs");
const path = require("node:path");
const array = (value) => (Array.isArray(value) ? value : []);
const number = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

function isGinFleet(value) {
  return value?.tool === "gin-recon" && value.kind === "fleet" && Array.isArray(value.targets);
}

function normalizeGinReport(report, module = "root") {
  if (report?.tool !== "gin-recon" || !Array.isArray(report.routes)) {
    throw new Error("expected a gin-recon route report");
  }
  const routes = report.routes.map((route) => ({
    ...route,
    framework: "gin",
    path: route.ginPath ?? route.normalizedPath ?? "<unresolved>",
    applicationId: module,
    middlewares: array(route.middleware).map((item) => ({ ...item, name: item.displayName })),
    authStatus: route.auth?.authStatus || "unknown",
    tags: array(route.auth?.tags),
    roles: array(route.auth?.roles),
    scopes: array(route.auth?.scopes),
    accepted: route.auth?.accepted === true,
  }));
  return {
    ...report,
    command: report.command || "audit",
    mode: report.analysisProfile || "static",
    routes,
    applications: [{ id: module, name: module, routeCount: routes.length, framework: "gin" }],
    findings: array(report.findings).map((finding) => ({
      ...finding,
      method: String(finding.route || "").split(" ")[0],
      path: String(finding.route || "")
        .split(" ")
        .slice(1)
        .join(" "),
    })),
    summary: {
      routes: routes.length,
      ...Object.fromEntries(
        ["public", "unknown", "proven"].map((status) => [
          status,
          routes.filter((route) => route.authStatus === status).length,
        ]),
      ),
      accepted: routes.filter((route) => route.accepted).length,
    },
  };
}

function combineInventories(reports, complete) {
  const result = {
    tool: "gin-recon",
    command: "audit",
    mode: "imported static",
    summary: {},
    scanCoverage: { complete },
  };
  for (const key of ["routes", "applications", "findings", "diagnostics"]) {
    result[key] = reports.flatMap((report) => array(report[key]));
  }
  for (const key of ["routes", "public", "unknown", "proven", "accepted"]) {
    result.summary[key] = reports.reduce((sum, report) => sum + number(report.summary?.[key]), 0);
  }
  for (const key of [
    "discoveredFiles",
    "analyzedFiles",
    "failedFiles",
    "discoveredPackages",
    "analyzedPackages",
    "failedPackages",
    "unresolvedRegistrations",
  ]) {
    result.scanCoverage[key] = reports.reduce(
      (sum, report) => sum + number(report.scanCoverage?.[key]),
      0,
    );
  }
  result.scanCoverage.reachedLimits = reports.flatMap((report) =>
    array(report.scanCoverage?.reachedLimits),
  );
  return result;
}

function readGinFleet(file, readJson, readSpecification, warnings) {
  const fleet = readJson(file);
  if (!isGinFleet(fleet)) throw new Error("fleet.json is not a gin-recon fleet");
  if (fleet.targets.length > 20000) throw new Error("Gin fleet exceeds 20000 targets");
  const root = fs.realpathSync(path.dirname(file));
  let bytes = 0;
  const read = (reference, reader = readJson) => {
    if (
      typeof reference !== "string" ||
      !reference ||
      path.isAbsolute(reference) ||
      reference.split(/[\\/]/).some((part) => part === ".." || part === ".clones")
    ) {
      throw new Error("Gin artifact must be a contained relative path");
    }
    const candidate = fs.realpathSync(path.resolve(root, reference));
    const relative = path.relative(root, candidate);
    if (
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).includes(".clones")
    ) {
      throw new Error("Gin artifact escapes the input folder");
    }
    const stat = fs.statSync(candidate);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
      throw new Error("Gin artifact is not a bounded regular file");
    bytes += stat.size;
    if (bytes > 256 * 1024 * 1024)
      throw new Error("Gin artifacts exceed the 256 MiB import budget");
    return reader(candidate);
  };
  const safeRead = (reference, label, reader) => {
    try {
      return read(reference, reader);
    } catch (error) {
      warnings.push(`${label}: ${String(error.message).split(root).join(".")}`);
      return null;
    }
  };
  const repositories = fleet.targets.map((target) => {
    const repository = {
      ...target.repository,
      name: target.name,
      fullName: target.repository?.fullName || `${fleet.scope?.org || "unknown"}/${target.name}`,
    };
    const modules = array(target.modules);
    if (modules.length > 500 || array(target.artifacts).length > 2000)
      throw new Error("Gin target has too many modules or artifacts");
    const records = modules.length ? modules : [target];
    const reports = [],
      specifications = [],
      files = [],
      seen = new Set();
    let complete = target.complete === true && !["failed", "inconclusive"].includes(target.status);
    for (const module of records) {
      if (module !== target && module.status && module.status !== "ok") complete = false;
      if (module.complete === false) complete = false;
      if (!module.report) {
        if (target.status === "ok") complete = false;
        continue;
      }
      if (seen.has(module.report)) continue;
      seen.add(module.report);
      const raw = safeRead(module.report, repository.fullName);
      if (!raw) {
        complete = false;
        continue;
      }
      try {
        const report = normalizeGinReport(raw, `gin:${module.id || "root"}`);
        reports.push(report);
        files.push({ label: module.report, value: raw });
        if (report.scanCoverage?.complete !== true) complete = false;
      } catch (error) {
        warnings.push(`${repository.fullName}: ${error.message}`);
        complete = false;
      }
    }
    const artifacts = [
      ...array(target.artifacts),
      ...modules.flatMap((module) => array(module.artifacts)),
    ];
    if (artifacts.length > 2000) throw new Error("Gin target has too many artifacts");
    for (const artifact of artifacts) {
      if (
        artifact.tree === "html" ||
        !/(?:^|\/)openapi\.json$/.test(artifact.path || "") ||
        seen.has(artifact.path)
      )
        continue;
      seen.add(artifact.path);
      const document = safeRead(artifact.path, `${repository.fullName} OpenAPI`, readSpecification);
      if (document) {
        specifications.push({ path: artifact.path, title: `Gin ${artifact.path}`, document });
        files.push({ label: artifact.path, value: document });
      }
    }
    for (const module of records) {
      const reference = module.suggestionArtifact?.path;
      if (!reference || seen.has(reference)) continue;
      seen.add(reference);
      const value = safeRead(reference, `${repository.fullName} suggestions`);
      if (value) files.push({ label: reference, value });
    }
    const inventory = combineInventories(reports, complete);
    const scan = {
      kind: "repository-scan",
      repository: {
        source: repository.fullName,
        commit: repository.scannedCommit,
        requestedRef: repository.ref,
      },
      inventory,
      documentation: { status: specifications.length ? "cataloged" : "not-found", specifications },
      gin: {
        toolVersion: fleet.toolVersion,
        authConfig: fleet.authConfig,
        modules: records.map(({ id, path, status, complete, error }) => ({
          id,
          path,
          status,
          complete,
          error,
        })),
        candidates: files.flatMap((file) =>
          array(file.value.candidates).map((candidate) => ({ ...candidate, module: file.label })),
        ),
        files,
      },
    };
    return {
      repository,
      producer: "gin-recon",
      status: target.status === "ok" ? "gin" : target.status || "unknown",
      scanned: target.status === "ok" || reports.length > 0,
      coverageComplete: complete,
      routeGraphComplete: complete,
      error: target.error,
      frameworks: {
        applicationCount: reports.length,
        routeCount: inventory.routes.length,
        documentation: { reconciliationStatus: specifications.length ? "cataloged" : "not-found" },
      },
      ...(target.status === "ok" ||
      reports.length ||
      target.status === "failed" ||
      target.status === "inconclusive"
        ? { ginScan: scan }
        : {}),
    };
  });
  const files = [{ label: "fleet.json", value: fleet }];
  if (fs.existsSync(path.join(root, "fleet-auth-candidates.json"))) {
    const value = safeRead("fleet-auth-candidates.json", "Gin fleet auth candidates");
    if (value) files.push({ label: "fleet-auth-candidates.json", value });
  }
  return {
    repositories,
    organization: { login: fleet.scope?.org },
    gin: {
      toolVersion: fleet.toolVersion,
      totals: fleet.totals,
      authConfig: fleet.authConfig,
      discoveryComplete: fleet.scope?.discoveryComplete,
      files,
      candidates: array(
        files.find((item) => item.label === "fleet-auth-candidates.json")?.value?.candidates,
      ),
      candidateCount: array(
        files.find((item) => item.label === "fleet-auth-candidates.json")?.value?.candidates,
      ).length,
    },
    coverage: {
      complete: fleet.coverage?.complete === true,
      incompleteRepositories: repositories
        .filter((entry) => !entry.coverageComplete)
        .map((entry) => entry.repository.fullName),
    },
  };
}

module.exports = { isGinFleet, normalizeGinReport, combineInventories, readGinFleet };
