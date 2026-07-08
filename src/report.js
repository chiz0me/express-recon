"use strict";

const { buildFindings } = require("./findings");

const SCHEMA_VERSION = "1.0";

function summarize(routes) {
  const summary = { routes: routes.length, public: 0, unknown: 0, proven: 0, accepted: 0 };
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
 * @param {{command: "inventory"|"audit", mode: string}} meta
 * @returns {object}
 */
function buildReport(registry, meta) {
  const report = {
    schemaVersion: SCHEMA_VERSION,
    tool: "express-recon",
    command: meta.command,
    mode: meta.mode,
    routes: registry.routes,
    globalMiddleware: registry.globalMiddleware,
  };
  if (registry.diagnostics && registry.diagnostics.length) {
    report.diagnostics = registry.diagnostics;
  }
  if (meta.command === "audit") {
    report.summary = summarize(registry.routes);
    report.findings = buildFindings(registry.routes, registry.acceptedPublic);
  }
  return report;
}

module.exports = { buildReport, SCHEMA_VERSION };
