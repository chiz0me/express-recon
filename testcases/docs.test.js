"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const { inventory, buildReport, reconcileDocumentation } = require("../src/index");

const FIXTURE = path.join(__dirname, "fixtures", "discovery-app");
const CLI = path.join(__dirname, "..", "src", "cli.js");
const PUBLIC_APP = "app:src/public-app.js#app";
const SECURITY_FIXTURE = path.join(__dirname, "fixtures", "repository-app");

function inventoryReport() {
  return buildReport(inventory({ mode: "static", src: FIXTURE }), {
    command: "inventory",
    mode: "static",
    sourceRoot: FIXTURE,
    target: { name: "discovery-root", version: "1.0.0" },
  });
}

function reconciled(overrides = {}) {
  return reconcileDocumentation(inventoryReport(), {
    root: FIXTURE,
    applicationId: PUBLIC_APP,
    ...overrides,
  });
}

test("reconciles base OpenAPI, JSDoc, and code with deterministic precedence", () => {
  const { document, report } = reconciled();
  const health = document.paths["/health"].get;
  assert.equal(health.summary, "Authored health");
  assert.equal(health.description, "Filled from swagger-jsdoc");
  assert.deepEqual(health.tags, ["operations"]);
  assert.ok(health["x-express-recon"]);
  assert.ok(document.paths["/code-only"].get);
  assert.ok(document.paths["/documented-only"].get);
  assert.equal(document.servers[0].url, "https://api.example.test");
  assert.equal(document.components.schemas.Health.type, "object");

  assert.deepEqual(report.codeOnlyOperations, ["GET /code-only"]);
  assert.deepEqual(report.docsOnlyOperations, ["GET /documented-only"]);
  assert.deepEqual(report.documentedOperations, ["GET /health"]);
  assert.ok(report.conflicts.some((item) => item.pointer === "/paths/~1health/get/summary"));
  assert.equal(report.sources.base, "docs/openapi.yaml");
  assert.deepEqual(report.sources.jsdoc, ["src/documented.js"]);
  assert.equal(report.summary.incompleteDocumentationDiscovery, false);
});

test("requires an application selection when more than one app exists", () => {
  assert.throws(
    () => reconcileDocumentation(inventoryReport(), { root: FIXTURE }),
    /Multiple Express applications were found/,
  );
});

test("an intentional all-app merge surfaces duplicate operations", () => {
  const { report } = reconcileDocumentation(inventoryReport(), {
    root: FIXTURE,
    applicationId: "all",
  });
  assert.ok(report.duplicateOperations.some((item) => item.path === "/health"));
});

test("reconciliation is idempotent", () => {
  const first = reconciled();
  const temp = fs.mkdtempSync(path.join(FIXTURE, ".docs-idempotence-"));
  try {
    const spec = path.join(temp, "merged.json");
    fs.writeFileSync(spec, JSON.stringify(first.document));
    const second = reconciled({ spec: path.relative(FIXTURE, spec) });
    assert.deepEqual(second.document, first.document);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("reconciliation stays idempotent when authored extension metadata uses generated false", () => {
  const dir = fs.mkdtempSync(path.join(FIXTURE, ".docs-extension-idempotence-"));
  try {
    const base = path.join(dir, "base.json");
    fs.writeFileSync(
      base,
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Extension fixture", version: "1.0.0" },
        paths: {},
        "x-express-recon": { generated: false, custom: "retained" },
      }),
    );
    const first = reconciled({ spec: path.relative(FIXTURE, base), jsdoc: [] });
    const merged = path.join(dir, "merged.json");
    fs.writeFileSync(merged, JSON.stringify(first.document));
    const second = reconciled({ spec: path.relative(FIXTURE, merged), jsdoc: [] });
    assert.deepEqual(second.document, first.document);
    assert.equal(second.document["x-express-recon"].generated, false);
    assert.equal(second.document["x-express-recon"].custom, "retained");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects specs outside the scan root and Swagger 2 inputs", () => {
  assert.throws(() => reconciled({ spec: "../outside.yaml" }), /must stay inside/);
  const dir = fs.mkdtempSync(path.join(FIXTURE, "swagger-"));
  try {
    fs.writeFileSync(
      path.join(dir, "swagger.json"),
      JSON.stringify({ swagger: "2.0", info: { title: "old", version: "1" }, paths: {} }),
    );
    assert.throws(
      () => reconciled({ spec: path.relative(FIXTURE, path.join(dir, "swagger.json")) }),
      /convert it to OpenAPI 3/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("documentation inputs stay bounded and cannot escape through symlinks", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-docs-outside-"));
  const inside = fs.mkdtempSync(path.join(FIXTURE, ".docs-inputs-"));
  try {
    const outsideSpec = path.join(outside, "openapi.json");
    fs.writeFileSync(outsideSpec, JSON.stringify({ openapi: "3.1.0", paths: {} }));
    const link = path.join(inside, "linked.json");
    fs.symlinkSync(outsideSpec, link);
    assert.throws(
      () => reconciled({ spec: path.relative(FIXTURE, link) }),
      /symbolic-link target leaves the scan root/,
    );

    const oversized = path.join(inside, "oversized.json");
    fs.writeFileSync(
      oversized,
      JSON.stringify({ openapi: "3.1.0", paths: {}, padding: "x".repeat(2048) }),
    );
    assert.throws(
      () =>
        reconciled({
          spec: path.relative(FIXTURE, oversized),
          scan: { maxFileBytes: 1024 },
        }),
      /exceeding scan.maxFileBytes/,
    );
  } finally {
    fs.rmSync(inside, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("JSDoc prototype-like keys are merged as data without prototype mutation", () => {
  const dir = fs.mkdtempSync(path.join(FIXTURE, ".docs-prototype-"));
  try {
    const jsdoc = path.join(dir, "prototype.js");
    fs.writeFileSync(
      jsdoc,
      [
        "/**",
        " * @openapi",
        " * __proto__:",
        " *   description: ordinary path-like data",
        " * /prototype-probe:",
        " *   get:",
        " *     responses:",
        " *       default:",
        " *         description: probe",
        " */",
      ].join("\n"),
    );
    const { document } = reconciled({
      jsdoc: [path.relative(FIXTURE, jsdoc)],
    });
    assert.equal(Object.hasOwn(document.paths, "__proto__"), true);
    assert.deepEqual(document.paths.__proto__, {
      description: "ordinary path-like data",
    });
    assert.equal(Object.getPrototypeOf(document.paths), Object.prototype);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("documentation rejects cyclic YAML aliases", () => {
  const dir = fs.mkdtempSync(path.join(FIXTURE, ".docs-cyclic-"));
  try {
    const spec = path.join(dir, "cyclic.yaml");
    fs.writeFileSync(
      spec,
      ["openapi: 3.1.0", "paths: &paths", "  /cycle:", "    get:", "      x-loop: *paths"].join(
        "\n",
      ),
    );
    assert.throws(() => reconciled({ spec: path.relative(FIXTURE, spec) }), /cyclic YAML alias/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("generated-field cleanup requires express-recon provenance", () => {
  const dir = fs.mkdtempSync(path.join(FIXTURE, ".docs-provenance-"));
  try {
    const spec = path.join(dir, "authored.json");
    fs.writeFileSync(
      spec,
      JSON.stringify({
        openapi: "3.1.0",
        paths: { "/marker-only": { get: { summary: "authored and retained" } } },
        "x-express-recon": {
          reconciliation: {
            generatedFields: ["/paths/~1marker-only/get/summary"],
          },
        },
      }),
    );
    const { document } = reconciled({ spec: path.relative(FIXTURE, spec) });
    assert.equal(document.paths["/marker-only"].get.summary, "authored and retained");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("docs CLI writes the merged document and drift report", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-docs-cli-"));
  try {
    execFileSync("node", [CLI, "docs", "--src", FIXTURE, "--app-id", PUBLIC_APP, "--out", out], {
      encoding: "utf8",
    });
    const document = JSON.parse(fs.readFileSync(path.join(out, "openapi.json"), "utf8"));
    const report = JSON.parse(fs.readFileSync(path.join(out, "docs-report.json"), "utf8"));
    assert.equal(document.paths["/health"].get.summary, "Authored health");
    assert.equal(report.applicationId, PUBLIC_APP);
    assert.equal(report.summary.codeOnlyOperations, 1);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("docs CLI can gate drift and conflicts independently", () => {
  for (const status of ["docs-drift", "docs-conflict"]) {
    const result = spawnSync(
      "node",
      [CLI, "docs", "--src", FIXTURE, "--app-id", PUBLIC_APP, "--fail-on", status],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
  }
});

test("docs-incomplete gates incomplete documentation discovery, not only route scanning", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-docs-limits-"));
  try {
    const config = path.join(dir, "config.json");
    fs.writeFileSync(config, JSON.stringify({ scan: { maxFiles: 3 } }));
    const result = spawnSync(
      "node",
      [
        CLI,
        "docs",
        "--src",
        FIXTURE,
        "--app-id",
        PUBLIC_APP,
        "--config",
        config,
        "--fail-on",
        "docs-incomplete",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("docs adds security only from an explicit tag-to-scheme mapping", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-docs-security-"));
  try {
    const config = path.join(dir, "config.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        authMiddleware: { requireAuth: "authenticated" },
        openapi: {
          securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
          securityByTag: { authenticated: ["bearerAuth"] },
        },
      }),
    );
    const document = JSON.parse(
      execFileSync("node", [CLI, "docs", "--src", SECURITY_FIXTURE, "--config", config], {
        encoding: "utf8",
      }),
    );
    assert.deepEqual(document.paths["/code-only"].get.security, [{ bearerAuth: [] }]);
    assert.equal(document.paths["/health"].get.summary, "Authored repository health");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
