"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { discover, inventory, buildReport } = require("../src");

const FIXTURE = path.join(__dirname, "fixtures", "discovery-app");
const CLI = path.join(__dirname, "..", "src", "cli.js");

test("discovery separates multiple Express applications and package scopes", () => {
  const result = discover(FIXTURE);
  assert.deepEqual(
    result.packages.map((item) => item.name),
    ["discovery-root", "discovery-admin"],
  );
  assert.equal(result.applications.length, 2);
  assert.equal(result.discoveryCoverage.complete, true);
  assert.equal(new Set(result.applications.map((item) => item.id)).size, 2);
  for (const application of result.applications) {
    assert.ok(application.packageId);
    assert.equal(application.recommendedEntry, application.entryCandidates[0].path);
    assert.equal(application.entryCandidates[0].confidence, "high");
  }
});

test("same method/path in separate apps remains distinct in the inventory", () => {
  const registry = inventory({ mode: "static", src: FIXTURE });
  const health = registry.routes.filter(
    (route) => route.method === "GET" && route.path === "/health",
  );
  assert.equal(health.length, 2);
  assert.equal(new Set(health.map((route) => route.applicationId)).size, 2);
});

test("discovery finds existing specs and swagger-jsdoc sources", () => {
  const result = discover(FIXTURE);
  assert.deepEqual(result.documentation.specifications, [
    { path: "docs/openapi.yaml", format: "openapi", version: "3.1.0" },
  ]);
  assert.deepEqual(result.documentation.jsdoc, ["src/documented.js"]);
});

test("reports normalize application and route source paths relative to the scan root", () => {
  const report = buildReport(inventory({ mode: "static", src: FIXTURE }), {
    command: "inventory",
    mode: "static",
    sourceRoot: FIXTURE,
  });
  for (const application of report.applications) {
    assert.ok(!path.isAbsolute(application.source.file));
  }
  for (const route of report.routes) assert.ok(!path.isAbsolute(route.source.file));
});

test("discover CLI emits a portable JSON artifact", () => {
  const result = spawnSync("node", [CLI, "discover", "--src", FIXTURE], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.applications.length, 2);
  assert.equal(output.discoveryCoverage.complete, true);
  assert.ok(output.applications.every((item) => !path.isAbsolute(item.source.file)));
});

test("discovery excludes test fixture packages and apps unless requested", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-discovery-tests-"));
  try {
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "production", dependencies: { express: "^5" } }),
    );
    fs.writeFileSync(
      path.join(root, "app.js"),
      'const express = require("express"); const app = express(); app.get("/live", handler);',
    );
    const fixture = path.join(root, "test", "fixture");
    fs.mkdirSync(fixture, { recursive: true });
    fs.writeFileSync(
      path.join(fixture, "package.json"),
      JSON.stringify({ name: "fixture", dependencies: { express: "^4" } }),
    );
    fs.writeFileSync(
      path.join(fixture, "app.js"),
      'const express = require("express"); const app = express(); app.get("/test", handler);',
    );

    assert.deepEqual(
      discover(root).packages.map((item) => item.name),
      ["production"],
    );
    assert.deepEqual(
      discover(root, { includeTests: true }).packages.map((item) => item.name),
      ["production", "fixture"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("discovery applies .express-reconignore to packages, apps, specs, and JSDoc", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-discovery-scope-"));
  try {
    fs.writeFileSync(path.join(root, ".express-reconignore"), "ignored/**\n");
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "visible", dependencies: { express: "^5" } }),
    );
    fs.writeFileSync(
      path.join(root, "app.js"),
      'const express = require("express"); const app = express(); app.get("/visible", handler);',
    );
    const ignored = path.join(root, "ignored");
    fs.mkdirSync(ignored);
    fs.writeFileSync(
      path.join(ignored, "package.json"),
      JSON.stringify({ name: "ignored", dependencies: { express: "^5" } }),
    );
    fs.writeFileSync(
      path.join(ignored, "app.js"),
      '/** @openapi /ignored: {} */\nconst express = require("express"); const app = express(); app.get("/ignored", handler);',
    );
    fs.writeFileSync(path.join(ignored, "openapi.yaml"), "openapi: 3.1.0\npaths: {}\n");

    const result = discover(root);
    assert.deepEqual(
      result.packages.map((item) => item.name),
      ["visible"],
    );
    assert.deepEqual(
      result.applications.map((item) => item.name),
      ["app.js#app"],
    );
    assert.deepEqual(result.documentation, { specifications: [], jsdoc: [] });
    assert.equal(result.discoveryCoverage.scope.fingerprint, result.scanCoverage.scope.fingerprint);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
