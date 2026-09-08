"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
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

function dispatch(app, url) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    Object.assign(req, { method: "GET", url, headers: {}, connection: {} });
    const res = new EventEmitter();
    res.setHeader = () => {};
    res.end = (body) => resolve(String(body || ""));
    app.handle(req, res, (error) => (error ? reject(error) : resolve("unhandled")));
  });
}

test("walks an Express app and emits one entry per (method,path)", () => {
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

test("recovers mount-path prefixes when instrumented", () => {
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

test("route middleware is scoped to its verb, not shared across the route", () => {
  const app = express();
  function requireAuth(_req, _res, next) {
    next();
  }
  app
    .route("/widgets")
    .get(requireAuth, (_req, res) => res.send("ok"))
    .post((_req, res) => res.sendStatus(201));
  const keyed = byKey(auditApp(app, CFG).routes);
  assert.equal(keyed["GET /widgets"].authStatus, "proven");
  assert.equal(keyed["POST /widgets"].authStatus, "public");
});

test("route().all() guards apply to every verb on the chain", () => {
  const app = express();
  function requireAuth(_req, _res, next) {
    next();
  }
  const r = express.Router();
  r.route("/mixed")
    .all(requireAuth)
    .get((_req, res) => res.send("ok"));
  app.use(r);
  const keyed = byKey(auditApp(app, CFG).routes);
  assert.equal(keyed["GET /mixed"].authStatus, "proven");
});

test("router.all routes are emitted as ALL instead of vanishing", () => {
  const app = express();
  function requireAuth(_req, _res, next) {
    next();
  }
  const r = express.Router();
  r.all("/webhook", requireAuth, (_req, res) => res.sendStatus(204));
  app.use(r);
  const keyed = byKey(auditApp(app, CFG).routes);
  assert.equal(keyed["ALL /webhook"].authStatus, "proven");
});

test("array route paths emit one route per path instead of crashing", () => {
  const app = express();
  app.get(["/a", "/b"], (_req, res) => res.send("ok"));
  const keys = Object.keys(byKey(inventory({ mode: "runtime", app }).routes)).sort();
  assert.deepEqual(keys, ["GET /a", "GET /b"]);
});

test("regexp route paths remain visible as partial dynamic routes", () => {
  const app = express();
  app.get(/^\/users\/(\d+)$/, (_req, res) => res.send("ok"));
  const { routes } = inventory({ mode: "runtime", app });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, "/<dynamic>");
  assert.equal(routes[0].pathConfidence, "partial");
});

test("an anonymous app-level guard downgrades later routes to review, not public", () => {
  const app = express();
  app.get("/before", (_req, res) => res.send("ok"));
  app.use((_req, _res, next) => next());
  app.get("/after", (_req, res) => res.send("ok"));
  const keyed = byKey(auditApp(app, { authMiddleware: {} }).routes);
  assert.equal(keyed["GET /before"].authStatus, "public");
  assert.equal(keyed["GET /after"].authStatus, "unknown");
});

test("bound middleware still matches the allowlist by its original name", () => {
  const app = express();
  function requireAuth(_req, _res, next) {
    next();
  }
  app.get("/bound", requireAuth.bind(null), (_req, res) => res.send("ok"));
  assert.equal(auditApp(app, CFG).routes[0].authStatus, "proven");
});

test("runtime routes carry pathConfidence", () => {
  const { routes } = inventory({ mode: "runtime", app: makeApp() });
  for (const r of routes) assert.equal(r.pathConfidence, "full");
});

test("runtime inventory retains explicit TRACE registrations", () => {
  instrument(express);
  const app = express();
  app.trace("/trace", (_req, res) => res.end("ok"));
  const route = inventory({ mode: "runtime", app }).routes[0];
  assert.equal(route.method, "TRACE");
  assert.equal(route.path, "/trace");
  assert.ok(route.source.file.endsWith("walk.test.js"));
});

test("runtime inventory retains extension verbs such as CONNECT", () => {
  const app = express();
  instrument(express);
  app.connect("/tunnel", (_req, res) => res.end("ok"));
  const route = inventory({ mode: "runtime", app }).routes.find(
    (item) => item.method === "CONNECT",
  );
  assert.equal(route.path, "/tunnel");
});

test("a path-scoped guard proves only routes under its prefix (instrumented)", () => {
  instrument(express);
  const app = express();
  function requireAuth(_req, _res, next) {
    next();
  }
  app.use("/admin", requireAuth);
  app.get("/admin/panel", (_req, res) => res.send("ok"));
  app.get("/outside", (_req, res) => res.send("ok"));
  const keyed = byKey(auditApp(app, CFG).routes);
  assert.equal(keyed["GET /admin/panel"].authStatus, "proven");
  assert.equal(keyed["GET /outside"].authStatus, "public");
});

test("mixed router case-sensitivity stays uncertain and matches actual dispatch", async () => {
  instrument(express);
  const app = express();
  app.set("case sensitive routing", true);
  const router = express.Router({ caseSensitive: false });
  function requireAuth(_req, res) {
    res.end("blocked");
  }
  app.use("/admin", requireAuth);
  router.get("/admin", (_req, res) => res.end("public"));
  app.use(router);

  const route = byKey(auditApp(app, CFG).routes)["GET /admin"];
  assert.equal(route.authStatus, "unknown");
  assert.deepEqual(route.middlewares[0].applicabilityReasons, ["case-sensitivity"]);
  assert.equal(await dispatch(app, "/ADMIN"), "public");

  const reverse = express();
  reverse.set("case sensitive routing", false);
  const sensitive = express.Router({ caseSensitive: true });
  reverse.use("/admin", requireAuth);
  sensitive.get("/admin", (_req, res) => res.end("public"));
  reverse.use(sensitive);
  assert.equal(byKey(auditApp(reverse, CFG).routes)["GET /admin"].authStatus, "proven");
  assert.equal(await dispatch(reverse, "/admin"), "blocked");
  assert.equal(await dispatch(reverse, "/ADMIN"), "blocked");
});

test("chained runtime middleware retains dispatch order", async () => {
  instrument(express);
  const app = express();
  const seen = [];
  function first(_req, _res, next) {
    seen.push("first");
    next();
  }
  function second(_req, _res, next) {
    seen.push("second");
    next();
  }
  app.use(first).use(second);
  app.get("/ordered", (_req, res) => res.end("ok"));
  assert.deepEqual(
    byKey(auditApp(app, CFG).routes)["GET /ordered"].middlewares.map((item) => item.name),
    ["first", "second"],
  );
  assert.equal(await dispatch(app, "/ordered"), "ok");
  assert.deepEqual(seen, ["first", "second"]);
});

test("wildcard scope evidence agrees with actual Express dispatch", async () => {
  instrument(express);
  const app = express();
  function requireAuth(_req, res) {
    res.end("blocked");
  }
  app.use("/admin/*rest", requireAuth);
  app.get("/public", (_req, res) => res.end("public"));
  app.get("/admin/item", (_req, res) => res.end("admin"));

  const keyed = byKey(auditApp(app, CFG).routes);
  assert.equal(keyed["GET /public"].authStatus, "public");
  assert.equal(keyed["GET /admin/item"].authStatus, "unknown");
  assert.equal(await dispatch(app, "/public"), "public");
  assert.equal(await dispatch(app, "/admin/item"), "blocked");
});

test("trailing-slash middleware scope agrees with actual Express dispatch", async () => {
  instrument(express);
  const app = express();
  function requireAuth(_req, res) {
    res.end("blocked");
  }
  app.use("/docs/", requireAuth);
  app.get("/docs/index.html", (_req, res) => res.end("public"));

  const route = byKey(auditApp(app, CFG).routes)["GET /docs/index.html"];
  assert.equal(route.authStatus, "proven");
  assert.equal(await dispatch(app, "/docs/index.html"), "blocked");
});

test("middleware after a mounted router does not guard that router", async () => {
  instrument(express);
  const app = express();
  const router = express.Router();
  function requireAuth(_req, res) {
    res.end("blocked");
  }
  router.get("/public", (_req, res) => res.end("public"));
  app.use("/api", router, requireAuth);

  assert.equal(byKey(auditApp(app, CFG).routes)["GET /api/public"].authStatus, "public");
  assert.equal(await dispatch(app, "/api/public"), "public");
});

/** 1-based line number of the caller, for asserting captured sources. */
function currentLine() {
  const err = {};
  Error.captureStackTrace(err, currentLine);
  return Number(err.stack.split("\n")[1].match(/:(\d+):\d+\)?$/)[1]);
}

test("instrumented apps capture the registration call site as route source", () => {
  instrument(express);
  const app = express();
  const directLine = currentLine() + 1;
  app.get("/direct", (_req, res) => res.send("ok"));
  const chainBase = currentLine();
  app
    .route("/chained")
    .get((_req, res) => res.send("ok"))
    .put((_req, res) => res.sendStatus(204));
  const r = express.Router();
  const mountedLine = currentLine() + 1;
  r.get("/inner", (_req, res) => res.send("ok"));
  app.use("/sub", r);

  const keyed = byKey(inventory({ mode: "runtime", app }).routes);
  assert.equal(keyed["GET /direct"].source.line, directLine);
  assert.ok(keyed["GET /direct"].source.file.endsWith("walk.test.js"));
  assert.equal(keyed["GET /chained"].source.line, chainBase + 3);
  assert.equal(keyed["PUT /chained"].source.line, chainBase + 4);
  assert.equal(keyed["GET /sub/inner"].source.line, mountedLine);
});

test("an array-path guard scopes to each listed prefix (instrumented)", () => {
  instrument(express);
  const app = express();
  function requireAuth(_req, _res, next) {
    next();
  }
  app.use(["/x", "/y"], requireAuth);
  app.get("/x/thing", (_req, res) => res.send("ok"));
  app.get("/z/thing", (_req, res) => res.send("ok"));
  const keyed = byKey(auditApp(app, CFG).routes);
  assert.equal(keyed["GET /x/thing"].authStatus, "proven");
  assert.equal(keyed["GET /z/thing"].authStatus, "public");
});
