"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { audit } = require("../src/index");
const { createScopedResolver, loadTsconfig } = require("../src/static/resolve");

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

test("package imports select require and import conditions without flattening branches", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-conditions-"));
  try {
    fs.mkdirSync(path.join(root, "routes"));
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "conditional-imports",
        imports: {
          "#router": {
            import: "./routes/import.mjs",
            require: "./routes/require.cjs",
            default: "./routes/default.js",
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(root, "routes", "require.cjs"),
      'const r = require("express").Router(); r.get("/require", (_q, s) => s.end()); module.exports = r;',
    );
    fs.writeFileSync(
      path.join(root, "routes", "import.mjs"),
      'import express from "express"; const r = express.Router(); r.get("/import", (_q, s) => s.end()); export default r;',
    );
    fs.writeFileSync(
      path.join(root, "routes", "default.js"),
      'const r = require("express").Router(); r.get("/wrong", (_q, s) => s.end()); module.exports = r;',
    );
    fs.writeFileSync(
      path.join(root, "require-app.cjs"),
      'const app = require("express")(); app.use("/cjs", require("#router")); module.exports = app;',
    );
    fs.writeFileSync(
      path.join(root, "import-app.mjs"),
      'import express from "express"; import router from "#router"; const app = express(); app.use("/esm", router); export default app;',
    );
    const routes = index(audit({ mode: "static", src: root }, CONFIG).routes);
    assert.ok(routes["GET /cjs/require"]);
    assert.ok(routes["GET /esm/import"]);
    assert.equal(routes["GET /cjs/import"], undefined);
    assert.equal(routes["GET /esm/require"], undefined);
    assert.equal(routes["GET /cjs/wrong"], undefined);
    assert.equal(routes["GET /esm/wrong"], undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("nested package conditions fall through when an active branch has no match", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-nested-conditions-"));
  try {
    const app = path.join(root, "app.cjs");
    const target = path.join(root, "correct.cjs");
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        imports: {
          "#entry": {
            node: { browser: "./browser.cjs" },
            require: "./correct.cjs",
            default: "./fallback.cjs",
          },
        },
      }),
    );
    fs.writeFileSync(app, 'module.exports = require("#entry");');
    fs.writeFileSync(target, "module.exports = {};\n");
    fs.writeFileSync(path.join(root, "browser.cjs"), "module.exports = {};\n");
    fs.writeFileSync(path.join(root, "fallback.cjs"), "module.exports = {};\n");

    const resolve = createScopedResolver(root, [app, target]);
    assert.equal(resolve(app, "#entry", "require"), target);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace exports honor conditions, exact blocked subpaths, and source targets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-workspace-exports-"));
  try {
    const app = path.join(root, "apps", "api", "app.cjs");
    const packageDir = path.join(root, "packages", "router");
    fs.mkdirSync(path.dirname(app), { recursive: true });
    fs.mkdirSync(path.join(packageDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "workspace" }));
    fs.writeFileSync(app, "module.exports = require('@scope/router');");
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "@scope/router",
        exports: {
          ".": {
            import: "./src/import.mjs",
            require: "./src/require.cjs",
          },
          "./blocked": null,
          "./mapped": "./dist/mapped.js",
          "./*": "./src/*.js",
        },
      }),
    );
    const importTarget = path.join(packageDir, "src", "import.mjs");
    const requireTarget = path.join(packageDir, "src", "require.cjs");
    const blockedTarget = path.join(packageDir, "src", "blocked.js");
    const mappedTarget = path.join(packageDir, "src", "mapped.ts");
    for (const file of [importTarget, requireTarget, blockedTarget, mappedTarget])
      fs.writeFileSync(file, "");
    const files = [app, importTarget, requireTarget, blockedTarget, mappedTarget];
    const resolve = createScopedResolver(root, files);
    assert.equal(resolve(app, "@scope/router", "require"), requireTarget);
    assert.equal(resolve(app, "@scope/router", "import"), importTarget);
    assert.equal(resolve(app, "@scope/router/blocked", "require"), null);
    assert.equal(resolve(app, "@scope/router/mapped", "require"), mappedTarget);
    assert.equal(resolve(app, "./missing", "require"), null);
    assert.ok(
      resolve.traces.some(
        (trace) => trace.specifier === "@scope/router/mapped" && trace.heuristic === true,
      ),
    );
    assert.ok(
      resolve.traces.some(
        (trace) => trace.specifier === "./missing" && trace.reason === "relative-target-not-found",
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tsconfig aliases follow bounded JSONC extends chains and expose cycles", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-tsconfig-extends-"));
  try {
    const appDir = path.join(root, "apps", "api");
    const app = path.join(appDir, "app.ts");
    const target = path.join(root, "src", "routes", "users.ts");
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(
      path.join(root, "tsconfig.base.json"),
      `{
        // Comment markers in strings are data, not JSONC comments.
        "documentation": "https://example.test/config",
        "extends": "./tsconfig.cycle.json",
        "compilerOptions": {
          "baseUrl": ".",
          "paths": { "@routes/*": ["src/routes/*",], },
        },
      }`,
    );
    fs.writeFileSync(
      path.join(root, "tsconfig.cycle.json"),
      JSON.stringify({ extends: "./tsconfig.base.json" }),
    );
    fs.writeFileSync(
      path.join(appDir, "tsconfig.json"),
      JSON.stringify({ extends: "../../tsconfig.base.json" }),
    );
    fs.writeFileSync(app, 'import users from "@routes/users"; export default users;');
    fs.writeFileSync(target, "export default {};\n");

    const config = loadTsconfig(appDir, root);
    assert.ok(
      config.trace.some((entry) => entry.reason === "tsconfig-extends-cycle"),
      JSON.stringify(config.trace),
    );
    const resolve = createScopedResolver(root, [app, target]);
    assert.equal(resolve(app, "@routes/users", "import"), target);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
