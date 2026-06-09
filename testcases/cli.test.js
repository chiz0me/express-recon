"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

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

test("schema command prints a JSON Schema", () => {
  const schema = JSON.parse(run(["schema"]).stdout);
  assert.equal(schema.title, "express-recon report");
});

test("suggest-auth prints ranked candidates", () => {
  const result = JSON.parse(run(["suggest-auth", "--src", FIXTURE]).stdout);
  assert.ok(result.candidates.some((c) => c.name === "requireAuth"));
});
