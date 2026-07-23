"use strict";

const { inventory, audit } = require("./harness");
const { buildReport } = require("./report");
const { suggestAuth } = require("./suggest");
const { REPORT_SCHEMA } = require("./schema");
const { instrument } = require("./runtime/instrument");
const { executeRuntime } = require("./runtime/execute");
const { reconcile } = require("./reconcile");
const { evaluatePolicies, normalizePolicies } = require("./policies");
const { compareReports } = require("./compare");
const { loadConfig, validateConfig } = require("./config");

/**
 * express-recon — an inventory + audit harness for Express 4/5 route surfaces,
 * usable from the CLI, a library, or an AI agent.
 *
 * Primitives:
 *   - `inventory(opts)`            raw routes + middleware + source, no judgment
 *   - `audit(opts, config)`        classify the inventory against an auth allowlist
 *   - `suggestAuth(registry)`      propose allowlist candidates from an inventory
 *   - `buildReport(registry, meta)`  versioned machine-readable contract
 *   - `compareReports(before, after)` baseline delta + net-new findings
 *   - `evaluatePolicies(registry, policies)` enforce configurable route controls
 *   - `instrument(express)`        capture mount paths before app boot (runtime)
 *   - `executeRuntime(appPath, boot)` boot + walk an app in a bounded worker
 *   - `loadConfig(path)`            load JS, JSON, or YAML configuration
 *
 * `opts` is `{ mode: "static"|"runtime"|"hybrid", src?, app? }`.
 */
module.exports = {
  inventory,
  audit,
  suggestAuth,
  buildReport,
  reconcile,
  evaluatePolicies,
  normalizePolicies,
  compareReports,
  instrument,
  executeRuntime,
  loadConfig,
  validateConfig,
  REPORT_SCHEMA,
  formatters: {
    json: require("./formatters/json"),
    markdown: require("./formatters/markdown"),
    pretty: require("./formatters/pretty"),
    openapi: require("./formatters/openapi"),
  },
};
