"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { audit } = require("../src/index");

const FIXTURE = path.join(__dirname, "fixtures", "ts-app");
const CONFIG = { authMiddleware: { requireAuth: "authenticated" } };

function index(routes) {
  return Object.fromEntries(routes.map((r) => [`${r.method} ${r.path}`, r]));
}

test("parses TypeScript and resolves ESM imports + path aliases + barrels", () => {
  const { routes } = audit({ mode: "static", src: FIXTURE }, CONFIG);
  assert.deepEqual(Object.keys(index(routes)).sort(), [
    "DELETE /api/admin/users/:id",
    "GET /api/admin/config",
    "GET /api/admin/stats",
    "GET /api/ping",
    "GET /health",
    "GET /me",
    "PUT /api/admin/config",
  ]);
});

test("every TS route resolves to a full path (no partial confidence)", () => {
  const { routes } = audit({ mode: "static", src: FIXTURE }, CONFIG);
  for (const r of routes) assert.equal(r.pathConfidence, "full", `${r.method} ${r.path}`);
});

test("classifies auth through alias-imported middleware", () => {
  const routes = index(audit({ mode: "static", src: FIXTURE }, CONFIG).routes);
  assert.equal(routes["GET /me"].authStatus, "proven");
  assert.equal(routes["DELETE /api/admin/users/:id"].authStatus, "proven");
  assert.equal(routes["GET /api/ping"].authStatus, "public");
});

test("records .ts source files and line numbers", () => {
  const routes = index(audit({ mode: "static", src: FIXTURE }, CONFIG).routes);
  const me = routes["GET /me"];
  assert.ok(me.source.file.endsWith("app.ts"));
  assert.equal(typeof me.source.line, "number");
  assert.ok(routes["GET /api/admin/stats"].source.file.endsWith(path.join("routes", "admin.ts")));
});
