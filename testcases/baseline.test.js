"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { audit, buildReport } = require("../src/index");

const FIXTURE = path.join(__dirname, "fixtures", "static-app");
const MULTI_APP_FIXTURE = path.join(__dirname, "fixtures", "discovery-app");
const CLI = path.join(__dirname, "..", "src", "cli.js");

const AUTH = { requireAuth: "authenticated", "passport.authenticate": "session" };

function reportFor(acceptedPublic) {
  const reg = audit({ mode: "static", src: FIXTURE }, { authMiddleware: AUTH, acceptedPublic });
  return buildReport(reg, { command: "audit", mode: "static" });
}

test("an accepted-public route is tagged and drops its public-route finding", () => {
  const report = reportFor(["GET /health"]);
  const health = report.routes.find((r) => r.method === "GET" && r.path === "/health");
  assert.equal(health.authStatus, "public");
  assert.equal(health.accepted, true);
  assert.ok(!report.findings.some((f) => f.id === "public-route" && f.path === "/health"));
});

test("accepted routes are counted in the summary and still counted public", () => {
  const report = reportFor(["GET /health"]);
  assert.equal(report.summary.accepted, 1);
  assert.ok(report.summary.public >= 1);
});

test("a non-accepted public route still produces a finding", () => {
  const report = reportFor(["GET /health"]);
  assert.ok(
    report.findings.some((f) => f.id === "public-route" && f.path === "/admin/users/:id"),
    "the un-accepted public route should still be flagged",
  );
});

test("a baseline entry that matches no public route is flagged stale", () => {
  const report = reportFor(["GET /health", "GET /me", "DELETE /gone"]);
  const stale = report.findings.filter((f) => f.id === "stale-baseline");
  const details = stale.map((f) => f.detail).join("\n");
  // /me is proven (not public) and /gone doesn't exist — both are stale.
  assert.match(details, /GET \/me/);
  assert.match(details, /DELETE \/gone/);
  // /health is a live public route, so it is not stale.
  assert.ok(!details.includes("GET /health"));
});

test("no acceptedPublic means no accepted tags and no stale findings", () => {
  const report = reportFor(undefined);
  assert.equal(report.summary.accepted, 0);
  assert.ok(!report.routes.some((r) => r.accepted));
  assert.ok(!report.findings.some((f) => f.id === "stale-baseline"));
});

test("structured public baselines target one application without suppressing its peer", () => {
  const applicationId = "app:src/public-app.js#app";
  const report = buildReport(
    audit(
      { mode: "static", src: MULTI_APP_FIXTURE },
      {
        acceptedPublic: [{ applicationId, method: "GET", path: "/health" }],
      },
    ),
    { command: "audit", mode: "static" },
  );
  const health = report.routes.filter((route) => route.path === "/health");
  assert.equal(health.length, 2);
  assert.equal(health.find((route) => route.applicationId === applicationId).accepted, true);
  const remaining = report.findings.filter(
    (finding) => finding.id === "public-route" && finding.path === "/health",
  );
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].applicationId, "app:services/admin/app.js#admin");
});

test("legacy public baseline strings intentionally apply across applications", () => {
  const report = buildReport(
    audit({ mode: "static", src: MULTI_APP_FIXTURE }, { acceptedPublic: ["GET /health"] }),
    { command: "audit", mode: "static" },
  );
  const health = report.routes.filter((route) => route.path === "/health");
  assert.equal(health.length, 2);
  assert.ok(health.every((route) => route.accepted));
  assert.ok(
    !report.findings.some((finding) => finding.id === "public-route" && finding.path === "/health"),
  );
});

test("finding fingerprints distinguish the same route in separate applications", () => {
  const report = buildReport(audit({ mode: "static", src: MULTI_APP_FIXTURE }, {}), {
    command: "audit",
    mode: "static",
  });
  const health = report.findings.filter(
    (finding) => finding.id === "public-route" && finding.path === "/health",
  );
  assert.equal(health.length, 2);
  assert.equal(new Set(health.map((finding) => finding.fingerprint)).size, 2);
});

test("--fail-on public passes once every public route is accepted", () => {
  const configPath = path.join(__dirname, "fixtures", "baseline.config.js");
  // Partial baseline leaves public routes → exit 2; full baseline → exit 0.
  assert.throws(
    () =>
      execFileSync(
        "node",
        [CLI, "audit", "--src", FIXTURE, "--config", configPath, "--fail-on", "public"],
        {
          stdio: "pipe",
        },
      ),
    /Command failed/,
  );
  const configAllPath = path.join(__dirname, "fixtures", "baseline-all.config.js");
  const out = execFileSync(
    "node",
    [
      CLI,
      "audit",
      "--src",
      FIXTURE,
      "--config",
      configAllPath,
      "--fail-on",
      "public",
      "--format",
      "json",
    ],
    { stdio: "pipe" },
  );
  assert.ok(out.toString().includes('"accepted": 5'));
});
