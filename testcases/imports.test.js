"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { audit } = require("../src/index");

const FIXTURE = path.join(__dirname, "fixtures", "imports-app");
const CONFIG = { authMiddleware: { requireAuth: "authenticated" } };

function index(routes) {
  return Object.fromEntries(routes.map((r) => [`${r.method} ${r.path}`, r]));
}

test("resolves routers mounted via package.json #imports subpath aliases", () => {
  const routes = index(audit({ mode: "static", src: FIXTURE }, CONFIG).routes);
  const keys = Object.keys(routes).sort();
  assert.deepEqual(keys, ["GET /admin/open", "GET /admin/stats", "GET /health"]);
  // Mount resolved, so paths are full-confidence, not orphaned partials.
  for (const key of keys) assert.equal(routes[key].pathConfidence, "full");
});

test("classifies #imports-mounted routes and follows #imports for the guard", () => {
  const routes = index(audit({ mode: "static", src: FIXTURE }, CONFIG).routes);
  // requireAuth is itself required via `#mw/auth.js`; the allowlist still matches by name.
  assert.equal(routes["GET /admin/stats"].authStatus, "proven");
  assert.equal(routes["GET /admin/open"].authStatus, "public");
});
