"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { discover, inventory, buildReport } = require("../src");
const { loadSpec } = require("../src/docs");

const FIXTURE = path.join(__dirname, "fixtures", "discovery-app");
const CLI = path.join(__dirname, "..", "src", "cli.js");

test("discovery separates multiple Express applications and package scopes", () => {
  const result = discover(FIXTURE);
  assert.deepEqual(
    result.packages.map((item) => item.name),
    ["discovery-root", "discovery-admin"],
  );
  assert.equal(result.applications.length, 2);
  assert.equal(result.discoveryCoverage.complete, true);
  assert.equal(new Set(result.applications.map((item) => item.id)).size, 2);
  for (const application of result.applications) {
    assert.ok(application.packageId);
    assert.equal(application.recommendedEntry, application.entryCandidates[0].path);
    assert.equal(application.entryCandidates[0].confidence, "high");
  }
});

test("same method/path in separate apps remains distinct in the inventory", () => {
  const registry = inventory({ mode: "static", src: FIXTURE });
  const health = registry.routes.filter(
    (route) => route.method === "GET" && route.path === "/health",
  );
  assert.equal(health.length, 2);
  assert.equal(new Set(health.map((route) => route.applicationId)).size, 2);
});

test("discovery finds existing specs and swagger-jsdoc sources", () => {
  const result = discover(FIXTURE);
  assert.deepEqual(result.documentation.specifications, [
    {
      path: "docs/openapi.yaml",
      format: "openapi",
      version: "3.1.0",
      packageId: "package:.",
    },
  ]);
  assert.deepEqual(result.documentation.jsdoc, ["src/documented.js"]);
});

test("statically reconstructs data-only JavaScript OpenAPI modules", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-openapi-module-"));
  try {
    const docs = path.join(root, "openapi");
    fs.mkdirSync(docs);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "module-docs" }));
    fs.writeFileSync(
      path.join(docs, "builder.js"),
      [
        "function operation({ endpoint, method = 'get', summary }) {",
        "  return { [endpoint]: { [method]: { summary, responses: { 200: { description: 'OK' } } } } };",
        "}",
        "module.exports = { operation };",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(docs, "paths.js"),
      [
        "const { operation } = require('./builder');",
        "const endpoints = [{ endpoint: '/health', summary: 'Health' }];",
        "module.exports = endpoints.reduce((all, item) => ({ ...all, ...operation(item) }), {});",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(docs, "index.js"),
      [
        "const paths = require('./paths');",
        "module.exports = { openapi: '3.1.0', info: { title: 'Static module', version: '1' }, paths };",
      ].join("\n"),
    );

    const result = discover(root);
    assert.deepEqual(result.documentation.specifications, [
      {
        path: "openapi/index.js",
        format: "openapi-module",
        version: "3.1.0",
        packageId: "package:.",
      },
    ]);
    const document = loadSpec(path.join(docs, "index.js"), { root });
    assert.equal(document.paths["/health"].get.summary, "Health");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("statically reconstructs data-only ESM OpenAPI modules", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-openapi-esm-"));
  try {
    const docs = path.join(root, "openapi");
    fs.mkdirSync(docs);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "esm-docs" }));
    fs.writeFileSync(
      path.join(docs, "paths.mjs"),
      "export default { '/ready': { get: { responses: { 204: { description: 'Ready' } } } } };",
    );
    fs.writeFileSync(
      path.join(docs, "index.mjs"),
      [
        "import paths from './paths.mjs';",
        "export default { openapi: '3.1.0', info: { title: 'ESM module', version: '1' }, paths };",
      ].join("\n"),
    );

    const result = discover(root);
    assert.equal(result.documentation.specifications[0].format, "openapi-module");
    const document = loadSpec(path.join(docs, "index.mjs"), { root });
    assert.equal(document.paths["/ready"].get.responses[204].description, "Ready");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("executable OpenAPI modules fail closed without running repository code", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-unsafe-openapi-module-"));
  try {
    const docs = path.join(root, "openapi");
    const marker = path.join(root, "executed.txt");
    fs.mkdirSync(docs);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "unsafe-docs" }));
    fs.writeFileSync(
      path.join(docs, "index.js"),
      [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(marker)}, 'executed');`,
        "module.exports = { openapi: '3.1.0', info: { title: 'Unsafe', version: '1' }, paths: {} };",
      ].join("\n"),
    );

    const result = discover(root);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(result.discoveryCoverage.complete, false);
    assert.equal(result.documentation.specifications[0].format, "openapi-module-candidate");
    assert.match(result.diagnostics.join("\n"), /external module "node:fs" is not allowed/);
    assert.throws(() => loadSpec(path.join(docs, "index.js"), { root }), /is not allowed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("static OpenAPI modules cannot amplify a small input into an unbounded value", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-bounded-openapi-module-"));
  try {
    const docs = path.join(root, "openapi");
    fs.mkdirSync(docs);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "bounded-docs" }));
    fs.writeFileSync(
      path.join(docs, "index.js"),
      [
        "let padding = '0123456789abcdef';",
        ...Array.from({ length: 8 }, () => "padding += padding;"),
        "module.exports = { openapi: '3.1.0', info: { title: 'Bounded', version: '1' }, paths: {}, padding };",
      ].join("\n"),
    );

    assert.throws(
      () => loadSpec(path.join(docs, "index.js"), { root, maxTotalBytes: 1024 }),
      /bounded value limit/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("static OpenAPI modules cannot reach or mutate host prototypes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-prototype-openapi-module-"));
  const probe = "__expressReconStaticDocumentProbe";
  try {
    const docs = path.join(root, "openapi");
    fs.mkdirSync(docs);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "prototype-docs" }));
    fs.writeFileSync(
      path.join(docs, "index.js"),
      [
        `[].constructor.prototype.${probe} = true;`,
        "module.exports = { openapi: '3.1.0', info: { title: 'Unsafe', version: '1' }, paths: {} };",
      ].join("\n"),
    );

    assert.equal(Array.prototype[probe], undefined);
    assert.throws(
      () => loadSpec(path.join(docs, "index.js"), { root }),
      /inherited array property/,
    );
    assert.equal(Array.prototype[probe], undefined);
  } finally {
    delete Array.prototype[probe];
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hidden API contracts require an explicit includeHidden opt-in", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-hidden-docs-"));
  try {
    const hidden = path.join(root, ".cursor", "apiContracts");
    fs.mkdirSync(hidden, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "hidden-docs" }));
    fs.writeFileSync(
      path.join(hidden, "openapi.json"),
      JSON.stringify({ openapi: "3.1.0", info: { title: "Hidden", version: "1" }, paths: {} }),
    );

    const defaultResult = discover(root);
    assert.deepEqual(defaultResult.documentation.specifications, []);
    assert.equal(defaultResult.discoveryCoverage.scope.builtIn.hiddenDirectoriesExcluded, true);

    const included = discover(root, { includeHidden: true });
    assert.equal(
      included.documentation.specifications[0].path,
      ".cursor/apiContracts/openapi.json",
    );
    assert.equal(included.discoveryCoverage.scope.builtIn.hiddenDirectoriesExcluded, false);
    const cli = spawnSync("node", [CLI, "discover", "--src", root, "--include-hidden"], {
      encoding: "utf8",
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(
      JSON.parse(cli.stdout).documentation.specifications[0].path,
      ".cursor/apiContracts/openapi.json",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reports normalize application and route source paths relative to the scan root", () => {
  const report = buildReport(inventory({ mode: "static", src: FIXTURE }), {
    command: "inventory",
    mode: "static",
    sourceRoot: FIXTURE,
  });
  for (const application of report.applications) {
    assert.ok(!path.isAbsolute(application.source.file));
  }
  for (const route of report.routes) assert.ok(!path.isAbsolute(route.source.file));
});

test("discover CLI emits a portable JSON artifact", () => {
  const result = spawnSync("node", [CLI, "discover", "--src", FIXTURE], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.applications.length, 2);
  assert.equal(output.discoveryCoverage.complete, true);
  assert.ok(output.applications.every((item) => !path.isAbsolute(item.source.file)));
});

test("discovery excludes test fixture packages and apps unless requested", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-discovery-tests-"));
  try {
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "production", dependencies: { express: "^5" } }),
    );
    fs.writeFileSync(
      path.join(root, "app.js"),
      'const express = require("express"); const app = express(); app.get("/live", handler);',
    );
    const fixture = path.join(root, "test", "fixture");
    fs.mkdirSync(fixture, { recursive: true });
    fs.writeFileSync(
      path.join(fixture, "package.json"),
      JSON.stringify({ name: "fixture", dependencies: { express: "^4" } }),
    );
    fs.writeFileSync(
      path.join(fixture, "app.js"),
      'const express = require("express"); const app = express(); app.get("/test", handler);',
    );

    assert.deepEqual(
      discover(root).packages.map((item) => item.name),
      ["production"],
    );
    assert.deepEqual(
      discover(root, { includeTests: true }).packages.map((item) => item.name),
      ["production", "fixture"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("discovery applies .express-reconignore to packages, apps, specs, and JSDoc", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-discovery-scope-"));
  try {
    fs.writeFileSync(path.join(root, ".express-reconignore"), "ignored/**\n");
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "visible", dependencies: { express: "^5" } }),
    );
    fs.writeFileSync(
      path.join(root, "app.js"),
      'const express = require("express"); const app = express(); app.get("/visible", handler);',
    );
    const ignored = path.join(root, "ignored");
    fs.mkdirSync(ignored);
    fs.writeFileSync(
      path.join(ignored, "package.json"),
      JSON.stringify({ name: "ignored", dependencies: { express: "^5" } }),
    );
    fs.writeFileSync(
      path.join(ignored, "app.js"),
      '/** @openapi /ignored: {} */\nconst express = require("express"); const app = express(); app.get("/ignored", handler);',
    );
    fs.writeFileSync(path.join(ignored, "openapi.yaml"), "openapi: 3.1.0\npaths: {}\n");

    const result = discover(root);
    assert.deepEqual(
      result.packages.map((item) => item.name),
      ["visible"],
    );
    assert.deepEqual(
      result.applications.map((item) => item.name),
      ["app.js#app"],
    );
    assert.deepEqual(result.documentation, { specifications: [], jsdoc: [] });
    assert.equal(result.discoveryCoverage.scope.fingerprint, result.scanCoverage.scope.fingerprint);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
