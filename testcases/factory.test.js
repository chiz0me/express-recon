"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { audit } = require("../src/index");

const FIXTURE = path.join(__dirname, "fixtures", "factory-app");
const CONFIG = { authMiddleware: { requireAuth: "authenticated" } };

function index(routes) {
  return Object.fromEntries(routes.map((r) => [`${r.method} ${r.path}`, r]));
}

function run() {
  return audit({ mode: "static", src: FIXTURE }, CONFIG);
}

test("resolves routes through a factory barrel and member-expression mounts", () => {
  const keys = Object.keys(index(run().routes)).sort();
  assert.deepEqual(keys, [
    "GET /auth/me",
    "GET /health",
    "GET /internal/ping",
    "GET /internal/sub/info",
    "GET /open/status",
    "POST /auth/token",
  ]);
});

test("every resolved route has a full (non-partial) path", () => {
  for (const route of run().routes) assert.equal(route.pathConfidence, "full");
});

test("classifies a locally-required `.use()` guard as authenticated", () => {
  const routes = index(run().routes);
  assert.equal(routes["GET /auth/me"].authStatus, "proven");
  assert.deepEqual(routes["GET /auth/me"].tags, ["authenticated"]);
  assert.equal(routes["POST /auth/token"].authStatus, "proven");
});

test("leaves an unguarded sub-router route public", () => {
  const routes = index(run().routes);
  assert.equal(routes["GET /open/status"].authStatus, "public");
});

test("ignores method calls on non-router objects (no phantom routes)", () => {
  const paths = run().routes.map((r) => r.path);
  assert.ok(!paths.some((p) => p.includes("<dynamic>")));
  assert.ok(!paths.includes("/seed"));
});

test("warns about ignored non-router method calls", () => {
  const { diagnostics } = run();
  assert.ok(diagnostics.some((d) => /non-router objects/.test(d)));
});
