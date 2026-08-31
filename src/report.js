"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { buildFindings } = require("./findings");
const pkg = require("../package.json");

const SCHEMA_VERSION = "2.0";

function canonical(value, seen = new Set()) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") {
    if (typeof value === "function") return `[function:${value.name || "anonymous"}]`;
    return value;
  }
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => canonical(item, seen));
    seen.delete(value);
    return result;
  }
  const result = Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key], seen)])
      .filter(([, normalized]) => normalized !== undefined),
  );
  seen.delete(value);
  return result;
}

function configHash(config) {
  if (!config || Object.keys(config).length === 0) return undefined;
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(config)))
    .digest("hex");
}

function relativeFile(file, root) {
  if (!root || !file || !path.isAbsolute(file)) return file;
  const relative = path.relative(root, file);
  if (relative === "" || relative === ".") return ".";
  if (relative === ".." || relative.startsWith(".." + path.sep)) return file;
  return relative.split(path.sep).join("/");
}

function normalizeSource(source, root) {
  return source && source.file ? { ...source, file: relativeFile(source.file, root) } : source;
}

function normalizeObservation(observation, root) {
  return observation ? { ...observation, source: normalizeSource(observation.source, root) } : null;
}

function normalizeRoute(route, root) {
  return {
    ...route,
    applicationId: route.applicationId ?? null,
    source: normalizeSource(route.source, root),
    ...(route.io
      ? {
          io: {
            ...route.io,
            handlerSource: normalizeSource(route.io.handlerSource, root),
          },
        }
      : {}),
    ...(route.observations
      ? {
          observations: {
            ...route.observations,
            static: normalizeObservation(route.observations.static, root),
            runtime: normalizeObservation(route.observations.runtime, root),
          },
        }
      : {}),
  };
}

function compareRoutes(a, b) {
  for (const [left, right] of [
    [a.applicationId || "", b.applicationId || ""],
    [a.path, b.path],
    [a.method, b.method],
    [a.source?.file || "", b.source?.file || ""],
  ]) {
    if (left !== right) return left < right ? -1 : 1;
  }
  return (a.source?.line || 0) - (b.source?.line || 0);
}

function normalizeApplications(applications, root) {
  return (applications || [])
    .map((application) => ({
      ...application,
      source: normalizeSource(application.source, root),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function normalizeDiagnostics(diagnostics, root) {
  if (!root) return diagnostics;
  const normalizedRoot = path.resolve(root);
  return diagnostics.map((message) => message.split(normalizedRoot).join("."));
}

function normalizeRouteGraph(graph, root) {
  if (!graph) return undefined;
  return {
    ...graph,
    opaqueMounts: (graph.opaqueMounts || []).map((mount) => ({
      ...mount,
      source: normalizeSource(mount.source, root),
    })),
  };
}

function summarize(routes, findings) {
  const summary = {
    routes: routes.length,
    public: 0,
    unknown: 0,
    proven: 0,
    accepted: 0,
    policyViolations: findings.filter((finding) => finding.id === "policy-violation").length,
    policyExceptions: 0,
  };
  for (const r of routes) {
    if (r.authStatus === "public" || r.authStatus === "unknown" || r.authStatus === "proven")
      summary[r.authStatus]++;
    if (r.accepted) summary.accepted++;
  }
  return summary;
}

/**
 * Assemble the versioned, machine-readable report that is the harness's
 * contract for agents and CI. `audit` reports add `summary` + `findings`;
 * `inventory` reports omit all security judgment.
 *
 * @param {{routes: object[], globalMiddleware: object[]}} registry
 * @param {{command: "inventory"|"audit", mode: string, target?: {name?: string, version?: string}}} meta
 * @returns {object}
 */
function buildReport(registry, meta) {
  const sourceRoot = meta.sourceRoot && path.resolve(meta.sourceRoot);
  const routes = registry.routes
    .map((route) => normalizeRoute(route, sourceRoot))
    .sort(compareRoutes);
  const report = {
    schemaVersion: SCHEMA_VERSION,
    tool: "express-recon",
    toolVersion: pkg.version,
    command: meta.command,
    mode: meta.mode,
    applications: normalizeApplications(registry.applications, sourceRoot),
    routes,
    globalMiddleware: registry.globalMiddleware,
  };
  const fingerprint = configHash(meta.config);
  if (fingerprint) report.configHash = fingerprint;
  if (meta.target) report.target = meta.target;
  if (registry.diagnostics && registry.diagnostics.length) {
    report.diagnostics = normalizeDiagnostics(registry.diagnostics, sourceRoot);
  }
  if (registry.scanCoverage) report.scanCoverage = registry.scanCoverage;
  if (registry.routeGraph) report.routeGraph = normalizeRouteGraph(registry.routeGraph, sourceRoot);
  if (registry.openapi) report.openapi = registry.openapi;
  if (meta.command === "audit") {
    if (registry.policies && registry.policies.length) report.policies = registry.policies;
    if (registry.policyExceptions && registry.policyExceptions.length) {
      report.policyExceptions = registry.policyExceptions;
    }
    report.findings = buildFindings(
      routes,
      registry.acceptedPublic,
      (registry.policyFindings || []).map((finding) => ({
        ...finding,
        source: normalizeSource(finding.source, sourceRoot),
      })),
    );
    report.summary = summarize(routes, report.findings);
    report.summary.policyExceptions = registry.policyExceptions?.length || 0;
  }
  return report;
}

module.exports = { buildReport, configHash, SCHEMA_VERSION };
