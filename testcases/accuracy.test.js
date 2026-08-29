"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { audit } = require("../src/index");
const { authStatusFor } = require("../src/classify");
const { reconcile } = require("../src/reconcile");

const FIXTURE = path.join(__dirname, "fixtures", "accuracy-app");
const CONFIG = {
  authMiddleware: { requireAuth: "authenticated" },
  authWrappers: ["asyncHandler"],
};

function run() {
  return audit({ mode: "static", src: FIXTURE }, CONFIG);
}

function index(routes) {
  return Object.fromEntries(routes.map((r) => [`${r.method} ${r.path}`, r]));
}

test("a path-scoped guard proves only routes under its prefix", () => {
  const routes = index(run().routes);
  assert.equal(routes["GET /admin/panel"].authStatus, "proven");
  assert.equal(routes["GET /outside"].authStatus, "public");
});

test("an array mount path scopes the guard to each listed prefix", () => {
  const routes = index(run().routes);
  assert.equal(routes["GET /x/thing"].authStatus, "proven");
  assert.equal(routes["GET /z/thing"].authStatus, "public");
});

test("chained use()/verb registrations resolve to the root host", () => {
  const routes = index(run().routes);
  assert.equal(routes["GET /chained"].authStatus, "proven");
  assert.ok(routes["GET /chained"].middlewares.some((m) => m.name === "limiter"));
});

test("route().all() guards apply to sibling verbs, without a phantom ALL route", () => {
  const routes = index(run().routes);
  assert.equal(routes["GET /config"].authStatus, "proven");
  assert.equal(routes["PUT /config"].authStatus, "proven");
  assert.equal(routes["ALL /config"], undefined);
});

test("array route paths expand to one full-confidence route per path", () => {
  const routes = index(run().routes);
  for (const key of ["GET /multi-a", "GET /multi-b"]) {
    assert.equal(routes[key].authStatus, "proven");
    assert.equal(routes[key].pathConfidence, "full");
  }
});

test("app.get('view engine') is a settings getter, not a route", () => {
  assert.ok(!run().routes.some((r) => r.path.includes("view engine")));
});

test("a guard use()d after a route does not prove it", () => {
  const routes = index(run().routes);
  assert.equal(routes["GET /late-unguarded"].authStatus, "public");
  assert.equal(routes["GET /late-guarded"].authStatus, "proven");
});

test("a middleware named like an Object.prototype member is not proven", () => {
  const { authStatus } = authStatusFor(
    [{ name: "constructor", kind: "identifier", raw: "constructor" }],
    {},
  );
  assert.equal(authStatus, "public");
});

test("const/concat/template paths resolve to full-confidence routes", () => {
  const routes = index(run().routes);
  for (const key of ["GET /api/v1/const", "GET /api/v1/tpl"]) {
    assert.equal(routes[key].authStatus, "proven");
    assert.equal(routes[key].pathConfidence, "full");
  }
});

test("a guard wrapped in a call matches the allowlist through inner names", () => {
  const routes = index(run().routes);
  assert.equal(routes["GET /wrapped"].authStatus, "proven");
});

test("an unconfigured wrapper containing an auth name stays unknown", () => {
  const { authStatus } = authStatusFor(
    [
      {
        name: "conditional",
        kind: "call",
        raw: "conditional(requireAuth)",
        inner: ["requireAuth"],
      },
    ],
    CONFIG.authMiddleware,
  );
  assert.equal(authStatus, "unknown");
});

test("a configured transparent wrapper may prove its inner auth middleware", () => {
  const { authStatus } = authStatusFor(
    [
      {
        name: "asyncHandler",
        kind: "call",
        raw: "asyncHandler(requireAuth)",
        inner: ["requireAuth"],
      },
    ],
    CONFIG.authMiddleware,
    false,
    CONFIG.authWrappers,
  );
  assert.equal(authStatus, "proven");
});

const REGISTRAR = path.join(__dirname, "fixtures", "registrar-app");

test("registrar-pattern routes surface as partial orphans with a diagnostic", () => {
  const { routes, diagnostics } = audit({ mode: "static", src: REGISTRAR }, CONFIG);
  const keyed = index(routes);
  assert.equal(keyed["POST /reg/users"].authStatus, "proven");
  assert.equal(keyed["POST /reg/users"].pathConfidence, "partial");
  assert.equal(keyed["GET /reg/health"].authStatus, "public");
  assert.ok(diagnostics.some((d) => /registrar/.test(d)));
});

function staticRoute(path, extra) {
  return {
    method: "GET",
    path,
    pathConfidence: "partial",
    source: { file: "r.js", line: 3 },
    middlewares: [],
    ...extra,
  };
}

function runtimeRoute(path, source = null) {
  return { method: "GET", path, pathConfidence: "full", source, middlewares: [] };
}

test("hybrid reconcile merges a partial static route with its runtime twin by suffix", () => {
  const { routes } = reconcile(
    { routes: [staticRoute("/users/:id")], globalMiddleware: [] },
    { routes: [runtimeRoute("/api/users/:id")], globalMiddleware: [] },
  );
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, "/api/users/:id");
  assert.equal(routes[0].presence, "both");
  assert.deepEqual(routes[0].source, { file: "r.js", line: 3 });
  assert.equal(routes[0].observations.static.path, "/users/:id");
  assert.equal(routes[0].observations.runtime.path, "/api/users/:id");
  assert.deepEqual(routes[0].observations.conflicts, ["path"]);
});

test("hybrid reconcile pairs routes by registration source when suffixes are ambiguous", () => {
  const { routes } = reconcile(
    { routes: [staticRoute("/users/:id")], globalMiddleware: [] },
    {
      routes: [
        runtimeRoute("/api/users/:id", { file: "r.js", line: 3 }),
        runtimeRoute("/admin/users/:id", { file: "r.js", line: 9 }),
      ],
      globalMiddleware: [],
    },
  );
  const merged = routes.find((r) => r.presence === "both");
  assert.equal(merged.path, "/api/users/:id");
  assert.deepEqual(merged.source, { file: "r.js", line: 3 });
  assert.equal(routes.filter((r) => r.presence === "runtime-only").length, 1);
});

test("an un-instrumented runtime walk yields null sources", () => {
  const express = require("express");
  const app = express();
  app.get("/plain", (_req, res) => res.send("ok"));
  const { routes } = audit({ mode: "runtime", app }, CONFIG);
  assert.equal(routes[0].source, null);
});

test("hybrid reconcile leaves ambiguous suffix matches unmerged", () => {
  const { routes } = reconcile(
    { routes: [staticRoute("/users/:id")], globalMiddleware: [] },
    {
      routes: [runtimeRoute("/api/users/:id"), runtimeRoute("/admin/users/:id")],
      globalMiddleware: [],
    },
  );
  const presences = routes.map((r) => r.presence).sort();
  assert.deepEqual(presences, ["runtime-only", "runtime-only", "static-only"]);
});

test("hybrid exact matches use runtime middleware and auth classification", () => {
  const staticView = staticRoute("/account", {
    pathConfidence: "full",
    authStatus: "proven",
    tags: ["authenticated"],
    middlewares: [{ name: "configuredGuard", kind: "identifier", raw: "configuredGuard" }],
    io: { handlerResolved: true },
  });
  const runtimeView = runtimeRoute("/account");
  runtimeView.authStatus = "public";
  runtimeView.tags = ["public"];
  runtimeView.middlewares = [{ name: "jsonParser", kind: "identifier", raw: "jsonParser" }];

  const { routes } = reconcile(
    { routes: [staticView], globalMiddleware: [] },
    { routes: [runtimeView], globalMiddleware: [] },
  );

  assert.equal(routes.length, 1);
  assert.equal(routes[0].presence, "both");
  assert.equal(routes[0].authStatus, "public");
  assert.deepEqual(routes[0].tags, ["public"]);
  assert.deepEqual(routes[0].middlewares, runtimeView.middlewares);
  assert.deepEqual(routes[0].source, staticView.source);
  assert.deepEqual(routes[0].io, staticView.io);
  assert.deepEqual(routes[0].observations.static.middlewares, staticView.middlewares);
  assert.deepEqual(routes[0].observations.runtime.middlewares, runtimeView.middlewares);
  assert.deepEqual(routes[0].observations.conflicts, [
    "middleware-identity",
    "auth-classification",
  ]);
});

test("hybrid exact matching never assigns a booted route to the wrong application", () => {
  const admin = staticRoute("/health", {
    applicationId: "app:admin#app",
    pathConfidence: "full",
    source: { file: "admin.js", line: 3 },
  });
  const publicApp = staticRoute("/health", {
    applicationId: "app:public#app",
    pathConfidence: "full",
    source: { file: "public.js", line: 3 },
    authStatus: "public",
    accepted: true,
  });
  const runtime = runtimeRoute("/health", { file: "public.js", line: 3 });
  runtime.applicationId = "runtime:default";
  runtime.authStatus = "public";

  const { routes } = reconcile(
    { routes: [admin, publicApp], globalMiddleware: [] },
    { routes: [runtime], globalMiddleware: [] },
  );
  const adminResult = routes.find((route) => route.applicationId === "app:admin#app");
  const publicResult = routes.find((route) => route.applicationId === "app:public#app");
  assert.equal(adminResult.presence, "static-only");
  assert.equal(publicResult.presence, "both");
  assert.equal(publicResult.accepted, true);
});

test("hybrid app identity wins when multiple apps mount the same source registration", () => {
  const sharedSource = { file: "routes/shared.js", line: 8 };
  const admin = staticRoute("/health", {
    applicationId: "app:admin#app",
    pathConfidence: "full",
    source: sharedSource,
  });
  const publicApp = staticRoute("/health", {
    applicationId: "app:public#app",
    pathConfidence: "full",
    source: sharedSource,
  });
  const runtime = runtimeRoute("/health", sharedSource);
  runtime.applicationId = "app:public#app";

  const { routes } = reconcile(
    { routes: [admin, publicApp], globalMiddleware: [] },
    { routes: [runtime], globalMiddleware: [] },
  );
  assert.equal(
    routes.find((route) => route.applicationId === "app:admin#app").presence,
    "static-only",
  );
  assert.equal(routes.find((route) => route.applicationId === "app:public#app").presence, "both");
});

test("hybrid keeps shared-source runtime evidence separate without an app identity", () => {
  const sharedSource = { file: "routes/shared.js", line: 8 };
  const staticRoutes = ["admin", "public"].map((name) =>
    staticRoute("/health", {
      applicationId: `app:${name}#app`,
      pathConfidence: "full",
      source: sharedSource,
    }),
  );
  const runtime = runtimeRoute("/health", sharedSource);
  runtime.applicationId = "runtime:default";

  const { routes } = reconcile(
    { routes: staticRoutes, globalMiddleware: [] },
    { routes: [runtime], globalMiddleware: [] },
  );
  assert.deepEqual(routes.map((route) => route.presence).sort(), [
    "runtime-only",
    "static-only",
    "static-only",
  ]);
});

test("hybrid keeps an unsourced duplicate runtime route separate when app identity is ambiguous", () => {
  const staticRoutes = [
    staticRoute("/health", { applicationId: "app:admin#app", pathConfidence: "full" }),
    staticRoute("/health", { applicationId: "app:public#app", pathConfidence: "full" }),
  ];
  const runtime = runtimeRoute("/health");
  runtime.applicationId = "runtime:default";
  const { routes } = reconcile(
    { routes: staticRoutes, globalMiddleware: [] },
    { routes: [runtime], globalMiddleware: [] },
  );
  assert.deepEqual(routes.map((route) => route.presence).sort(), [
    "runtime-only",
    "static-only",
    "static-only",
  ]);
});

test("hybrid suffix matching does not cross applications with the same partial route", () => {
  const admin = staticRoute("<dynamic>/health", {
    applicationId: "app:admin#app",
    source: { file: "admin.js", line: 3 },
  });
  const publicApp = staticRoute("<dynamic>/health", {
    applicationId: "app:public#app",
    source: { file: "public.js", line: 3 },
  });
  const runtime = runtimeRoute("/api/health", { file: "public.js", line: 3 });
  runtime.applicationId = "runtime:default";
  const { routes } = reconcile(
    { routes: [admin, publicApp], globalMiddleware: [] },
    { routes: [runtime], globalMiddleware: [] },
  );
  assert.equal(
    routes.find((route) => route.applicationId === "app:admin#app").presence,
    "static-only",
  );
  assert.equal(routes.find((route) => route.applicationId === "app:public#app").presence, "both");
});

test("test files are excluded from scans by default", () => {
  const withDefault = audit({ mode: "static", src: REGISTRAR }, CONFIG);
  assert.ok(!withDefault.routes.some((r) => r.path === "/phantom"));
  const withTests = audit({ mode: "static", src: REGISTRAR, includeTests: true }, CONFIG);
  assert.ok(withTests.routes.some((r) => r.path === "/phantom"));
});
