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
const { discover } = require("./discover");
const { reconcileDocumentation } = require("./docs");
const {
  MIDDLEWARE_ASSESSMENT_SCHEMA,
  applyMiddlewareAssessments,
  createMiddlewareReview,
  validateAssessment,
} = require("./review");
const { acquireRepository, scanRepository } = require("./repository");
const { listOrganizationRepositories, scanOrganization } = require("./organization");
const { renderHtmlSite } = require("./html");

/**
 * express-recon — an inventory + audit harness for Express 4/5 route surfaces,
 * usable from the CLI, a library, or an AI agent.
 *
 * Primitives:
 *   - `inventory(opts)`            raw routes + middleware + source, no judgment
 *   - `discover(root, opts)`       packages, apps, entry candidates, and API docs
 *   - `audit(opts, config)`        classify the inventory against an auth allowlist
 *   - `suggestAuth(registry)`      propose allowlist candidates from an inventory
 *   - `buildReport(registry, meta)`  versioned machine-readable contract
 *   - `compareReports(before, after)` baseline delta + net-new findings
 *   - `evaluatePolicies(registry, policies)` enforce configurable route controls
 *   - `instrument(express)`        capture mount paths before app boot (runtime)
 *   - `executeRuntime(appPath, boot)` boot + walk an app in a bounded worker
 *   - `loadConfig(path)`            load JS, JSON, or YAML configuration
 *   - `reconcileDocumentation()`    merge authored OpenAPI, JSDoc, and inventory
 *   - `createMiddlewareReview()`    bounded provider-neutral review evidence
 *   - `scanRepository()`            acquire one Git ref and statically scan it
 *   - `scanOrganization()`          enumerate API-visible repos and scan a bounded pool
 *   - `renderHtmlSite()`             render existing reports as a static offline site
 *
 * `opts` is `{ mode: "static"|"runtime"|"hybrid", src?, app? }`.
 */
module.exports = {
  inventory,
  discover,
  reconcileDocumentation,
  createMiddlewareReview,
  applyMiddlewareAssessments,
  validateAssessment,
  MIDDLEWARE_ASSESSMENT_SCHEMA,
  acquireRepository,
  scanRepository,
  listOrganizationRepositories,
  scanOrganization,
  renderHtmlSite,
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
