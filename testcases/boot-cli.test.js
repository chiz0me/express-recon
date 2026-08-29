"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CLI = path.join(__dirname, "..", "src", "cli.js");
const DIR = path.join(__dirname, "fixtures", "boot-app");
const APP = path.join(DIR, "app.js");
const CONFIG = path.join(DIR, "boot.config.js");
const MULTI_APP = path.join(__dirname, "fixtures", "discovery-app");

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
  assert.ok(report.diagnostics.some((d) => d.includes("isolated worker process")));
});

test("runtime mode rejects the static coverage completeness gate", () => {
  const res = run(
    ["audit", "--mode", "runtime", "--app", APP, "--format", "json", "--fail-on", "incomplete"],
    1,
  );
  assert.match(res.stderr, /requires static or hybrid mode/);
});

test("runtime worker isolates the parent environment unless inheritance is requested", () => {
  const app = path.join(DIR, "env-app.js");
  const env = { ...process.env, EXPRESS_RECON_PARENT_SECRET: "sensitive" };
  const isolated = spawnSync(
    "node",
    [CLI, "inventory", "--mode", "runtime", "--app", app, "--format", "json"],
    { encoding: "utf8", timeout: 30000, env },
  );
  assert.equal(isolated.status, 0, isolated.stderr);
  assert.ok(
    JSON.parse(isolated.stdout).routes.some((route) => route.path === "/parent-env-isolated"),
  );

  const inherited = spawnSync(
    "node",
    [
      CLI,
      "inventory",
      "--mode",
      "runtime",
      "--app",
      app,
      "--config",
      path.join(DIR, "inherit-env.config.js"),
      "--format",
      "json",
    ],
    { encoding: "utf8", timeout: 30000, env },
  );
  assert.equal(inherited.status, 0, inherited.stderr);
  assert.ok(
    JSON.parse(inherited.stdout).routes.some((route) => route.path === "/parent-env-inherited"),
  );
});

test("hybrid mode reconciles static and worker runtime", () => {
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

test("hybrid app selection preserves identity in a multi-app repository", () => {
  const applicationId = "app:src/public-app.js#app";
  const res = run([
    "inventory",
    "--mode",
    "hybrid",
    "--src",
    MULTI_APP,
    "--app",
    path.join(MULTI_APP, "src", "public-app.js"),
    "--app-id",
    applicationId,
    "--format",
    "json",
  ]);
  const report = JSON.parse(res.stdout);
  const health = report.routes.filter((route) => route.path === "/health");
  assert.equal(health.length, 2);
  assert.equal(health.find((route) => route.applicationId === applicationId).presence, "both");
  assert.equal(
    health.find((route) => route.applicationId === "app:services/admin/app.js#admin").presence,
    "static-only",
  );
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

test("routes registered inside Node-style infra callbacks are captured", () => {
  const res = run([
    "inventory",
    "--mode",
    "runtime",
    "--app",
    path.join(DIR, "callback-app.js"),
    "--format",
    "json",
  ]);
  const report = JSON.parse(res.stdout);
  assert.ok(report.routes.some((route) => route.path === "/callback-deferred"));
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.includes("callback-style infra")));
});

test("ESM-only applications load through dynamic import", () => {
  const res = run([
    "inventory",
    "--mode",
    "runtime",
    "--app",
    path.join(DIR, "esm-app.mjs"),
    "--format",
    "json",
  ]);
  const report = JSON.parse(res.stdout);
  assert.ok(report.routes.some((route) => route.path === "/esm/route"));
});

test("short timer-deferred route registration settles before the worker returns", () => {
  const res = run([
    "inventory",
    "--mode",
    "runtime",
    "--app",
    path.join(DIR, "deferred-app.js"),
    "--format",
    "json",
  ]);
  const report = JSON.parse(res.stdout);
  assert.ok(report.routes.some((route) => route.path === "/timer-deferred"));
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

test("worker completion is not blocked by target timers", () => {
  const started = Date.now();
  const res = run([
    "inventory",
    "--mode",
    "runtime",
    "--app",
    path.join(DIR, "timer-app.js"),
    "--format",
    "json",
  ]);
  const report = JSON.parse(res.stdout);
  assert.ok(report.routes.some((r) => r.path === "/timer"));
  assert.ok(Date.now() - started < 5000);
});

test("boot.timeoutMs terminates a blocked target", () => {
  const res = run(
    [
      "inventory",
      "--mode",
      "runtime",
      "--app",
      path.join(DIR, "hang-app.js"),
      "--config",
      path.join(DIR, "timeout.config.js"),
      "--format",
      "json",
    ],
    1,
  );
  assert.match(res.stderr, /timed out after 150ms/);
});

test("boot.maxOutputBytes bounds the serialized runtime registry", () => {
  const res = run(
    [
      "inventory",
      "--mode",
      "runtime",
      "--app",
      path.join(DIR, "large-app.js"),
      "--config",
      path.join(DIR, "small-output.config.js"),
      "--format",
      "json",
    ],
    1,
  );
  assert.match(res.stderr, /exceeded boot\.maxOutputBytes/);
});
