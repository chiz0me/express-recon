"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAnalysisSession } = require("../src/analysis-session");

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-session-"));
  const app = path.join(root, "app.js");
  fs.writeFileSync(
    app,
    'const app = require("express")(); app.get("/health", (_q, s) => s.end()); module.exports = app;',
  );
  try {
    return run(root, app);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("one analysis session derives discovery and audit from one parsed model set", () =>
  fixture((root) => {
    const session = createAnalysisSession(root);
    const discovery = session.discover();
    const inventory = session.inventory();
    const audit = session.audit({});
    assert.equal(session.metrics.parsedFiles, 1);
    assert.equal(session.metrics.sourceReads, 1);
    assert.equal(session.parsedModels.length, 1);
    assert.equal(discovery.applications.length, 1);
    assert.equal(inventory.routes.length, 1);
    assert.equal(audit.routes.length, 1);
    assert.match(session.snapshotId, /^analysis_[a-f0-9]{24}$/);
  }));

test("analysis sessions reject changed or newly added source before deriving evidence", () =>
  fixture((root, app) => {
    const changed = createAnalysisSession(root);
    fs.appendFileSync(app, "\n// changed");
    assert.throws(
      () => changed.inventory(),
      (error) => error.code === "SOURCE_CHANGED",
    );

    const fresh = createAnalysisSession(root);
    fs.writeFileSync(path.join(root, "new-route.js"), "module.exports = 1;");
    assert.throws(
      () => fresh.discover(),
      (error) => error.code === "SOURCE_CHANGED",
    );
  }));

test("analysis sessions use the scanner's UTF-8 source identity", () =>
  fixture((root, app) => {
    fs.writeFileSync(
      app,
      Buffer.concat([
        Buffer.from("// non-UTF-8 byte: "),
        Buffer.from([0xff]),
        Buffer.from(
          '\nconst app = require("express")(); app.get("/decoded", (_q, s) => s.end()); module.exports = app;',
        ),
      ]),
    );

    const session = createAnalysisSession(root);
    assert.equal(session.inventory().routes[0].path, "/decoded");
  }));

test("analysis session identity includes package resolution metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-session-metadata-"));
  try {
    fs.writeFileSync(
      path.join(root, "app.cjs"),
      'const app = require("express")(); app.use("/api", require("#router")); module.exports = app;',
    );
    fs.writeFileSync(
      path.join(root, "a.cjs"),
      'const router = require("express").Router(); router.get("/a", handler); module.exports = router;',
    );
    fs.writeFileSync(
      path.join(root, "b.cjs"),
      'const router = require("express").Router(); router.get("/b", handler); module.exports = router;',
    );
    const manifest = path.join(root, "package.json");
    fs.writeFileSync(manifest, JSON.stringify({ imports: { "#router": "./a.cjs" } }));

    const before = createAnalysisSession(root);
    assert.ok(before.inventory().routes.some((route) => route.path === "/api/a"));
    fs.writeFileSync(manifest, JSON.stringify({ imports: { "#router": "./b.cjs" } }));

    assert.throws(
      () => before.inventory(),
      (error) => error.code === "SOURCE_CHANGED" && /resolution metadata/.test(error.message),
    );
    const after = createAnalysisSession(root);
    assert.notEqual(after.snapshotId, before.snapshotId);
    assert.ok(after.inventory().routes.some((route) => route.path === "/api/b"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
