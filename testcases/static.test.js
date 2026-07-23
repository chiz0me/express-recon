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
  assert.deepEqual(result.scanCoverage, {
    discovered: 2,
    analyzed: 1,
    failed: 1,
    complete: false,
  });
  assert.ok(result.routes.some((route) => route.path === "/visible"));
  assert.ok(
    result.diagnostics.some(
      (message) => message.includes("could not parse") && message.includes("broken.js"),
    ),
  );
});
