"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { audit, evaluatePolicies, inventory } = require("../src/index");
const { authStatusFor, validateAuthMiddleware } = require("../src/classify");
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

function withAppSource(lines, runTest) {
  return withSourceFiles({ "app.js": lines.join("\n") }, runTest);
}

function withSourceFiles(files, runTest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-accuracy-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), source);
    }
    return runTest(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test("TRACE registrations are retained by the static inventory", () => {
  withAppSource(
    [
      'const express = require("express");',
      "const app = express();",
      'app.trace("/trace", (_req, res) => res.end());',
    ],
    (dir) => {
      const route = audit({ mode: "static", src: dir }, CONFIG).routes[0];
      assert.equal(route.method, "TRACE");
      assert.equal(route.path, "/trace");
      assert.equal(route.pathConfidence, "full");
    },
  );
});

test("non-OpenAPI Express verbs remain explicit inventory evidence", () => {
  withSourceFiles(
    {
      "app.js": [
        'const app = require("express")();',
        'app.connect("/tunnel", (_req, res) => res.end());',
        "module.exports = app;",
      ].join("\n"),
    },
    (root) => {
      const route = inventory({ mode: "static", src: root }).routes[0];
      assert.equal(route.method, "CONNECT");
      assert.equal(route.path, "/tunnel");
    },
  );
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

test("structured role-only grants imply authentication and invalid maps fail closed", () => {
  assert.throws(() => validateAuthMiddleware(null), /must be an object/);
  const result = authStatusFor([{ name: "roleGuard", kind: "identifier", raw: "roleGuard" }], {
    roleGuard: { roles: ["admin"] },
  });
  assert.equal(result.authStatus, "proven");
  assert.deepEqual(result.tags, ["authenticated"]);
  assert.deepEqual(result.roles, ["admin"]);
});

test("const/concat/template paths resolve to full-confidence routes", () => {
  const routes = index(run().routes);
  for (const key of ["GET /api/v1/const", "GET /api/v1/tpl"]) {
    assert.equal(routes[key].authStatus, "proven");
    assert.equal(routes[key].pathConfidence, "full");
  }
});

test("route path constants resolve by lexical binding and initialization order", () => {
  withAppSource(
    [
      'const express = require("express");',
      "const app = express();",
      'const routePath = "/outer";',
      "{",
      '  const routePath = "/block";',
      "  app.get(routePath, (_req, res) => res.end());",
      "}",
      "function first() {",
      '  const routePath = "/first";',
      "  app.get(`${routePath}/item`, (_req, res) => res.end());",
      "}",
      "function second() {",
      '  const routePath = "/second";',
      '  app.get(routePath + "/item", (_req, res) => res.end());',
      "}",
      "function forwardReference() {",
      "  app.get(routePath, (_req, res) => res.end());",
      '  const routePath = "/too-late";',
      "}",
      "function parameterShadow(routePath) {",
      "  app.get(routePath, (_req, res) => res.end());",
      "}",
    ],
    (dir) => {
      const routes = audit({ mode: "static", src: dir }, CONFIG).routes;
      const paths = routes.map((route) => route.path);
      assert.ok(paths.includes("/block"));
      assert.ok(paths.includes("/first/item"));
      assert.ok(paths.includes("/second/item"));
      assert.equal(paths.includes("/outer"), false);
      assert.equal(paths.includes("/too-late"), false);
      assert.equal(routes.filter((route) => route.path === "/<dynamic>").length, 2);
      assert.ok(
        routes
          .filter((route) => route.path === "/<dynamic>")
          .every((route) => route.pathConfidence === "partial"),
      );
    },
  );
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

test("only structured wrapper evidence may prove inner auth middleware", () => {
  const legacy = authStatusFor(
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
  assert.equal(legacy.authStatus, "unknown");

  const structured = authStatusFor(
    [
      {
        name: "asyncHandler",
        kind: "call",
        raw: "asyncHandler(requireAuth)",
        inner: ["requireAuth"],
        innerPaths: [{ name: "requireAuth", wrappers: [] }],
      },
    ],
    CONFIG.authMiddleware,
    false,
    CONFIG.authWrappers,
  );
  assert.equal(structured.authStatus, "proven");
});

test("unresolved leading use arguments stay possible while known functions stay pathless", () => {
  for (const leading of ["String('/admin')", "prefix", "settings.prefix"]) {
    withAppSource(
      [
        'const express = require("express");',
        "const app = express();",
        "function requireAuth(_req, _res, next) { next(); }",
        `app.use(${leading}, requireAuth);`,
        'app.get("/public", (_req, res) => res.end());',
      ],
      (dir) => {
        const route = index(audit({ mode: "static", src: dir }, CONFIG).routes)["GET /public"];
        assert.equal(route.authStatus, "unknown");
        const auth = route.middlewares.find((item) => item.name === "requireAuth");
        assert.equal(auth.applicability, "possible");
        assert.deepEqual(auth.applicabilityReasons, ["ambiguous-use-argument"]);
      },
    );
  }

  withAppSource(
    [
      'const express = require("express");',
      "const app = express();",
      "function first(_req, _res, next) { next(); }",
      "function requireAuth(_req, _res, next) { next(); }",
      "app.use(first, requireAuth);",
      'app.get("/public", (_req, res) => res.end());',
    ],
    (dir) => {
      const route = index(audit({ mode: "static", src: dir }, CONFIG).routes)["GET /public"];
      assert.equal(route.authStatus, "proven");
      assert.deepEqual(
        route.middlewares.map((item) => item.name),
        ["first", "requireAuth"],
      );
    },
  );

  withAppSource(
    [
      'const express = require("express");',
      "const app = express();",
      "const router = express.Router();",
      "const prefix = String('/admin');",
      'router.get("/child", (_req, res) => res.end());',
      "app.use(prefix, router);",
    ],
    (dir) => {
      const route = audit({ mode: "static", src: dir }, CONFIG).routes[0];
      assert.equal(route.path, "/<dynamic>/child");
      assert.equal(route.pathConfidence, "partial");
    },
  );
});

test("mixed Express case-sensitivity cannot turn a scoped guard into proof", () => {
  withAppSource(
    [
      'const express = require("express");',
      "const app = express();",
      'app.set("case sensitive routing", true);',
      "const router = express.Router({ caseSensitive: false });",
      "function requireAuth(_req, _res, next) { next(); }",
      'app.use("/admin", requireAuth);',
      'router.get("/admin", (_req, res) => res.end());',
      "app.use(router);",
    ],
    (dir) => {
      const route = index(audit({ mode: "static", src: dir }, CONFIG).routes)["GET /admin"];
      assert.equal(route.authStatus, "unknown");
      assert.deepEqual(route.middlewares[0].applicabilityReasons, ["case-sensitivity"]);
    },
  );

  withAppSource(
    [
      'const express = require("express");',
      "const app = express();",
      'app.set("case sensitive routing", false);',
      "const router = express.Router({ caseSensitive: true });",
      "function requireAuth(_req, _res, next) { next(); }",
      'app.use("/admin", requireAuth);',
      'router.get("/admin", (_req, res) => res.end());',
      "app.use(router);",
    ],
    (dir) => {
      const route = index(audit({ mode: "static", src: dir }, CONFIG).routes)["GET /admin"];
      assert.equal(route.authStatus, "proven");
    },
  );
});

test("skipped control-flow registrations never prove later routes", () => {
  withAppSource(
    [
      'const express = require("express");',
      "const app = express();",
      "function requireAuth(_req, _res, next) { next(); }",
      'false ?? app.use("/nullish", requireAuth);',
      'app.get("/nullish", (_req, res) => res.end());',
      'for (; false; app.use("/update", requireAuth)) {}',
      'app.get("/update", (_req, res) => res.end());',
      "switch (false) {",
      '  case true: app.use("/switch", requireAuth); break;',
      "}",
      'app.get("/switch", (_req, res) => res.end());',
      "try {",
      '  throw new Error("skip");',
      '  app.use("/try", requireAuth);',
      "} catch {}",
      'app.get("/try", (_req, res) => res.end());',
      'null ?? app.use("/active-nullish", requireAuth);',
      'app.get("/active-nullish", (_req, res) => res.end());',
      "switch (true) {",
      "  case true:",
      '    app.use("/same-switch", requireAuth);',
      '    app.get("/same-switch", (_req, res) => res.end());',
      "}",
    ],
    (dir) => {
      const routes = index(audit({ mode: "static", src: dir }, CONFIG).routes);
      assert.equal(routes["GET /nullish"].authStatus, "public");
      assert.equal(routes["GET /update"].authStatus, "public");
      assert.equal(routes["GET /switch"].authStatus, "unknown");
      assert.equal(routes["GET /try"].authStatus, "unknown");
      assert.equal(routes["GET /active-nullish"].authStatus, "proven");
      assert.equal(routes["GET /same-switch"].authStatus, "proven");
    },
  );
});

test("static middleware order follows registration evaluation order", () => {
  withAppSource(
    [
      'const express = require("express");',
      "const app = express();",
      "function first(_req, _res, next) { next(); }",
      "function second(_req, _res, next) { next(); }",
      "function requireAuth(_req, _res, next) { next(); }",
      "function passthrough(value) { return value; }",
      "app.use(first).use(second);",
      'app.get("/ordered", (_req, res) => res.end());',
      'app.get("/side-effect", passthrough((app.use(requireAuth), (_req, res) => res.end())));',
    ],
    (dir) => {
      const report = audit({ mode: "static", src: dir }, CONFIG);
      const routes = index(report.routes);
      assert.deepEqual(
        routes["GET /ordered"].middlewares.map((item) => item.name),
        ["first", "second"],
      );
      assert.equal(routes["GET /side-effect"].authStatus, "proven");
      assert.equal(
        evaluatePolicies(report, [
          { id: "forward", require: { middlewareOrder: ["first", "second"] } },
        ]).policyFindings.length,
        0,
      );
      assert.ok(
        evaluatePolicies(report, [
          { id: "reverse", require: { middlewareOrder: ["second", "first"] } },
        ]).policyFindings.length > 0,
      );
    },
  );
});

test("wildcard-scoped middleware cannot prove authentication outside its literal prefix", () => {
  withAppSource(
    [
      'const express = require("express");',
      "const app = express();",
      "function requireAuth(_req, _res, next) { next(); }",
      'app.use("/admin/*rest", requireAuth);',
      'app.get("/public", (_req, res) => res.end("public"));',
      'app.get("/admin/item", (_req, res) => res.end("admin"));',
    ],
    (dir) => {
      const routes = index(audit({ mode: "static", src: dir }, CONFIG).routes);
      assert.equal(routes["GET /public"].authStatus, "public");
      assert.deepEqual(routes["GET /public"].middlewares, []);
      assert.equal(routes["GET /admin/item"].authStatus, "unknown");
      assert.equal(routes["GET /admin/item"].middlewares[0].applicability, "possible");
      assert.deepEqual(routes["GET /admin/item"].middlewares[0].applicabilityReasons, [
        "path-pattern",
      ]);
    },
  );
});

test("parameterized, case-dependent, and unknown scopes retain explicit uncertainty", () => {
  withAppSource(
    [
      'const express = require("express");',
      "const app = express();",
      "function requireAuth(_req, _res, next) { next(); }",
      'app.use("/teams/:team", requireAuth);',
      'app.get("/teams/acme", (_req, res) => res.end());',
      'app.use("/admin", requireAuth);',
      'app.get("/Admin/item", (_req, res) => res.end());',
    ],
    (dir) => {
      const routes = index(audit({ mode: "static", src: dir }, CONFIG).routes);
      assert.equal(routes["GET /teams/acme"].authStatus, "unknown");
      assert.deepEqual(routes["GET /teams/acme"].middlewares[0].applicabilityReasons, [
        "path-pattern",
      ]);
      assert.equal(routes["GET /Admin/item"].authStatus, "unknown");
      assert.deepEqual(routes["GET /Admin/item"].middlewares[0].applicabilityReasons, [
        "case-sensitivity",
      ]);
    },
  );

  withAppSource(
    [
      'const express = require("express");',
      "const app = express();",
      "function requireAuth(_req, _res, next) { next(); }",
      "app.use(/^\\/admin\\//, requireAuth);",
      'app.get("/public", (_req, res) => res.end());',
    ],
    (dir) => {
      const route = index(audit({ mode: "static", src: dir }, CONFIG).routes)["GET /public"];
      assert.equal(route.authStatus, "unknown");
      assert.deepEqual(route.middlewares[0].applicabilityReasons, ["unknown-mount"]);
    },
  );
});

test("same-line and use-argument ordering cannot move a later guard before a route", () => {
  withAppSource(
    [
      'const express = require("express");',
      "const app = express();",
      "const first = express.Router();",
      "const second = express.Router();",
      "const arrayBefore = express.Router();",
      "const arrayAfter = express.Router();",
      "function requireAuth(_req, _res, next) { next(); }",
      'app.get("/same-line", (_req, res) => res.end()); app.use("/same-line", requireAuth);',
      'first.get("/before", (_req, res) => res.end());',
      'second.get("/after", (_req, res) => res.end());',
      'arrayBefore.get("/before", (_req, res) => res.end());',
      'arrayAfter.get("/after", (_req, res) => res.end());',
      'app.use("/api", first, requireAuth, second);',
      'app.use("/nested", [arrayBefore, [requireAuth, arrayAfter]]);',
      'app.get("/api/later", (_req, res) => res.end());',
    ],
    (dir) => {
      const routes = index(audit({ mode: "static", src: dir }, CONFIG).routes);
      assert.equal(routes["GET /same-line"].authStatus, "public");
      assert.equal(routes["GET /api/before"].authStatus, "public");
      // The scoped guard inside use() executes after the first router and
      // before the second router and subsequent registrations.
      assert.equal(
        routes["GET /api/after"].middlewares.filter((item) => item.name === "requireAuth").length,
        1,
      );
      assert.equal(routes["GET /api/after"].authStatus, "proven");
      assert.equal(routes["GET /api/later"].authStatus, "proven");
      assert.equal(routes["GET /nested/before"].authStatus, "public");
      assert.equal(routes["GET /nested/after"].authStatus, "proven");
    },
  );
});

test("conditional middleware proves auth only when the route implies the same branch", () => {
  withAppSource(
    [
      'const express = require("express");',
      "const app = express();",
      "function requireAuth(_req, _res, next) { next(); }",
      "if (false) app.use(requireAuth);",
      'app.get("/literal-false", (_req, res) => res.end());',
      'if (true) app.use("/literal-true", requireAuth);',
      'app.get("/literal-true", (_req, res) => res.end());',
      'if (process.env.GUARD) app.use("/conditional", requireAuth);',
      'app.get("/conditional", (_req, res) => res.end());',
      "if (process.env.BRANCH) {",
      '  app.use("/same-branch", requireAuth);',
      '  app.get("/same-branch", (_req, res) => res.end());',
      "}",
      'process.env.TERNARY ? app.use("/ternary", requireAuth) : undefined;',
      'app.get("/ternary", (_req, res) => res.end());',
      'false ? app.use("/dead-ternary", requireAuth) : undefined;',
      'app.get("/dead-ternary", (_req, res) => res.end());',
      'process.env.LOGICAL && app.use("/logical", requireAuth);',
      'app.get("/logical", (_req, res) => res.end());',
      'false && app.use("/dead-logical", requireAuth);',
      'app.get("/dead-logical", (_req, res) => res.end());',
      'true && app.use("/true-logical", requireAuth);',
      'app.get("/true-logical", (_req, res) => res.end());',
      "if (process.env.EXCLUSIVE) {",
      '  app.use("/exclusive", requireAuth);',
      "} else {",
      '  app.get("/exclusive", (_req, res) => res.end());',
      "}",
      "while (false) {",
      '  app.use("/dead-loop", requireAuth);',
      "}",
      'app.get("/dead-loop", (_req, res) => res.end());',
      "while (process.env.LOOP) {",
      '  app.use("/loop", requireAuth);',
      "  break;",
      "}",
      'app.get("/loop", (_req, res) => res.end());',
      "function installGuard() {",
      '  app.use("/helper", requireAuth);',
      "}",
      'app.get("/helper", (_req, res) => res.end());',
    ],
    (dir) => {
      const routes = index(audit({ mode: "static", src: dir }, CONFIG).routes);
      assert.equal(routes["GET /literal-false"].authStatus, "public");
      assert.equal(routes["GET /literal-true"].authStatus, "proven");
      assert.equal(routes["GET /conditional"].authStatus, "unknown");
      assert.equal(routes["GET /conditional"].middlewares[0].applicability, "possible");
      assert.deepEqual(routes["GET /conditional"].middlewares[0].applicabilityReasons, [
        "execution-context",
      ]);
      assert.equal(routes["GET /same-branch"].authStatus, "proven");
      assert.equal(routes["GET /ternary"].authStatus, "unknown");
      assert.equal(routes["GET /dead-ternary"].authStatus, "public");
      assert.equal(routes["GET /logical"].authStatus, "unknown");
      assert.equal(routes["GET /dead-logical"].authStatus, "public");
      assert.equal(routes["GET /true-logical"].authStatus, "proven");
      assert.equal(routes["GET /exclusive"].authStatus, "public");
      assert.equal(routes["GET /dead-loop"].authStatus, "public");
      assert.equal(routes["GET /loop"].authStatus, "unknown");
      assert.equal(routes["GET /helper"].authStatus, "unknown");
    },
  );
});

test("cross-file registration order stays uncertain until invocation order is resolved", () => {
  withSourceFiles(
    {
      "app.js": [
        'const express = require("express");',
        "const app = express();",
        "function requireAuth(_req, _res, next) { next(); }",
        "app.use(requireAuth);",
        'require("./routes")(app);',
        "module.exports = app;",
      ].join("\n"),
      "routes.js": [
        "module.exports = function attach(app) {",
        '  app.get("/cross-file", (_req, res) => res.end());',
        "};",
      ].join("\n"),
    },
    (dir) => {
      const route = index(audit({ mode: "static", src: dir }, CONFIG).routes)["GET /cross-file"];
      assert.equal(route.authStatus, "unknown");
      assert.equal(route.middlewares[0].applicability, "possible");
      assert.deepEqual(route.middlewares[0].applicabilityReasons, ["cross-file-order"]);
    },
  );
});

test("every nested wrapper must be transparent before an inner guard proves auth", () => {
  withAppSource(
    [
      'const express = require("express");',
      "const app = express();",
      "function requireAuth(_req, _res, next) { next(); }",
      "function safe(fn) { return fn; }",
      "function maybe(_fn) { return (_req, _res, next) => next(); }",
      'app.get("/direct", safe(requireAuth), (_req, res) => res.end());',
      'app.get("/nested", safe(maybe(requireAuth)), (_req, res) => res.end());',
    ],
    (dir) => {
      const config = {
        authMiddleware: CONFIG.authMiddleware,
        authWrappers: ["safe"],
      };
      const routes = index(audit({ mode: "static", src: dir }, config).routes);
      assert.equal(routes["GET /direct"].authStatus, "proven");
      assert.equal(routes["GET /nested"].authStatus, "unknown");
      assert.deepEqual(routes["GET /nested"].middlewares[0].innerPaths, [
        { name: "maybe", wrappers: [] },
        { name: "requireAuth", wrappers: ["maybe"] },
      ]);
    },
  );
});

const REGISTRAR = path.join(__dirname, "fixtures", "registrar-app");

test("registrar-pattern routes attach at known calls and retain unmounted evidence", () => {
  const { routes, diagnostics } = audit({ mode: "static", src: REGISTRAR }, CONFIG);
  const keyed = index(routes);
  assert.equal(keyed["POST /reg/users"].authStatus, "proven");
  assert.equal(keyed["POST /reg/users"].pathConfidence, "full");
  assert.equal(keyed["GET /reg/health"].authStatus, "public");
  assert.equal(keyed["GET /unmounted"].pathConfidence, "partial");
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

test("hybrid reconcile preserves static route-graph uncertainty", () => {
  const routeGraph = {
    complete: false,
    orphanRoutes: 1,
    registrarRoutes: 1,
    opaqueMounts: [],
  };
  const result = reconcile(
    { routes: [], globalMiddleware: [], routeGraph },
    { routes: [], globalMiddleware: [] },
  );
  assert.deepEqual(result.routeGraph, routeGraph);
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

test("an un-instrumented runtime walk never promotes unknown mount metadata to proof", async () => {
  const express = require("express");
  const app = express();
  function requireAuth(_req, res) {
    res.end("blocked");
  }
  app.use("/admin/*rest", requireAuth);
  app.get("/public", (_req, res) => res.end("public"));
  const route = index(audit({ mode: "runtime", app }, CONFIG).routes)["GET /public"];
  assert.equal(route.authStatus, "unknown");
  assert.deepEqual(route.middlewares[0].applicabilityReasons, ["unknown-mount"]);
  assert.equal(await dispatch(app, "/public"), "public");
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

test("hybrid keeps multiple unsourced runtime routes separate when exact match is ambiguous", () => {
  const item = staticRoute("/health", { pathConfidence: "full" });
  const runtime1 = runtimeRoute("/health");
  const runtime2 = runtimeRoute("/health");
  runtime1.applicationId = "runtime:default";
  runtime2.applicationId = "runtime:default";

  const { routes } = reconcile(
    { routes: [item], globalMiddleware: [] },
    { routes: [runtime1, runtime2], globalMiddleware: [] },
  );
  assert.deepEqual(routes.map((route) => route.presence).sort(), [
    "runtime-only",
    "runtime-only",
    "static-only",
  ]);
});
