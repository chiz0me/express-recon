"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createServer } = require("../src/mcp/server");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

const FIXTURE = path.join(__dirname, "fixtures", "static-app");
const ACCURACY_FIXTURE = path.join(__dirname, "fixtures", "accuracy-app");
const SCOPE_FIXTURE = path.join(__dirname, "fixtures", "scope-app");
const DISCOVERY_FIXTURE = path.join(__dirname, "fixtures", "discovery-app");

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

function parse(result) {
  assert.ok(!result.isError, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

test("exposes the harness tools", async () => {
  const client = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "audit_routes",
    "discover_repository",
    "finding_by_fingerprint",
    "import_middleware_review",
    "inventory_routes",
    "openapi_spec",
    "query_audit",
    "query_refresh",
    "reconcile_openapi",
    "refresh_openapi",
    "report_schema",
    "review_middleware",
    "suggest_auth",
    "validate_policies",
  ]);
  await client.close();
});

test("refresh_openapi and query_refresh keep AI responses bounded", async () => {
  const client = await connect();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-mcp-refresh-"));
  const output = path.join(parent, "state");
  try {
    const refreshed = parse(
      await client.callTool({
        name: "refresh_openapi",
        arguments: {
          dir: DISCOVERY_FIXTURE,
          output,
          applicationId: "app:src/public-app.js#app",
          render: false,
        },
      }),
    );
    assert.equal(refreshed.kind, "openapi-refresh-result");
    assert.equal(refreshed.html, undefined);

    const summary = parse(
      await client.callTool({
        name: "query_refresh",
        arguments: { dir: DISCOVERY_FIXTURE, output, kind: "summary" },
      }),
    );
    assert.equal(summary.kind, "refresh-summary");
    assert.equal(summary.enrichment.unreviewedOperations, 3);

    const operations = parse(
      await client.callTool({
        name: "query_refresh",
        arguments: {
          dir: DISCOVERY_FIXTURE,
          output,
          kind: "unreviewed_operations",
          limit: 1,
        },
      }),
    );
    assert.equal(operations.items.length, 1);
    assert.ok(operations.items[0].currentOperation["x-express-recon"]);
    assert.ok(operations.nextCursor);
  } finally {
    await client.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("query_refresh bounds a single unusually large authored operation", async () => {
  const client = await connect();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-mcp-bounded-refresh-"));
  const repository = path.join(parent, "repo");
  const output = path.join(parent, "state");
  const largeExtensions = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [`x-large-${index}`, "x".repeat(1_000)]),
  );
  fs.mkdirSync(repository);
  fs.writeFileSync(
    path.join(repository, "package.json"),
    JSON.stringify({ name: "bounded-refresh", dependencies: { express: "^5" } }),
  );
  fs.writeFileSync(
    path.join(repository, "app.js"),
    [
      'const express = require("express");',
      "const app = express();",
      'app.get("/large", (_req, res) => res.json({ ok: true }));',
      "module.exports = app;",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(repository, "openapi.json"),
    JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Large operation", version: "1" },
      paths: {
        "/large": {
          get: {
            operationId: "getLarge",
            summary: "Large operation",
            description: "x".repeat(100_000),
            responses: { 200: { description: "ok" } },
            ...largeExtensions,
          },
        },
      },
    }),
  );
  try {
    const refreshed = await client.callTool({
      name: "refresh_openapi",
      arguments: { dir: repository, output, render: false },
    });
    assert.equal(refreshed.isError, undefined, refreshed.content[0].text);
    const response = await client.callTool({
      name: "query_refresh",
      arguments: { dir: repository, output, kind: "unreviewed_operations" },
    });
    assert.equal(response.isError, undefined, response.content[0].text);
    assert.ok(response.content[0].text.length < 32_000);
    const result = parse(response);
    assert.equal(result.responseTruncated, true);
    assert.equal(result.items[0].queryTruncated, true);
    assert.equal(result.items[0].currentOperation.summary, "Large operation");
    assert.equal(result.items[0].currentOperation.description, undefined);
    assert.ok(result.items[0].currentOperationBytes > 100_000);

    fs.appendFileSync(
      path.join(repository, "app.js"),
      '\napp.post("/added", (_req, res) => res.status(201).json({ created: true }));\n',
    );
    const updated = await client.callTool({
      name: "refresh_openapi",
      arguments: { dir: repository, output, render: false },
    });
    assert.equal(updated.isError, undefined, updated.content[0].text);
    const changes = parse(
      await client.callTool({
        name: "query_refresh",
        arguments: { dir: repository, output, kind: "contract_changes" },
      }),
    );
    assert.ok(
      changes.items.some(
        (item) =>
          item.kind === "operation" &&
          item.change === "added" &&
          item.operation === "POST /added" &&
          item.severity === "informational",
      ),
    );
  } finally {
    await client.close();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("openapi_spec returns an OpenAPI 3.1 document", async () => {
  const client = await connect();
  const doc = parse(
    await client.callTool({
      name: "openapi_spec",
      arguments: {
        dir: FIXTURE,
        authMiddleware: { requireAuth: "authenticated" },
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
        securityByTag: { authenticated: ["bearerAuth"] },
      },
    }),
  );
  assert.equal(doc.openapi, "3.1.0");
  assert.ok(doc.paths["/health"]);
  assert.equal(doc["x-express-recon"].command, "audit");
  assert.equal(doc.components.securitySchemes.bearerAuth.scheme, "bearer");
  await client.close();
});

test("discover_repository separates apps and API documentation", async () => {
  const client = await connect();
  const result = parse(
    await client.callTool({
      name: "discover_repository",
      arguments: { dir: DISCOVERY_FIXTURE },
    }),
  );
  assert.equal(result.applications.length, 2);
  assert.equal(result.documentation.specifications[0].path, "docs/openapi.yaml");
  await client.close();
});

test("reconcile_openapi returns merged docs and drift evidence", async () => {
  const client = await connect();
  const result = parse(
    await client.callTool({
      name: "reconcile_openapi",
      arguments: {
        dir: DISCOVERY_FIXTURE,
        applicationId: "app:src/public-app.js#app",
      },
    }),
  );
  assert.equal(result.document.paths["/health"].get.summary, "Authored health");
  assert.deepEqual(result.report.codeOnlyOperations, ["GET /code-only"]);
  await client.close();
});

test("review_middleware returns an advisory evidence contract", async () => {
  const client = await connect();
  const result = parse(
    await client.callTool({ name: "review_middleware", arguments: { dir: FIXTURE } }),
  );
  assert.equal(result.kind, "middleware-review-bundle");
  assert.ok(result.candidates.some((candidate) => candidate.name === "requireAuth"));
  assert.equal(result.assessmentSchema.additionalProperties, false);
  await client.close();
});

test("import_middleware_review validates the provider-neutral assessment round trip", async () => {
  const client = await connect();
  const review = parse(
    await client.callTool({ name: "review_middleware", arguments: { dir: FIXTURE } }),
  );
  const candidate = review.candidates.find((item) => item.name === "requireAuth");
  const result = parse(
    await client.callTool({
      name: "import_middleware_review",
      arguments: {
        review,
        assessment: {
          schemaVersion: "1.0",
          bundleFingerprint: review.bundleFingerprint,
          assessments: [
            {
              candidateId: candidate.id,
              candidateFingerprint: candidate.fingerprint,
              classification: "authentication",
              enforcement: "always",
              confidence: "high",
              rationale: "The middleware rejects unauthenticated requests before next().",
            },
          ],
        },
      },
    }),
  );
  assert.equal(result.advisory, true);
  assert.deepEqual(result.reviewedConfigSuggestions.authMiddleware.requireAuth, {
    tags: ["authenticated"],
  });
  await client.close();
});

test("audit_routes returns the audit report contract", async () => {
  const client = await connect();
  const report = parse(
    await client.callTool({
      name: "audit_routes",
      arguments: { dir: FIXTURE, authMiddleware: { requireAuth: "authenticated" } },
    }),
  );
  assert.equal(report.command, "audit");
  assert.equal(report.tool, "express-recon");
  assert.ok(report.findings.some((f) => f.id === "public-route"));
  await client.close();
});

test("MCP audit baselines and queries preserve application identity", async () => {
  const client = await connect();
  const acceptedPublic = [
    {
      applicationId: "app:src/public-app.js#app",
      method: "GET",
      path: "/health",
    },
  ];
  const report = parse(
    await client.callTool({
      name: "audit_routes",
      arguments: { dir: DISCOVERY_FIXTURE, acceptedPublic },
    }),
  );
  const finding = report.findings.find(
    (item) => item.id === "public-route" && item.path === "/health",
  );
  assert.equal(finding.applicationId, "app:services/admin/app.js#admin");

  const lookup = parse(
    await client.callTool({
      name: "finding_by_fingerprint",
      arguments: {
        dir: DISCOVERY_FIXTURE,
        acceptedPublic,
        fingerprint: finding.fingerprint,
      },
    }),
  );
  assert.equal(lookup.route.applicationId, finding.applicationId);

  const query = parse(
    await client.callTool({
      name: "query_audit",
      arguments: {
        dir: DISCOVERY_FIXTURE,
        kind: "routes",
        applicationIds: ["app:src/public-app.js#app"],
      },
    }),
  );
  assert.ok(query.items.length > 0);
  assert.ok(query.items.every((item) => item.applicationId === "app:src/public-app.js#app"));
  await client.close();
});

test("audit_routes only trusts inner auth names through configured wrappers", async () => {
  const client = await connect();
  const baseArguments = {
    dir: ACCURACY_FIXTURE,
    authMiddleware: { requireAuth: "authenticated" },
  };
  const withoutWrapper = parse(
    await client.callTool({ name: "audit_routes", arguments: baseArguments }),
  );
  const configured = parse(
    await client.callTool({
      name: "audit_routes",
      arguments: { ...baseArguments, authWrappers: ["asyncHandler"] },
    }),
  );
  const route = (report) => report.routes.find((item) => item.path === "/wrapped");
  assert.equal(route(withoutWrapper).authStatus, "unknown");
  assert.equal(route(configured).authStatus, "proven");
  await client.close();
});

test("audit_routes evaluates configurable route policies", async () => {
  const client = await connect();
  const report = parse(
    await client.callTool({
      name: "audit_routes",
      arguments: {
        dir: FIXTURE,
        policies: [
          {
            id: "health-rate-limit",
            match: { methods: ["GET"], paths: ["/health"] },
            require: { anyMiddleware: ["rateLimit"] },
          },
        ],
      },
    }),
  );
  assert.ok(report.findings.some((finding) => finding.ruleId === "health-rate-limit"));
  await client.close();
});

test("inventory_routes omits findings", async () => {
  const client = await connect();
  const report = parse(
    await client.callTool({ name: "inventory_routes", arguments: { dir: FIXTURE } }),
  );
  assert.equal(report.command, "inventory");
  assert.equal(report.findings, undefined);
  await client.close();
});

test("inventory_routes applies scan include and exclude globs", async () => {
  const client = await connect();
  const report = parse(
    await client.callTool({
      name: "inventory_routes",
      arguments: {
        dir: SCOPE_FIXTURE,
        ignoreFile: false,
        include: ["src/**"],
        exclude: ["src/skip/**"],
      },
    }),
  );
  assert.deepEqual(
    report.routes.map((route) => route.path),
    ["/main"],
  );
  await client.close();
});

test("suggest_auth proposes candidates", async () => {
  const client = await connect();
  const result = parse(
    await client.callTool({ name: "suggest_auth", arguments: { dir: FIXTURE } }),
  );
  assert.ok(result.candidates.some((c) => c.name === "requireAuth"));
  await client.close();
});

test("query_audit returns compact summaries and cursor-paginated findings", async () => {
  const client = await connect();
  const summary = parse(
    await client.callTool({
      name: "query_audit",
      arguments: { dir: FIXTURE, kind: "summary" },
    }),
  );
  assert.equal(summary.kind, "summary");
  assert.ok(summary.summary.routes > 0);
  assert.equal(summary.scanCoverage.complete, true);
  assert.equal(summary.routes, undefined);

  const first = parse(
    await client.callTool({
      name: "query_audit",
      arguments: { dir: FIXTURE, kind: "findings", limit: 2 },
    }),
  );
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  const second = parse(
    await client.callTool({
      name: "query_audit",
      arguments: {
        dir: FIXTURE,
        kind: "findings",
        limit: 2,
        cursor: first.nextCursor,
      },
    }),
  );
  assert.ok(second.items.length > 0);
  assert.notEqual(second.items[0].fingerprint, first.items[0].fingerprint);
  await client.close();
});

test("finding_by_fingerprint returns the finding and associated route", async () => {
  const client = await connect();
  const report = parse(
    await client.callTool({ name: "audit_routes", arguments: { dir: FIXTURE } }),
  );
  const expected = report.findings.find((finding) => finding.method);
  const result = parse(
    await client.callTool({
      name: "finding_by_fingerprint",
      arguments: { dir: FIXTURE, fingerprint: expected.fingerprint },
    }),
  );
  assert.equal(result.finding.fingerprint, expected.fingerprint);
  assert.equal(result.route.path, expected.path);
  await client.close();
});

test("validate_policies normalizes expressions and reports expired exceptions", async () => {
  const client = await connect();
  const result = parse(
    await client.callTool({
      name: "validate_policies",
      arguments: {
        now: "2031-01-01",
        policies: [
          {
            id: "admin",
            require: { all: [{ auth: true }, { roles: ["admin"] }] },
            exceptions: [
              {
                id: "old",
                reason: "migration",
                expires: "2030-01-01",
                match: { paths: ["/admin/**"] },
              },
            ],
          },
        ],
      },
    }),
  );
  assert.equal(result.valid, true);
  assert.equal(result.expiredExceptions[0].exceptionId, "old");
  await client.close();
});

test("validate_policies reports a consistent error for an invalid evaluation date", async () => {
  const client = await connect();
  const result = await client.callTool({
    name: "validate_policies",
    arguments: { now: "0", policies: [] },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /policy evaluation now must be a valid date/);
  await client.close();
});

test("a missing directory returns a well-formed incomplete scan", async () => {
  const client = await connect();
  const result = await client.callTool({
    name: "audit_routes",
    arguments: { dir: path.join(FIXTURE, "does-not-exist") },
  });
  assert.ok(!result.isError);
  const report = JSON.parse(result.content[0].text);
  assert.equal(report.routes.length, 0);
  assert.equal(report.scanCoverage.complete, false);
  assert.ok(report.diagnostics.some((message) => message.includes("could not read directory")));
  await client.close();
});
