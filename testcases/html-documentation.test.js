"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { documentationCoverage } = require("../src/html-documentation");

const route = (path, overrides = {}) => ({
  method: "GET",
  path,
  pathConfidence: "full",
  applicationId: "app",
  ...overrides,
});
const scan = (routes, documentation = {}) => ({ inventory: { routes }, documentation });
const document = (paths, overrides = {}) => ({
  openapi: "3.1.0",
  paths: Object.fromEntries(paths.map((path) => [path, { get: {} }])),
  ...overrides,
});

test("documentation overlap deduplicates specs and matches method and normalized path parameters", () => {
  const source = document(["/users/{id}"]);
  const result = documentationCoverage(
    scan([route("/users/:userId"), route("/users/:id", { method: "POST" }), route("/health")]),
    [
      { document: source, source: "openapi.yaml" },
      { document: source, source: "swagger.json" },
    ],
  );
  assert.equal(result.total, 3);
  assert.equal(result.checked, 3);
  assert.equal(result.matched, 1);
  assert.deepEqual(result.rows[0].sources, ["openapi.yaml", "swagger.json"]);
  assert.deepEqual(
    result.rows.map((item) => item.status),
    ["matched", "unmatched", "unmatched"],
  );
});

test("absent evidence, uncertain paths, and unsupported methods remain unchecked", () => {
  assert.deepEqual(documentationCoverage(), { total: 0, matched: 0, checked: 0, rows: [] });
  assert.equal(documentationCoverage(scan([route("/health")])).checked, 0);
  const result = documentationCoverage(
    scan([
      route(null),
      route("/dynamic", { pathConfidence: "partial" }),
      route("/unknown", { pathConfidence: "unknown" }),
      route("/socket", { method: "CONNECT" }),
    ]),
    [{ document: document(["/dynamic", "/unknown", "/socket"]) }],
  );
  assert.equal(result.checked, 0);
  assert.equal(result.matched, 0);
});

test("reconciliation uses authored operations and retains JSDoc attribution", () => {
  const report = {
    applicationId: "app",
    sources: { base: "docs/api.yaml", jsdoc: ["src/routes.js"] },
    documentedOperations: ["GET /users/{id}"],
    codeOnlyOperations: ["GET /health"],
  };
  const result = documentationCoverage(
    scan([route("/users/:id"), route("/health"), route("/other")], { report }),
  );
  assert.equal(result.matched, 1);
  assert.equal(result.checked, 2);
  assert.deepEqual(result.rows[0].sources, ["docs/api.yaml, src/routes.js"]);
  const catalog = documentationCoverage(
    scan([route("/users/:id")], {
      specifications: [
        { status: "available", reconciliation: { report } },
        { status: "invalid", reconciliation: { report } },
      ],
    }),
  );
  assert.equal(catalog.matched, 1);
});

test("documents cannot silently cross application boundaries", () => {
  const input = scan([route("/health"), route("/health", { applicationId: "other" })]);
  const source = { document: document(["/health"]) };
  assert.equal(documentationCoverage(input, [source]).checked, 0);
  const scoped = documentationCoverage(input, [{ ...source, applicationId: "app" }]);
  assert.equal(scoped.matched, 1);
  assert.equal(scoped.checked, 1);
  const reconciled = documentationCoverage({
    ...input,
    documentation: {
      report: {
        applicationId: "other",
        documentedOperations: ["GET /health"],
      },
    },
  });
  assert.deepEqual(
    reconciled.rows.map((row) => row.status),
    ["unchecked", "matched"],
  );
});

test("generated API operations never inflate documentation overlap", () => {
  const input = scan([
    route("/authored"),
    route("/generated"),
    route("/whole-path"),
    route("/a~b"),
  ]);
  const source = document(["/authored", "/generated", "/whole-path", "/a~b"], {
    "x-express-recon": {
      reconciliation: {
        applicationId: "app",
        generatedFields: [
          "/paths/~1generated/get",
          "/paths/~1whole-path",
          "/paths/~1a~0b/get",
          "/paths/~1authored/get/responses",
        ],
      },
    },
  });
  const before = structuredClone(source);
  const result = documentationCoverage(input, [{ document: source, reconciled: true }]);
  assert.equal(result.matched, 1);
  assert.equal(result.checked, 4);
  assert.deepEqual(source, before);
  for (const metadata of [{ generated: true }, { reconciliation: {} }]) {
    assert.equal(
      documentationCoverage(input, [
        { document: document(["/authored"], { "x-express-recon": metadata }) },
      ]).checked,
      0,
    );
  }
  assert.equal(
    documentationCoverage(input, [{ document: document(["/authored"]), reconciled: true }]).checked,
    0,
  );
  const allGenerated = document(["/authored"], {
    "x-express-recon": { reconciliation: { generatedFields: ["/paths"] } },
  });
  assert.equal(documentationCoverage(input, [{ document: allGenerated }]).matched, 0);
});

test("Swagger base paths, optional variants and ALL registrations count a route once", () => {
  const swagger = { swagger: "2.0", basePath: "/api/", paths: { "/users/{id}": { get: {} } } };
  const result = documentationCoverage(
    scan([
      route("/api/users/:userId"),
      route("/users/:id?"),
      route("/users/:id", { method: "ALL" }),
    ]),
    [{ document: swagger }],
  );
  assert.equal(result.matched, 3);
  assert.equal(result.checked, 3);
  const imported = {
    inventory: { mode: "imported", routes: [route("/users/{userId}", { framework: "spring" })] },
  };
  assert.equal(documentationCoverage(imported, [{ document: swagger }]).matched, 1);
});
