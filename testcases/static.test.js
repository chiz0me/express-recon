"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { audit } = require("../src/index");

const FIXTURE = path.join(__dirname, "fixtures", "static-app");
const CONFIG = {
  authMiddleware: {
    requireAuth: "authenticated",
    "passport.authenticate": "session",
  },
};

function scanRepo(dir, config) {
  return audit({ mode: "static", src: dir }, config);
}

function index(routes) {
  return Object.fromEntries(routes.map((r) => [`${r.method} ${r.path}`, r]));
}

function withBrokenFixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-broken-"));
  try {
    fs.writeFileSync(
      path.join(dir, "app.js"),
      [
        '"use strict";',
        'const express = require("express");',
        "const app = express();",
        'app.get("/visible", (_req, res) => res.send("ok"));',
        "module.exports = app;",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(dir, "broken.js"), '"use strict";\nconst = ;\n');
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("reconstructs paths across a mounted sub-router", () => {
  const { routes } = scanRepo(FIXTURE, CONFIG);
  const keys = Object.keys(index(routes)).sort();
  assert.deepEqual(keys, [
    "DELETE /admin/users/:id",
    "GET /admin/config",
    "GET /admin/stats",
    "GET /health",
    "GET /me",
    "POST /webhook",
    "PUT /admin/config",
  ]);
});

test("classifies auth status without executing the app", () => {
  const routes = index(scanRepo(FIXTURE, CONFIG).routes);
  assert.equal(routes["GET /health"].authStatus, "public");
  assert.equal(routes["GET /me"].authStatus, "proven");
  assert.deepEqual(routes["GET /me"].tags, ["authenticated"]);
  assert.equal(routes["POST /webhook"].authStatus, "proven");
  assert.deepEqual(routes["POST /webhook"].tags, ["session"]);
  // requireRole is named but not allow-listed -> greppable, treated as public
  assert.equal(routes["DELETE /admin/users/:id"].authStatus, "public");
});

test("records source file and line for each route", () => {
  const routes = index(scanRepo(FIXTURE, CONFIG).routes);
  const health = routes["GET /health"];
  assert.ok(health.source.file.endsWith("app.js"));
  assert.equal(typeof health.source.line, "number");
  const stats = routes["GET /admin/stats"];
  assert.ok(stats.source.file.endsWith(path.join("routes", "admin.js")));
});

test("propagates global middleware into the chain of mounted routes", () => {
  const routes = index(scanRepo(FIXTURE, CONFIG).routes);
  const names = routes["GET /admin/stats"].middlewares.map((m) => m.name);
  assert.deepEqual(names, ["express.json", "logger"]);
});

test("captures app-level global middleware", () => {
  const { globalMiddleware } = scanRepo(FIXTURE, CONFIG);
  const names = globalMiddleware.map((m) => m.name).sort();
  assert.deepEqual(names, ["express.json", "logger"]);
});

test("reports incomplete coverage when a source file cannot be parsed", () => {
  const result = withBrokenFixture((dir) => scanRepo(dir, CONFIG));
  const { scope, ...coverage } = result.scanCoverage;
  assert.deepEqual(coverage, {
    discovered: 2,
    analyzed: 1,
    failed: 1,
    skipped: 0,
    limited: false,
    totalBytes: result.scanCoverage.totalBytes,
    complete: false,
  });
  assert.match(scope.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(result.scanCoverage.totalBytes > 0);
  assert.ok(result.routes.some((route) => route.path === "/visible"));
  assert.ok(
    result.diagnostics.some(
      (message) => message.includes("could not parse") && message.includes("broken.js"),
    ),
  );
});

test("TypeScript declaration files do not affect executable source coverage", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-declarations-"));
  try {
    fs.writeFileSync(
      path.join(dir, "app.js"),
      'const express = require("express"); const app = express(); app.get("/ready", handler);',
    );
    fs.writeFileSync(
      path.join(dir, "legacy.d.ts"),
      "declare module Legacy { export interface Broken { [key?: string]: unknown } }",
    );
    const result = scanRepo(dir, CONFIG);
    assert.equal(result.scanCoverage.complete, true);
    assert.equal(result.scanCoverage.discovered, 1);
    assert.deepEqual(
      result.routes.map((route) => route.path),
      ["/ready"],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scan file-count and total-byte limits fail coverage closed", () => {
  const byCount = audit({ mode: "static", src: FIXTURE, maxFiles: 1 }, CONFIG);
  assert.equal(byCount.scanCoverage.complete, false);
  assert.equal(byCount.scanCoverage.limited, true);
  assert.ok(byCount.diagnostics.some((message) => message.includes("scan.maxFiles")));

  const byBytes = audit({ mode: "static", src: FIXTURE, maxTotalBytes: 1024 }, CONFIG);
  assert.equal(byBytes.scanCoverage.complete, false);
  assert.equal(byBytes.scanCoverage.limited, true);
  assert.ok(byBytes.diagnostics.some((message) => message.includes("scan.maxTotalBytes")));
});
