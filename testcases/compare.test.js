"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { compareReports, buildReport, audit } = require("../src/index");

const FIXTURE = path.join(__dirname, "fixtures", "static-app");
const CLI = path.join(__dirname, "..", "src", "cli.js");

function report(routes, findings = []) {
  return { schemaVersion: "1.3", tool: "express-recon", routes, findings };
}

function route(method, routePath, authStatus, line = 1) {
  return {
    method,
    path: routePath,
    authStatus,
    source: { file: "/repo/routes.js", line },
    middlewares: [],
    pathConfidence: "full",
  };
}

test("compareReports detects route changes and auth regressions", () => {
  const baseline = report([route("GET", "/secure", "proven"), route("GET", "/removed", "public")]);
  const current = report([
    route("GET", "/secure", "public", 99),
    route("POST", "/added", "unknown"),
  ]);
  const delta = compareReports(baseline, current);
  assert.equal(delta.summary.addedRoutes, 1);
  assert.equal(delta.summary.removedRoutes, 1);
  assert.equal(delta.summary.authRegressions, 1);
  assert.equal(delta.authRegressions[0].method, "GET");
  assert.equal(delta.authRegressions[0].path, "/secure");
  assert.equal(delta.authRegressions[0].from, "proven");
  assert.equal(delta.authRegressions[0].to, "public");
  assert.match(delta.authRegressions[0].explanation, /configuration|middleware/i);
});

test("schema 2 comparisons keep identical routes in separate applications independent", () => {
  const adminBefore = route("GET", "/health", "proven");
  adminBefore.applicationId = "app:admin#app";
  const publicBefore = route("GET", "/health", "public");
  publicBefore.applicationId = "app:public#app";
  const adminAfter = route("GET", "/health", "public");
  adminAfter.applicationId = "app:admin#app";
  const publicAfter = route("GET", "/health", "public");
  publicAfter.applicationId = "app:public#app";

  const baseline = { ...report([adminBefore, publicBefore]), schemaVersion: "2.0" };
  const current = { ...report([adminAfter, publicAfter]), schemaVersion: "2.0" };
  const delta = compareReports(baseline, current);
  assert.equal(delta.summary.addedRoutes, 0);
  assert.equal(delta.summary.removedRoutes, 0);
  assert.equal(delta.summary.authRegressions, 1);
  assert.equal(delta.authRegressions[0].applicationId, "app:admin#app");
});

test("auth regressions explain removed middleware and grants", () => {
  const before = route("GET", "/admin", "proven");
  before.middlewares = [{ name: "requireAuth", kind: "identifier", raw: "requireAuth" }];
  before.tags = ["authenticated"];
  before.roles = ["admin"];
  const after = route("GET", "/admin", "public");
  after.middlewares = [{ name: "logger", kind: "identifier", raw: "logger" }];
  after.tags = ["public"];
  const change = compareReports(report([before]), report([after])).authRegressions[0];
  assert.deepEqual(change.changes.removedMiddleware, ["requireAuth"]);
  assert.deepEqual(change.changes.removedTags, ["authenticated"]);
  assert.deepEqual(change.changes.removedRoles, ["admin"]);
  assert.match(change.explanation, /auth tag.*authenticated/i);
});

test("middleware multiplicity changes are not mislabeled as ordering changes", () => {
  const descriptor = (name) => ({ name, kind: "identifier", raw: name });
  const before = route("GET", "/duplicates", "proven");
  before.middlewares = ["a", "a", "b"].map(descriptor);
  const after = route("GET", "/duplicates", "public");
  after.middlewares = ["a", "b", "b"].map(descriptor);

  const change = compareReports(report([before]), report([after])).authRegressions[0];
  assert.equal(change.changes.middlewareOrderChanged, undefined);
  assert.match(change.explanation, /without a visible route-level middleware difference/);
});

test("middleware reordering is reported when the middleware multiset is unchanged", () => {
  const descriptor = (name) => ({ name, kind: "identifier", raw: name });
  const before = route("GET", "/ordered", "proven");
  before.middlewares = ["a", "b", "a"].map(descriptor);
  const after = route("GET", "/ordered", "public");
  after.middlewares = ["a", "a", "b"].map(descriptor);

  const change = compareReports(report([before]), report([after])).authRegressions[0];
  assert.equal(change.changes.middlewareOrderChanged, true);
  assert.match(change.explanation, /order changed/);
});

test("finding fingerprints make source-line moves baseline-stable", () => {
  const config = { authMiddleware: {} };
  const first = buildReport(audit({ mode: "static", src: FIXTURE }, config), {
    command: "audit",
    mode: "static",
  });
  const second = structuredClone(first);
  for (const finding of second.findings) {
    if (finding.source) finding.source.line += 100;
  }
  const delta = compareReports(first, second);
  assert.equal(delta.summary.newFindings, 0);
  assert.equal(delta.summary.resolvedFindings, 0);
});

test("schema 1.1 findings without fingerprint fields remain baseline-stable", () => {
  const config = {
    authMiddleware: {},
    acceptedPublic: ["DELETE /gone"],
  };
  const current = buildReport(audit({ mode: "static", src: FIXTURE }, config), {
    command: "audit",
    mode: "static",
  });
  const legacy = structuredClone(current);
  legacy.schemaVersion = "1.1";
  for (const route of legacy.routes) delete route.applicationId;
  for (const finding of legacy.findings) {
    delete finding.applicationId;
    delete finding.fingerprint;
    delete finding.ruleId;
    delete finding.confidence;
    delete finding.recommendation;
    delete finding.baselineEntry;
  }
  const delta = compareReports(legacy, current);
  assert.equal(delta.summary.newFindings, 0);
  assert.equal(delta.summary.resolvedFindings, 0);
});

test("--baseline adds delta output and supports new/regression gates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recon-baseline-"));
  try {
    const baseline = buildReport(
      audit(
        { mode: "static", src: FIXTURE },
        { authMiddleware: { requireAuth: "authenticated", getCfg: "authenticated" } },
      ),
      { command: "audit", mode: "static" },
    );
    const baselinePath = path.join(dir, "routes.json");
    fs.writeFileSync(baselinePath, JSON.stringify(baseline));

    const result = spawnSync(
      "node",
      [
        CLI,
        "audit",
        "--src",
        FIXTURE,
        "--format",
        "json",
        "--baseline",
        baselinePath,
        "--fail-on",
        "new,regression",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2);
    const current = JSON.parse(result.stdout);
    assert.ok(current.delta.summary.newFindings > 0);
    assert.ok(current.delta.summary.authRegressions > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("compareReports rejects malformed baselines clearly", () => {
  assert.throws(() => compareReports({}, report([])), /baseline must be an express-recon report/);
});

test("compareReports rejects different static scan scopes", () => {
  const baseline = report([]);
  const current = report([]);
  baseline.scanCoverage = { scope: { fingerprint: "a".repeat(64) } };
  current.scanCoverage = { scope: { fingerprint: "b".repeat(64) } };
  assert.throws(() => compareReports(baseline, current), /scan scopes differ/);
});

test("--fail-on new requires a baseline", () => {
  const result = spawnSync(
    "node",
    [CLI, "audit", "--src", FIXTURE, "--format", "json", "--fail-on", "new"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires --baseline/);
});
