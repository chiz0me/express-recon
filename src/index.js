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
const { compareOrganizationReports } = require("./organization-compare");
const { compareOpenApiDocuments } = require("./openapi-compare");
const { validateOpenApiDocument } = require("./openapi-validation");
const { refreshDocumentation } = require("./refresh");
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
const {
  buildNotificationEvents,
  deliverWebhook,
  signWebhook,
  validateNotificationEvent,
  verifyWebhookSignature,
} = require("./notify");

/**
 * express-recon — an offline-first inventory and audit harness for Express,
 * Fastify, and NestJS route surfaces, usable from a CLI, library, or AI agent.
 *
 * Primitives:
 *   - `inventory(opts)`            raw routes + middleware + source, no judgment
 *   - `discover(root, opts)`       packages, apps, entry candidates, and API docs
 *   - `audit(opts, config)`        classify the inventory against an auth allowlist
 *   - `suggestAuth(registry)`      propose allowlist candidates from an inventory
 *   - `buildReport(registry, meta)`  versioned machine-readable contract
 *   - `compareReports(before, after)` baseline delta + net-new findings
 *   - `compareOrganizationReports()`  bounded organization/repository route delta
 *   - `compareOpenApiDocuments()`      semantic OpenAPI contract delta
 *   - `evaluatePolicies(registry, policies)` enforce configurable route controls
 *   - `instrument(express)`        capture mount paths before app boot (runtime)
 *   - `executeRuntime(appPath, boot)` boot + walk an app in a bounded worker
 *   - `loadConfig(path)`            load JS, JSON, or YAML configuration
 *   - `reconcileDocumentation()`    merge authored OpenAPI, JSDoc, and inventory
 *   - `refreshDocumentation()`      atomically replace a persistent OpenAPI workspace
 *   - `validateOpenApiDocument()`   validate OpenAPI 3.0/3.1 locally
 *   - `createMiddlewareReview()`    bounded provider-neutral review evidence
 *   - `scanRepository()`            acquire one Git ref and statically scan it
 *   - `scanOrganization()`          enumerate API-visible repos and scan a bounded pool
 *   - `renderHtmlSite()`             render reports and optional baseline changes offline
 *   - `buildNotificationEvents()`    create bounded route-change webhook events
 *   - `deliverWebhook()`             deliver one signed, allowlisted HTTPS event
 *
 * `opts` is `{ mode: "static"|"runtime"|"hybrid", src?, app? }`.
 */

/**
 * Public package surface. Keeping every export in this typedef gives editors a
 * concise purpose statement and lets the documentation-coverage check prove
 * that no supported API is published without both code and user documentation.
 *
 * @typedef {Object} ExpressReconAPI
 * @property {typeof inventory} inventory Build a route inventory without security judgment.
 * @property {typeof discover} discover Find packages, supported apps, entries, and API-document sources.
 * @property {typeof reconcileDocumentation} reconcileDocumentation Merge authored API docs with route evidence.
 * @property {typeof refreshDocumentation} refreshDocumentation Replace a persistent OpenAPI workspace atomically.
 * @property {typeof validateOpenApiDocument} validateOpenApiDocument Validate OpenAPI 3.0/3.1 locally.
 * @property {typeof createMiddlewareReview} createMiddlewareReview Create bounded advisory middleware evidence.
 * @property {typeof applyMiddlewareAssessments} applyMiddlewareAssessments Validate and bind advisory assessments.
 * @property {typeof validateAssessment} validateAssessment Validate the provider-neutral assessment schema.
 * @property {typeof MIDDLEWARE_ASSESSMENT_SCHEMA} MIDDLEWARE_ASSESSMENT_SCHEMA JSON Schema for assessment responses.
 * @property {typeof acquireRepository} acquireRepository Materialize a bounded non-executing Git snapshot.
 * @property {typeof scanRepository} scanRepository Scan one Git ref and clean up its source snapshot.
 * @property {typeof listOrganizationRepositories} listOrganizationRepositories Enumerate API-visible organization repositories.
 * @property {typeof scanOrganization} scanOrganization Build a bounded organization inventory.
 * @property {typeof renderHtmlSite} renderHtmlSite Render saved reports as an offline site.
 * @property {typeof buildNotificationEvents} buildNotificationEvents Build bounded webhook events from report deltas.
 * @property {typeof deliverWebhook} deliverWebhook Deliver one signed event to an allowlisted HTTPS endpoint.
 * @property {typeof signWebhook} signWebhook Sign an exact request body using Standard Webhooks headers.
 * @property {typeof validateNotificationEvent} validateNotificationEvent Validate a strict bounded event envelope.
 * @property {typeof verifyWebhookSignature} verifyWebhookSignature Verify signed webhook headers and timestamp freshness.
 * @property {typeof audit} audit Classify inventory evidence using reviewed configuration.
 * @property {typeof suggestAuth} suggestAuth Rank possible authentication middleware names.
 * @property {typeof buildReport} buildReport Create the versioned portable report contract.
 * @property {typeof reconcile} reconcile Combine static and runtime route evidence.
 * @property {typeof evaluatePolicies} evaluatePolicies Evaluate deterministic route policies.
 * @property {typeof normalizePolicies} normalizePolicies Validate and normalize policy data.
 * @property {typeof compareReports} compareReports Compare two route reports.
 * @property {typeof compareOrganizationReports} compareOrganizationReports Compare two organization inventories.
 * @property {typeof compareOpenApiDocuments} compareOpenApiDocuments Compare two OpenAPI contracts semantically.
 * @property {typeof instrument} instrument Observe Express runtime registrations.
 * @property {typeof executeRuntime} executeRuntime Boot trusted target code in a bounded child process.
 * @property {typeof loadConfig} loadConfig Load and validate configuration from disk.
 * @property {typeof validateConfig} validateConfig Validate an in-memory configuration object.
 * @property {typeof REPORT_SCHEMA} REPORT_SCHEMA JSON Schema for route reports.
 * @property {object} formatters JSON, Markdown, terminal, and OpenAPI formatters.
 */

/** @type {ExpressReconAPI} */
module.exports = {
  inventory,
  discover,
  reconcileDocumentation,
  refreshDocumentation,
  validateOpenApiDocument,
  createMiddlewareReview,
  applyMiddlewareAssessments,
  validateAssessment,
  MIDDLEWARE_ASSESSMENT_SCHEMA,
  acquireRepository,
  scanRepository,
  listOrganizationRepositories,
  scanOrganization,
  renderHtmlSite,
  buildNotificationEvents,
  deliverWebhook,
  signWebhook,
  validateNotificationEvent,
  verifyWebhookSignature,
  audit,
  suggestAuth,
  buildReport,
  reconcile,
  evaluatePolicies,
  normalizePolicies,
  compareReports,
  compareOrganizationReports,
  compareOpenApiDocuments,
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
