"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { formatters } = require("../src");

const SOURCE = { file: path.join(process.cwd(), "src", "routes.js"), line: 42 };
const MIDDLEWARE = { name: "requireAuth", kind: "identifier", raw: "requireAuth" };

function report() {
  const finding = {
    id: "public-route",
    ruleId: "public-route",
    fingerprint: "finding_1234567890abcdef",
    severity: "high",
    confidence: "high",
    method: "GET",
    path: "/accounts",
    source: SOURCE,
    detail: "No recognised auth middleware guards this route.",
    recommendation: "Add authentication.",
  };
  return {
    schemaVersion: "1.3",
    tool: "express-recon",
    command: "audit",
    mode: "static",
    routes: [
      {
        method: "GET",
        path: "/accounts",
        middlewares: [MIDDLEWARE],
        source: SOURCE,
        pathConfidence: "full",
        authStatus: "public",
        tags: ["public"],
        roles: [],
        scopes: [],
        authEvidence: { matched: [] },
      },
    ],
    globalMiddleware: [],
    summary: {
      routes: 1,
      public: 1,
      unknown: 0,
      proven: 0,
      accepted: 0,
      policyViolations: 0,
      policyExceptions: 0,
    },
    findings: [finding],
    delta: {
      baseline: { schemaVersion: "1.3", target: null },
      summary: {
        addedRoutes: 1,
        removedRoutes: 0,
        authRegressions: 1,
        authImprovements: 0,
        newFindings: 1,
        resolvedFindings: 0,
      },
      addedRoutes: [],
      removedRoutes: [],
      authRegressions: [
        {
          method: "GET",
          path: "/accounts",
          from: "proven",
          to: "public",
          source: SOURCE,
          explanation: "Recognized auth tag removed.",
          changes: { removedTags: ["authenticated"] },
        },
      ],
      authImprovements: [],
      newFindings: [finding],
      resolvedFindings: [],
    },
  };
}

test("markdown exposes severity, fingerprint, locations, and baseline deltas", () => {
  const output = formatters.markdown.format(report());
  assert.match(output, /\*\*high\*\*/);
  assert.match(output, /finding_1234567890abcdef/);
  assert.match(output, /src\/routes\.js:42/);
  assert.match(output, /Authentication regressions/);
  assert.match(output, /proven → \*\*public\*\*/);
  assert.match(output, /Net-new findings/);
});

test("pretty output summarizes auth and delta state without mutating routes", () => {
  const input = report();
  const before = structuredClone(input.routes);
  const output = formatters.pretty.format(input);
  assert.match(output, /audit · static · 1 routes/);
  assert.match(output, /public: 1/);
  assert.match(output, /regressions: 1/);
  assert.match(output, /GET/);
  assert.match(output, /\/accounts/);
  assert.deepEqual(input.routes, before);
});
