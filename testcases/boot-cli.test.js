"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "src", "cli.js");
const DIR = path.join(__dirname, "fixtures", "boot-app");
const APP = path.join(DIR, "app.js");
const CONFIG = path.join(DIR, "boot.config.js");

function run(args, expectCode = 0) {
  const res = spawnSync("node", [CLI, ...args], { encoding: "utf8", timeout: 30000 });
  assert.equal(res.status, expectCode, `exit ${res.status}: ${res.stderr}`);
  return res;
}

test("runtime mode boots an app whose infra deps are not installed", () => {
  const res = run([
    "inventory",
    "--mode",
    "runtime",
    "--app",
    APP,
    "--config",
    CONFIG,
    "--format",
    "json",
  ]);
  const report = JSON.parse(res.stdout);
  const keys = report.routes.map((r) => `${r.method} ${r.path}`);
  assert.ok(keys.includes("GET /health"));
  assert.ok(keys.includes("GET /api/widgets"));
  assert.ok(keys.includes("POST /api/widgets"));
  assert.ok(report.diagnostics.some((d) => d.includes("stubbed infra modules")));
  assert.ok(report.diagnostics.some((d) => d.includes("no port was bound")));
});

test("hybrid mode reconciles static and sandboxed runtime", () => {
  const res = run([
    "audit",
    "--mode",
    "hybrid",
    "--src",
    DIR,
    "--app",
    APP,
    "--config",
    CONFIG,
    "--format",
    "json",
  ]);
  const report = JSON.parse(res.stdout);
  const health = report.routes.find((r) => r.method === "GET" && r.path === "/health");
  assert.equal(health.presence, "both");
  assert.ok(report.diagnostics.some((d) => d.startsWith("boot:")));
  assert.ok(res.stderr.includes("express-recon [warn]: boot:"));
});

test("routes registered inside connect().then are captured", () => {
  const res = run([
    "inventory",
    "--mode",
    "runtime",
    "--app",
    path.join(DIR, "then-app.js"),
    "--format",
    "json",
  ]);
  const report = JSON.parse(res.stdout);
  assert.ok(report.routes.some((r) => r.path === "/deferred"));
});

test("a boot crash after wiring still yields harvested routes", () => {
  const res = run([
    "inventory",
    "--mode",
    "runtime",
    "--app",
    path.join(DIR, "crash-app.js"),
    "--format",
    "json",
  ]);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(report.routes.map((r) => `${r.method} ${r.path}`).sort(), ["GET /a", "POST /b"]);
  assert.ok(report.diagnostics.some((d) => d.includes("db exploded") && d.includes("partial")));
});

test("a boot crash before any wiring dies with the boot error", () => {
  const res = run(
    ["inventory", "--mode", "runtime", "--app", path.join(DIR, "dead-app.js"), "--format", "json"],
    1,
  );
  assert.ok(res.stderr.includes("exploded before express"));
});

test("boot.sandbox:false disables stubbing", () => {
  const res = run(
    [
      "inventory",
      "--mode",
      "runtime",
      "--app",
      APP,
      "--config",
      path.join(DIR, "no-sandbox.config.js"),
      "--format",
      "json",
    ],
    1,
  );
  assert.ok(res.stderr.includes("Cannot find module 'pg'"));
});

test("static mode over the fixture dir needs no sandbox or env", () => {
  const res = run(["inventory", "--src", DIR, "--format", "json"]);
  const report = JSON.parse(res.stdout);
  assert.ok(report.routes.some((r) => r.path === "/health"));
});
