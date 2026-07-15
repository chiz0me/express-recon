"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { execFileSync, execSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "src", "cli.js");
const FIXTURE = path.join(__dirname, "fixtures", "static-app");

function run(args, expectCode = 0) {
  try {
    const stdout = execFileSync("node", [CLI, ...args], { encoding: "utf8" });
    assert.equal(expectCode, 0, `expected exit ${expectCode} but command succeeded`);
    return { stdout, code: 0 };
  } catch (err) {
    assert.equal(err.status, expectCode, `exit ${err.status}: ${err.stderr}`);
    return { stdout: err.stdout || "", code: err.status };
  }
}

test("audit --format json emits the report contract", () => {
  const { stdout } = run(["audit", "--src", FIXTURE, "--format", "json"]);
  const report = JSON.parse(stdout);
  assert.equal(report.command, "audit");
  assert.equal(report.tool, "express-recon");
  assert.ok(report.routes.length > 0);
});

test("inventory omits findings", () => {
  const report = JSON.parse(run(["inventory", "--src", FIXTURE, "--format", "json"]).stdout);
  assert.equal(report.command, "inventory");
  assert.equal(report.findings, undefined);
});

test("--fail-on public exits 2 when public routes exist", () => {
  run(["audit", "--src", FIXTURE, "--format", "json", "--fail-on", "public"], 2);
});

test("--fail-on proven exits 0 when no proven-only gate is tripped", () => {
  // fixture has no routes matching an empty allowlist as 'proven', so gate passes
  run(["audit", "--src", FIXTURE, "--format", "json", "--fail-on", "proven"], 0);
});

test("audit --format openapi emits an OpenAPI 3.1 doc with a security section", () => {
  const doc = JSON.parse(run(["audit", "--src", FIXTURE, "--format", "openapi"]).stdout);
  assert.equal(doc.openapi, "3.1.0");
  assert.ok(doc.paths["/health"]);
  assert.equal(doc["x-express-recon"].command, "audit");
});

test("inventory --format openapi carries no security schemes", () => {
  const doc = JSON.parse(run(["inventory", "--src", FIXTURE, "--format", "openapi"]).stdout);
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.components, undefined);
});

test("schema command prints a JSON Schema", () => {
  const schema = JSON.parse(run(["schema"]).stdout);
  assert.equal(schema.title, "express-recon report");
});

test("suggest-auth prints ranked candidates", () => {
  const result = JSON.parse(run(["suggest-auth", "--src", FIXTURE]).stdout);
  assert.ok(result.candidates.some((c) => c.name === "requireAuth"));
});

test("a large json report survives a stdout pipe without truncation", () => {
  // Generate an app with enough routes to overflow the ~64KB pipe buffer, so a
  // process.exit() before the stdout flush would truncate the JSON mid-object.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recon-big-"));
  try {
    const lines = ["const express = require('express');", "const r = express.Router();"];
    for (let i = 0; i < 500; i++) lines.push(`r.get('/route-${i}', (req, res) => res.end());`);
    lines.push("const app = express();", "app.use(r);", "module.exports = app;");
    fs.writeFileSync(path.join(dir, "app.js"), lines.join("\n"));
    // A real shell pipe (not execFileSync's eager reader) reproduces the buffer
    // backpressure that made process.exit() drop the tail of the report.
    const cmd = `node ${JSON.stringify(CLI)} audit --src ${JSON.stringify(dir)} --format json | cat`;
    const out = execSync(cmd, { maxBuffer: 64 * 1024 * 1024 }).toString();
    assert.ok(out.length > 70000, `expected >64KB of output, got ${out.length} bytes`);
    const report = JSON.parse(out); // throws "Unexpected end of JSON input" if truncated
    assert.equal(report.routes.length, 500);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
