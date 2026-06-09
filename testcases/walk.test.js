"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const { audit, inventory, instrument } = require("../src/index");

const CFG = {
  authMiddleware: {
    requireAuth: "authenticated",
    snsSignatureVerifier: "signed:aws-sns",
  },
};

function auditApp(app, config) {
  return audit({ mode: "runtime", app }, config);
}

function makeApp() {
  const app = express();
  function snsSignatureVerifier(_req, _res, next) {
    next();
  }
  function requireAuth(_req, _res, next) {
    next();
  }
  app.get("/health", (_req, res) => res.send("ok"));
  app.post("/aws/sns", snsSignatureVerifier, (_req, res) => res.sendStatus(204));
  const approval = express.Router();
  approval.get("/approval", requireAuth, (_req, res) => res.send("ok"));
  approval.post("/approval", requireAuth, (_req, res) => res.sendStatus(200));
  app.use(approval);
  return app;
}

function byKey(routes) {
  return Object.fromEntries(routes.map((r) => [`${r.method} ${r.path}`, r]));
}

test("walks an express 5 app and emits one entry per (method,path)", () => {
  const { routes } = auditApp(makeApp(), CFG);
  assert.deepEqual(Object.keys(byKey(routes)).sort(), [
    "GET /approval",
    "GET /health",
    "POST /approval",
    "POST /aws/sns",
  ]);
});

test("inventory returns routes with no security judgment", () => {
  const { routes } = inventory({ mode: "runtime", app: makeApp() });
  assert.ok(routes.length > 0);
  for (const r of routes) assert.equal(r.authStatus, undefined);
});

test("a route with no middleware is public", () => {
  const health = byKey(auditApp(makeApp(), CFG).routes)["GET /health"];
  assert.equal(health.authStatus, "public");
});

test("a named but un-allowlisted middleware leaves a route public", () => {
  const app = express();
  function tenantGuard(_req, _res, next) {
    next();
  }
  app.get("/secret", tenantGuard, (_req, res) => res.send("ok"));
  assert.equal(auditApp(app, { authMiddleware: {} }).routes[0].authStatus, "public");
  assert.equal(
    auditApp(app, { authMiddleware: { tenantGuard: "tenant" } }).routes[0].authStatus,
    "proven",
  );
});

test("an inline (anonymous) guard keeps a route out of the public bucket", () => {
  const app = express();
  app.get(
    "/inline",
    (req, res, next) => next(),
    (_req, res) => res.send("ok"),
  );
  assert.equal(auditApp(app, { authMiddleware: {} }).routes[0].authStatus, "unknown");
});

test("tags signature-verified and authenticated routes as proven", () => {
  const keyed = byKey(auditApp(makeApp(), CFG).routes);
  assert.deepEqual(keyed["POST /aws/sns"].tags, ["signed:aws-sns"]);
  assert.equal(keyed["POST /approval"].authStatus, "proven");
});

test("recovers mount-path prefixes on Express 5 when instrumented", () => {
  instrument(express);
  const app = express();
  const admin = express.Router();
  admin.get("/list", (_req, res) => res.send("ok"));
  admin.get("/:id", (_req, res) => res.send("ok"));
  app.use("/admin/:org", admin);
  app.get("/health", (_req, res) => res.send("ok"));
  const paths = inventory({ mode: "runtime", app })
    .routes.map((r) => `${r.method} ${r.path}`)
    .sort();
  assert.deepEqual(paths, ["GET /admin/:org/:id", "GET /admin/:org/list", "GET /health"]);
});

test("throws a clear error for a non-app", () => {
  assert.throws(() => auditApp({}), /expected an Express app or Router/);
});
