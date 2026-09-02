"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { readRefreshDefaults, refreshDocumentation } = require("../src/refresh");

const CLI = path.join(__dirname, "..", "src", "cli.js");
const MULTI_APP_FIXTURE = path.join(__dirname, "fixtures", "discovery-app");

function source(route = true, extra = "") {
  return [
    'const express = require("express");',
    'const { loadThing } = require("./service");',
    "const app = express();",
    "function getThing(req, res) {",
    "  const id = req.params.id;",
    "  res.status(200).json(loadThing(id));",
    "}",
    ...(route ? ['app.get("/things/:id", getThing);'] : []),
    extra,
    "module.exports = app;",
  ]
    .filter(Boolean)
    .join("\n");
}

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-refresh-test-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "refresh-fixture", version: "1.0.0", dependencies: { express: "^5" } }),
  );
  fs.writeFileSync(path.join(root, "app.js"), source());
  fs.writeFileSync(path.join(root, "service.js"), "exports.loadThing = (id) => ({ id });\n");
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runRefresh(root, args = [], expectedStatus = 0) {
  const result = spawnSync(process.execPath, [CLI, "refresh", "--src", root, ...args], {
    encoding: "utf8",
  });
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return result;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test("refresh uses durable defaults, computes deltas, and renders automatically", () => {
  fixture((root) => {
    const result = JSON.parse(runRefresh(root).stdout);
    const output = path.join(fs.realpathSync(root), ".express-recon", "api");
    assert.equal(result.output, output);
    assert.equal(result.html, path.join(output, "api-reference", "index.html"));
    assert.ok(fs.existsSync(result.html));
    assert.ok(fs.existsSync(path.join(output, "openapi.generated.json")));
    assert.ok(fs.existsSync(path.join(output, "openapi.enrichment.json")));
    assert.ok(fs.existsSync(path.join(output, "openapi.baseline.json")));
    assert.ok(fs.existsSync(path.join(output, "openapi-delta.json")));

    const generated = readJson(path.join(output, "openapi.generated.json"));
    assert.match(
      generated.paths["/things/{id}"].get["x-express-recon"].enrichmentFingerprint,
      /^sha256:[a-f0-9]{64}$/,
    );
    const manifest = readJson(path.join(output, "refresh-manifest.json"));
    assert.equal(manifest.kind, "express-recon-openapi-refresh");
    assert.equal(manifest.selection.applicationId, "app:app.js#app");
    assert.ok(manifest.ownedFiles.includes("api-reference/index.html"));
    assert.ok(manifest.ownedFiles.includes("refresh-manifest.json"));

    const second = JSON.parse(runRefresh(root).stdout);
    assert.deepEqual(second.routeChanges, {
      addedRoutes: 0,
      removedRoutes: 0,
      changedRoutes: 0,
      authRegressions: 0,
      authImprovements: 0,
      newFindings: 0,
      resolvedFindings: 0,
    });
    const unreviewedGate = runRefresh(root, ["--fail-on", "enrichment-unreviewed"], 2);
    assert.match(unreviewedGate.stderr, /matched --fail-on enrichment-unreviewed/);

    fs.writeFileSync(
      path.join(root, "app.js"),
      source(true, 'app.post("/things", (_req, res) => res.status(201).json({ ok: true }));'),
    );
    const third = JSON.parse(runRefresh(root, ["--fail-on", "routes-added"], 2).stdout);
    assert.equal(third.routeChanges.addedRoutes, 1);
    assert.equal(third.openapiBaselineAvailable, true);
    assert.equal(third.openapiChanges.addedOperations, 1);
    const report = readJson(path.join(output, "refresh-report.json"));
    assert.ok(report.enrichment.unreviewedOperations.includes("POST /things"));
    assert.ok(readJson(path.join(output, "openapi.json")).paths["/things"].post);
    const notification = spawnSync(
      process.execPath,
      [
        CLI,
        "notify",
        "--input",
        path.join(output, "routes.json"),
        "--events",
        "routes.added",
        "--dry-run",
      ],
      { encoding: "utf8" },
    );
    assert.equal(notification.status, 0, notification.stderr);
    const preview = JSON.parse(notification.stdout);
    assert.equal(preview.eventsEmitted, 1);
    assert.equal(preview.events[0].type, "express_recon.routes.added");
    assert.equal(preview.events[0].data.total, 1);
  });
});

test("refresh emits OpenAPI contract deltas and gates breaking removals", () => {
  fixture((root) => {
    const output = path.join(root, ".express-recon", "api");
    runRefresh(root, ["--no-render"]);
    fs.writeFileSync(path.join(root, "app.js"), source(false));
    const result = JSON.parse(
      runRefresh(root, ["--no-render", "--fail-on", "contract-breaking"], 2).stdout,
    );
    assert.equal(result.openapiChanges.removedOperations, 1);
    assert.ok(result.openapiChanges.breakingChanges > 0);
    const delta = readJson(path.join(output, "openapi-delta.json"));
    assert.equal(delta.baselineAvailable, true);
    assert.ok(delta.breakingChanges.some((entry) => entry.kind === "operation-removed"));
  });
});

test("accepted AI enrichment survives unchanged scans and becomes dormant on source changes", () => {
  fixture((root) => {
    const output = path.join(root, ".express-recon", "api");
    runRefresh(root);
    const openapiFile = path.join(output, "openapi.json");
    const edited = readJson(openapiFile);
    const operation = edited.paths["/things/{id}"].get;
    operation.summary = "Get one thing";
    operation.description = "Returns the thing identified by the required path parameter.";
    operation.parameters[0].description = "Stable thing identifier";
    operation.responses["200"].description = "Thing found";
    operation["x-express-recon"].enrichmentSources = ["service.js"];
    edited.components ||= {};
    edited.components.schemas ||= {};
    edited.components.schemas.Thing = {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    };
    operation.responses["200"].content = {
      "application/json": { schema: { $ref: "#/components/schemas/Thing" } },
    };
    writeJson(openapiFile, edited);

    const rejected = runRefresh(root, [], 1);
    assert.match(rejected.stderr, /--accept-enrichment/);
    assert.equal(readJson(openapiFile).paths["/things/{id}"].get.summary, "Get one thing");

    const accepted = JSON.parse(runRefresh(root, ["--accept-enrichment"]).stdout);
    assert.equal(accepted.enrichmentSummary.appliedOperations, 1);
    assert.equal(accepted.enrichmentSummary.appliedSchemas, 1);
    const overlay = readJson(path.join(output, "openapi.enrichment.json"));
    assert.deepEqual(
      overlay.operations.map((entry) => entry.operation),
      ["GET /things/{id}"],
    );
    assert.deepEqual(
      overlay.operations[0].reviewedSources.map((entry) => entry.file),
      ["service.js"],
    );
    assert.deepEqual(
      overlay.schemas.map((entry) => entry.name),
      ["Thing"],
    );

    runRefresh(root);
    assert.equal(readJson(openapiFile).paths["/things/{id}"].get.summary, "Get one thing");

    fs.writeFileSync(
      path.join(root, "service.js"),
      "exports.loadThing = (id) => ({ id, changed: true });\n",
    );
    const stale = JSON.parse(runRefresh(root).stdout);
    assert.equal(stale.enrichmentSummary.appliedOperations, 0);
    assert.equal(stale.enrichmentSummary.staleOperations, 1);
    assert.equal(stale.enrichmentSummary.appliedSchemas, 0);
    assert.equal(stale.enrichmentSummary.staleSchemas, 1);
    assert.equal(stale.enrichmentSummary.dormantSchemas, 0);
    assert.equal(readJson(openapiFile).paths["/things/{id}"].get.summary, undefined);
    assert.equal(readJson(openapiFile).components?.schemas?.Thing, undefined);
    assert.equal(readJson(path.join(output, "openapi.enrichment.json")).operations.length, 1);

    fs.writeFileSync(path.join(root, "service.js"), "exports.loadThing = (id) => ({ id });\n");
    const restored = JSON.parse(runRefresh(root).stdout);
    assert.equal(restored.enrichmentSummary.appliedOperations, 1);
    assert.equal(readJson(openapiFile).paths["/things/{id}"].get.summary, "Get one thing");

    fs.writeFileSync(path.join(root, "app.js"), source(false));
    const removed = JSON.parse(runRefresh(root).stdout);
    assert.equal(removed.routeChanges.removedRoutes, 1);
    assert.equal(removed.enrichmentSummary.removedOperations, 1);
    assert.equal(removed.enrichmentSummary.staleSchemas, 1);
    assert.equal(removed.enrichmentSummary.dormantSchemas, 0);
    assert.equal(readJson(openapiFile).paths["/things/{id}"], undefined);
    assert.equal(readJson(path.join(output, "openapi.enrichment.json")).operations.length, 1);
  });
});

test("refresh rejects scanner-owned edits and never replaces unowned output", () => {
  fixture((root) => {
    const output = path.join(root, ".express-recon", "api");
    runRefresh(root);
    const openapiFile = path.join(output, "openapi.json");
    const edited = readJson(openapiFile);
    edited.paths["/things/{id}"].get.security = [];
    writeJson(openapiFile, edited);
    const rejected = runRefresh(root, ["--accept-enrichment"], 1);
    assert.match(rejected.stderr, /edits outside summary/);
    assert.equal(readJson(path.join(output, "openapi.enrichment.json")).operations.length, 0);

    const unowned = path.join(root, ".express-recon", "unowned");
    fs.mkdirSync(unowned);
    fs.writeFileSync(path.join(unowned, "keep.txt"), "keep");
    const conflict = runRefresh(root, ["--out", unowned, "--overwrite"], 1);
    assert.match(conflict.stderr, /refresh-manifest|Refresh state/);
    assert.equal(fs.readFileSync(path.join(unowned, "keep.txt"), "utf8"), "keep");
  });
});

test("refresh persists the render choice and can reset state without retaining enrichment", () => {
  fixture((root) => {
    const output = path.join(root, ".express-recon", "api");
    runRefresh(root, ["--no-render"]);
    assert.equal(fs.existsSync(path.join(output, "api-reference")), false);
    const manifest = readJson(path.join(output, "refresh-manifest.json"));
    assert.equal(manifest.render, false);
    assert.equal(manifest.invocation.render, false);

    runRefresh(root);
    assert.equal(fs.existsSync(path.join(output, "api-reference")), false);
    runRefresh(root, ["--render"]);
    assert.equal(fs.existsSync(path.join(output, "api-reference", "index.html")), true);

    const openapiFile = path.join(output, "openapi.json");
    const edited = readJson(openapiFile);
    edited.paths["/things/{id}"].get.summary = "Temporary enrichment";
    writeJson(openapiFile, edited);
    runRefresh(root, ["--accept-enrichment", "--no-render"]);
    assert.equal(readJson(path.join(output, "openapi.enrichment.json")).operations.length, 1);

    runRefresh(root, ["--overwrite", "--no-render"]);
    assert.equal(readJson(path.join(output, "openapi.enrichment.json")).operations.length, 0);
    assert.equal(readJson(openapiFile).paths["/things/{id}"].get.summary, undefined);
  });
});

test("refresh route state is scoped to the selected application", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-refresh-multi-"));
  try {
    const output = path.join(parent, "state");
    runRefresh(MULTI_APP_FIXTURE, [
      "--app-id",
      "app:src/public-app.js#app",
      "--out",
      output,
      "--no-render",
    ]);
    const report = readJson(path.join(output, "routes.json"));
    assert.equal(report.routes.length, 2);
    assert.ok(report.routes.every((route) => route.applicationId === "app:src/public-app.js#app"));
    assert.deepEqual(
      report.applications.map((application) => application.id),
      ["app:src/public-app.js#app"],
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("refresh safely persists a repository-local config across invocations", () => {
  fixture((root) => {
    const config = path.join(root, "recon.config.json");
    fs.writeFileSync(config, JSON.stringify({ authMiddleware: { requireAuth: "authenticated" } }));
    runRefresh(root, ["--config", config, "--no-render"]);
    const manifest = readJson(path.join(root, ".express-recon", "api", "refresh-manifest.json"));
    assert.equal(manifest.invocation.config, "recon.config.json");
    assert.equal(manifest.invocation.externalConfig, false);

    runRefresh(root, ["--no-render"]);

    fs.writeFileSync(config, JSON.stringify({ authMiddleware: { requireSession: "session" } }));
    runRefresh(root, ["--no-render"]);
  });
});

test("refresh never persists an external config path and requires it again", () => {
  fixture((root) => {
    const external = path.join(path.dirname(root), `external-${path.basename(root)}.json`);
    try {
      fs.writeFileSync(external, JSON.stringify({ authMiddleware: {} }));
      runRefresh(root, ["--config", external, "--no-render"]);
      const manifestFile = path.join(root, ".express-recon", "api", "refresh-manifest.json");
      const serialized = fs.readFileSync(manifestFile, "utf8");
      const manifest = JSON.parse(serialized);
      assert.equal(manifest.invocation.config, null);
      assert.equal(manifest.invocation.externalConfig, true);
      assert.equal(serialized.includes(external), false);

      const omitted = runRefresh(root, ["--no-render"], 1);
      assert.match(omitted.stderr, /external --config/);
      runRefresh(root, ["--config", external, "--no-render"]);
    } finally {
      fs.rmSync(external, { force: true });
    }
  });
});

test("accepted operation and schema enrichment can be explicitly cleared", () => {
  fixture((root) => {
    const output = path.join(root, ".express-recon", "api");
    const openapiFile = path.join(output, "openapi.json");
    runRefresh(root, ["--no-render"]);
    const edited = readJson(openapiFile);
    const operation = edited.paths["/things/{id}"].get;
    operation.summary = "Reviewed summary";
    edited.components = {
      ...edited.components,
      schemas: { ReviewedThing: { type: "object" } },
    };
    operation.responses.default = {
      description: "Reviewed",
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/ReviewedThing" } },
      },
    };
    writeJson(openapiFile, edited);
    runRefresh(root, ["--accept-enrichment", "--no-render"]);

    runRefresh(root, [
      "--accept-enrichment",
      "--clear-operation",
      "GET /things/{id}",
      "--clear-schema",
      "ReviewedThing",
      "--no-render",
    ]);

    const overlay = readJson(path.join(output, "openapi.enrichment.json"));
    assert.deepEqual(overlay.operations, []);
    assert.deepEqual(overlay.schemas, []);
    assert.equal(readJson(openapiFile).paths["/things/{id}"].get.summary, undefined);
  });
});

test("refresh records no-change review receipts and can renew stale evidence", () => {
  fixture((root) => {
    const output = path.join(root, ".express-recon", "api");
    runRefresh(root, ["--no-render"]);
    const reviewed = JSON.parse(
      runRefresh(root, [
        "--accept-enrichment",
        "--review-operation",
        "GET /things/{id}",
        "--no-render",
      ]).stdout,
    );
    assert.equal(reviewed.enrichmentSummary.appliedOperations, 1);
    assert.equal(reviewed.enrichmentSummary.unreviewedOperations, 0);
    const receipt = readJson(path.join(output, "openapi.enrichment.json")).operations[0];
    assert.deepEqual(receipt.fields, {});

    fs.appendFileSync(path.join(root, "app.js"), "\n// reviewed implementation changed\n");
    const stale = JSON.parse(runRefresh(root, ["--no-render"]).stdout);
    assert.equal(stale.enrichmentSummary.staleOperations, 1);
    const renewed = JSON.parse(
      runRefresh(root, [
        "--accept-enrichment",
        "--review-operation",
        "GET /things/{id}",
        "--no-render",
      ]).stdout,
    );
    assert.equal(renewed.enrichmentSummary.staleOperations, 0);
    assert.equal(renewed.enrichmentSummary.appliedOperations, 1);

    runRefresh(root, [
      "--accept-enrichment",
      "--clear-operation",
      "GET /things/{id}",
      "--no-render",
    ]);
    assert.deepEqual(readJson(path.join(output, "openapi.enrichment.json")).operations, []);
    assert.equal(
      readJson(path.join(output, "refresh-report.json")).enrichment.summary.unreviewedOperations,
      1,
    );
  });
});

test("refresh validates enrichment action selectors before replacing state", () => {
  fixture((root) => {
    runRefresh(root, ["--no-render"]);
    assert.match(
      runRefresh(root, ["--review-operation", "GET /things/{id}", "--no-render"], 1).stderr,
      /require --accept-enrichment/,
    );
    assert.match(
      runRefresh(
        root,
        ["--accept-enrichment", "--review-operation", "INVALID /things", "--no-render"],
        1,
      ).stderr,
      /OpenAPI HTTP method/,
    );
    assert.match(
      runRefresh(root, ["--accept-enrichment", "--clear-schema", "Unknown", "--no-render"], 1)
        .stderr,
      /has no saved enrichment/,
    );
  });
});

test("refresh rejects unresolved local references before accepting enrichment", () => {
  fixture((root) => {
    const output = path.join(root, ".express-recon", "api");
    const openapiFile = path.join(output, "openapi.json");
    runRefresh(root, ["--no-render"]);
    const edited = readJson(openapiFile);
    edited.paths["/things/{id}"].get.responses.default = {
      description: "Broken",
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/Missing" } },
      },
    };
    writeJson(openapiFile, edited);
    const rejected = runRefresh(root, ["--accept-enrichment", "--no-render"], 1);
    assert.match(rejected.stderr, /local reference does not resolve/);
    assert.deepEqual(readJson(path.join(output, "openapi.enrichment.json")).operations, []);
  });
});

test("refresh rejects unsafe invocation metadata and malformed persisted manifests", () => {
  assert.throws(
    () => refreshDocumentation({ invocation: { include: "src/**" }, render: false }),
    /invalid field types/,
  );
  assert.throws(
    () => refreshDocumentation({ invocation: { include: ["src/\0bad"] }, render: false }),
    /unsafe paths or scope patterns/,
  );

  fixture((root) => {
    const output = path.join(root, ".express-recon", "state");
    const manifestFile = path.join(output, "refresh-manifest.json");
    fs.mkdirSync(output, { recursive: true });

    fs.mkdirSync(manifestFile);
    assert.throws(() => readRefreshDefaults(root, output), /must be a regular file/);
    fs.rmSync(manifestFile, { recursive: true });

    fs.writeFileSync(manifestFile, "");
    assert.throws(() => readRefreshDefaults(root, output), /must be between 1 and/);
    fs.writeFileSync(manifestFile, "{");
    assert.throws(() => readRefreshDefaults(root, output), /Could not parse refresh state/);
    writeJson(manifestFile, {});
    assert.throws(() => readRefreshDefaults(root, output), /incompatible refresh-manifest/);

    const coreFiles = [
      "routes.json",
      "discovery.json",
      "openapi.generated.json",
      "openapi.enrichment.json",
      "openapi.baseline.json",
      "openapi.json",
      "openapi-delta.json",
      "docs-report.json",
      "refresh-report.json",
    ];
    const base = {
      schemaVersion: "1.0",
      kind: "express-recon-openapi-refresh",
      tool: "express-recon",
      ownedFiles: ["refresh-manifest.json", ...coreFiles],
      integrity: Object.fromEntries(coreFiles.map((file) => [file, `sha256:${"0".repeat(64)}`])),
      selection: { applicationId: null, spec: null, jsdoc: null },
      invocation: {
        config: null,
        externalConfig: false,
        include: [],
        exclude: [],
        ignoreFile: null,
        externalIgnoreFile: false,
        includeTests: false,
        includeHidden: false,
        render: false,
      },
    };

    writeJson(manifestFile, { ...base, ownedFiles: [...base.ownedFiles, "../escape"] });
    assert.throws(() => readRefreshDefaults(root, output), /unsafe owned path/);
    writeJson(manifestFile, {
      ...base,
      ownedFiles: [...base.ownedFiles, "refresh-manifest.json"],
    });
    assert.throws(() => readRefreshDefaults(root, output), /repeats an owned path/);
    writeJson(manifestFile, { ...base, ownedFiles: ["refresh-manifest.json"] });
    assert.throws(() => readRefreshDefaults(root, output), /missing required artifacts/);
    writeJson(manifestFile, { ...base, selection: { applicationId: 1, spec: null, jsdoc: null } });
    assert.throws(() => readRefreshDefaults(root, output), /invalid selection/);
    writeJson(manifestFile, {
      ...base,
      invocation: { ...base.invocation, externalConfig: true, config: "recon.json" },
    });
    assert.throws(() => readRefreshDefaults(root, output), /invalid invocation/);

    fs.rmSync(output, { recursive: true });
    assert.throws(
      () => readRefreshDefaults(root, output, { acceptEnrichment: true }),
      /requires an existing refresh output/,
    );
  });
});
