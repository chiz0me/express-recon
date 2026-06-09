"use strict";

const { inventory, audit } = require("./harness");
const { buildReport } = require("./report");
const { suggestAuth } = require("./suggest");
const { REPORT_SCHEMA } = require("./schema");
const { instrument } = require("./runtime/instrument");
const { reconcile } = require("./reconcile");

/**
 * express-recon — an inventory + audit harness for Express 4/5 route surfaces,
 * usable from the CLI, a library, or an AI agent.
 *
 * Primitives:
 *   - `inventory(opts)`            raw routes + middleware + source, no judgment
 *   - `audit(opts, config)`        classify the inventory against an auth allowlist
 *   - `suggestAuth(registry)`      propose allowlist candidates from an inventory
 *   - `buildReport(registry, meta)`  versioned machine-readable contract
 *   - `instrument(express)`        capture mount paths before app boot (runtime)
 *
 * `opts` is `{ mode: "static"|"runtime"|"hybrid", src?, app? }`.
 */
module.exports = {
  inventory,
  audit,
  suggestAuth,
  buildReport,
  reconcile,
  instrument,
  REPORT_SCHEMA,
  formatters: {
    json: require("./formatters/json"),
    markdown: require("./formatters/markdown"),
    pretty: require("./formatters/pretty"),
  },
};
