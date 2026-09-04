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

test("reconstructs paths across nested member expression mounts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-nested-"));
  try {
    fs.writeFileSync(
      path.join(dir, "routes.js"),
      [
        '"use strict";',
        'const express = require("express");',
        "const router = express.Router();",
        'router.get("/users", (_req, res) => res.send("users"));',
        "module.exports = { v1: { sub: router } };",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "app.js"),
      [
        '"use strict";',
        'const express = require("express");',
        'const api = require("./routes");',
        "const app = express();",
        'app.use("/api", api.v1.sub);',
        "module.exports = app;",
      ].join("\n"),
    );
    const { routes } = scanRepo(dir, CONFIG);
    const keys = Object.keys(index(routes)).sort();
    assert.deepEqual(keys, ["GET /api/users"]);
    assert.equal(routes[0].pathConfidence, "full");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolves routes registered via variable-bound app.route()", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-bound-route-"));
  try {
    fs.writeFileSync(
      path.join(dir, "app.js"),
      [
        '"use strict";',
        'const express = require("express");',
        "const app = express();",
        "function auth() {}",
        'const item = app.route("/items").all(auth);',
        'item.get((_req, res) => res.send("get"));',
        'item.post((_req, res) => res.send("post"));',
        "module.exports = app;",
      ].join("\n"),
    );
    const { routes } = audit(
      { mode: "static", src: dir },
      { authMiddleware: { auth: "authenticated" } },
    );
    const keys = Object.keys(index(routes)).sort();
    assert.deepEqual(keys, ["GET /items", "POST /items"]);
    assert.equal(routes[0].pathConfidence, "full");
    assert.equal(routes[0].authStatus, "proven");
    assert.equal(routes[1].authStatus, "proven");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolves middleware names using computed string properties", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-computed-prop-"));
  try {
    fs.writeFileSync(
      path.join(dir, "app.js"),
      [
        '"use strict";',
        'const express = require("express");',
        "const app = express();",
        "const auth = { requireAuth: () => {} };",
        'app.get("/guarded", auth["requireAuth"], (_req, res) => res.send("ok"));',
        "module.exports = app;",
      ].join("\n"),
    );
    const { routes } = audit(
      { mode: "static", src: dir },
      { authMiddleware: { "auth.requireAuth": "authenticated" } },
    );
    assert.equal(routes[0].authStatus, "proven");
    assert.equal(routes[0].middlewares[0].name, "auth.requireAuth");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("app.route() aliases respect lexical scope across functions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-scope-route-"));
  try {
    fs.writeFileSync(
      path.join(dir, "app.js"),
      [
        '"use strict";',
        'const express = require("express");',
        "const app = express();",
        "function setupFirst(app) {",
        '  const item = app.route("/first");',
        '  item.get((_req, res) => res.send("first"));',
        "}",
        "function setupSecond(app) {",
        '  const item = app.route("/second");',
        '  item.get((_req, res) => res.send("second"));',
        "}",
        "setupFirst(app);",
        "setupSecond(app);",
        "module.exports = app;",
      ].join("\n"),
    );
    const { routes } = audit({ mode: "static", src: dir });
    const keys = Object.keys(index(routes)).sort();
    assert.deepEqual(keys, ["GET /first", "GET /second"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("outer app.route() alias does not shadow inner router redeclaration", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-shadow-router-"));
  try {
    fs.writeFileSync(
      path.join(dir, "app.js"),
      [
        '"use strict";',
        'const express = require("express");',
        "const app = express();",
        'const item = app.route("/outer");',
        'item.get((_req, res) => res.send("outer"));',
        "function setupSubroutes(app) {",
        "  const item = express.Router();",
        '  item.get("/inner", (_req, res) => res.send("inner"));',
        '  app.use("/mounted", item);',
        "}",
        "setupSubroutes(app);",
        "module.exports = app;",
      ].join("\n"),
    );
    const { routes } = audit({ mode: "static", src: dir });
    const keys = Object.keys(index(routes)).sort();
    assert.deepEqual(keys, ["GET /mounted/inner", "GET /outer"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mutable app.route() aliases follow assignments and var redeclarations", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-mutable-route-"));
  try {
    fs.writeFileSync(
      path.join(dir, "app.js"),
      [
        '"use strict";',
        'const express = require("express");',
        "const app = express();",
        'let mutable = app.route("/first");',
        'mutable.get((_req, res) => res.send("first"));',
        'mutable = app.route("/second");',
        'mutable.post((_req, res) => res.send("second"));',
        'var repeated = app.route("/third");',
        'repeated.get((_req, res) => res.send("third"));',
        'var repeated = app.route("/fourth");',
        'repeated.patch((_req, res) => res.send("fourth"));',
        'let throughBlock = app.route("/fifth");',
        "{",
        '  throughBlock = app.route("/sixth");',
        "}",
        'throughBlock.delete((_req, res) => res.send("sixth"));',
        'let unresolved = app.route("/seventh");',
        "unresolved = chooseRouteAtRuntime();",
        'unresolved.get((_req, res) => res.send("unknown"));',
        "module.exports = app;",
      ].join("\n"),
    );
    const { routes, routeGraph } = audit({ mode: "static", src: dir });
    assert.deepEqual(Object.keys(index(routes)).sort(), [
      "DELETE /sixth",
      "GET /<dynamic>",
      "GET /first",
      "GET /third",
      "PATCH /fourth",
      "POST /second",
    ]);
    assert.equal(index(routes)["GET /<dynamic>"].pathConfidence, "partial");
    assert.equal(routeGraph.complete, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
