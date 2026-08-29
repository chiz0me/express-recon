"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { audit, buildReport, evaluatePolicies, normalizePolicies } = require("../src/index");
const { todayUtc } = require("../src/policies");

const FIXTURE = path.join(__dirname, "fixtures", "static-app");
const CLI = path.join(__dirname, "..", "src", "cli.js");
const CONFIG = path.join(__dirname, "fixtures", "policy.config.js");

function route(overrides = {}) {
  return {
    method: "POST",
    path: "/api/widgets",
    middlewares: [],
    source: { file: "/repo/routes.js", line: 10 },
    pathConfidence: "full",
    authStatus: "public",
    tags: ["public"],
    ...overrides,
  };
}

test("a policy requires auth for matching write routes", () => {
  const registry = evaluatePolicies({ routes: [route()], globalMiddleware: [] }, [
    {
      id: "writes-require-auth",
      severity: "high",
      match: { methods: ["POST", "PUT", "PATCH", "DELETE"], paths: ["/api/**"] },
      require: { auth: true },
    },
  ]);
  assert.equal(registry.policyFindings.length, 1);
  const finding = registry.policyFindings[0];
  assert.equal(finding.ruleId, "writes-require-auth");
  assert.equal(finding.evidence.missingAuth, true);
  assert.match(finding.fingerprint, /^finding_[a-f0-9]{16}$/);
});

test("path globs, exclusions, and middleware requirements compose", () => {
  const registry = evaluatePolicies(
    {
      routes: [
        route({
          path: "/api/widgets/1",
          middlewares: [{ name: "rateLimit", kind: "identifier", raw: "rateLimit" }],
        }),
        route({ path: "/api/public/status" }),
      ],
      globalMiddleware: [],
    },
    [
      {
        id: "api-rate-limit",
        match: { paths: ["/api/**"], excludePaths: ["/api/public/**"] },
        require: { anyMiddleware: ["rateLimit", "slowDown"] },
      },
    ],
  );
  assert.equal(registry.policyFindings.length, 0);
});

test("application selectors scope policies when apps share the same route path", () => {
  const registry = evaluatePolicies(
    {
      routes: [
        route({ applicationId: "app:admin#app", path: "/health" }),
        route({ applicationId: "app:public#app", path: "/health" }),
      ],
      globalMiddleware: [],
    },
    [
      {
        id: "admin-health-auth",
        match: { applicationIds: ["app:admin#app"], paths: ["/health"] },
        require: { auth: true },
      },
    ],
  );
  assert.equal(registry.policyFindings.length, 1);
  assert.equal(registry.policyFindings[0].applicationId, "app:admin#app");
  assert.deepEqual(registry.policies[0].match.applicationIds, ["app:admin#app"]);
});

test("wrapped middleware names satisfy policy requirements", () => {
  const registry = evaluatePolicies(
    {
      routes: [
        route({
          middlewares: [
            {
              name: "asyncHandler",
              kind: "call",
              raw: "asyncHandler(csrfProtection)",
              inner: ["csrfProtection"],
            },
          ],
        }),
      ],
      globalMiddleware: [],
    },
    [{ id: "csrf", require: { allMiddleware: ["csrfProtection"] } }],
  );
  assert.equal(registry.policyFindings.length, 0);
});

test("forbidden middleware produces structured evidence", () => {
  const registry = evaluatePolicies(
    {
      routes: [
        route({
          middlewares: [{ name: "debugBypass", kind: "identifier", raw: "debugBypass" }],
        }),
      ],
      globalMiddleware: [],
    },
    [{ id: "no-debug-bypass", require: { noMiddleware: ["debugBypass"] } }],
  );
  assert.deepEqual(registry.policyFindings[0].evidence.forbiddenMiddleware, ["debugBypass"]);
});

test("roles, scopes, middleware ordering, and boolean expressions compose", () => {
  const compliant = route({
    authStatus: "proven",
    tags: ["authenticated"],
    roles: ["admin"],
    scopes: ["users:write"],
    middlewares: [
      { name: "requireAuth", kind: "identifier", raw: "requireAuth" },
      { name: "requireRole", kind: "identifier", raw: "requireRole" },
    ],
  });
  const policy = {
    id: "admin-write",
    require: {
      all: [
        { auth: true },
        { roles: ["admin"] },
        {
          any: [{ scopes: ["users:write"] }, { allTags: ["break-glass"] }],
        },
        { middlewareOrder: ["requireAuth", "requireRole"] },
      ],
      not: { allMiddleware: ["debugBypass"] },
    },
  };
  assert.equal(
    evaluatePolicies({ routes: [compliant], globalMiddleware: [] }, [policy]).policyFindings.length,
    0,
  );

  const reversed = {
    ...compliant,
    middlewares: [...compliant.middlewares].reverse(),
  };
  const finding = evaluatePolicies({ routes: [reversed], globalMiddleware: [] }, [policy])
    .policyFindings[0];
  assert.ok(finding.evidence.allOf.some((failure) => failure.evidence.middlewareOrder));
});

test("active exceptions suppress violations and expired exceptions become evidence", () => {
  const policy = {
    id: "temporary-public",
    require: { auth: true },
    exceptions: [
      {
        id: "migration",
        reason: "Temporary migration callback",
        expires: "2030-01-31",
        match: { methods: ["POST"], paths: ["/api/widgets"] },
      },
    ],
  };
  const active = evaluatePolicies({ routes: [route()], globalMiddleware: [] }, [policy], {
    now: "2030-01-01",
  });
  assert.equal(active.policyFindings.length, 0);
  assert.equal(active.policyExceptions[0].exceptionId, "migration");

  const expired = evaluatePolicies({ routes: [route()], globalMiddleware: [] }, [policy], {
    now: "2030-02-01",
  });
  assert.equal(expired.policyFindings.length, 1);
  assert.equal(expired.policyFindings[0].evidence.expiredException.id, "migration");
  assert.ok(expired.diagnostics.some((message) => message.includes("expired on 2030-01-31")));
});

test("policy evaluation dates reject coercible garbage and invalid calendar dates", () => {
  assert.throws(() => todayUtc("0"), /policy evaluation now must be a valid date/);
  assert.throws(() => todayUtc("2030-02-30"), /policy evaluation now must be a valid date/);
  assert.throws(
    () => todayUtc("2030-02-30T00:00:00Z"),
    /policy evaluation now must be a valid date/,
  );
  assert.equal(todayUtc("2030-02-01"), "2030-02-01");
});

test("policy validation rejects duplicate ids and empty requirements", () => {
  assert.throws(
    () =>
      normalizePolicies([
        { id: "same", require: { auth: true } },
        { id: "same", require: { auth: true } },
      ]),
    /Duplicate policy id/,
  );
  assert.throws(() => normalizePolicies([{ id: "empty", require: {} }]), /must set auth:true/);
});

test("audit reports policy violations with stable fingerprints", () => {
  const config = {
    authMiddleware: { requireAuth: "authenticated" },
    policies: [
      {
        id: "health-rate-limit",
        match: { methods: ["GET"], paths: ["/health"] },
        require: { anyMiddleware: ["rateLimit"] },
      },
    ],
  };
  const first = buildReport(audit({ mode: "static", src: FIXTURE }, config), {
    command: "audit",
    mode: "static",
  });
  const second = buildReport(audit({ mode: "static", src: FIXTURE }, config), {
    command: "audit",
    mode: "static",
  });
  const a = first.findings.find((finding) => finding.ruleId === "health-rate-limit");
  const b = second.findings.find((finding) => finding.ruleId === "health-rate-limit");
  assert.ok(a);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(first.summary.policyViolations, 1);
  assert.equal(first.schemaVersion, "2.0");
});

test("--fail-on policy and policy:<id> gate configured violations", () => {
  for (const gate of ["policy", "policy:health-rate-limit"]) {
    assert.throws(
      () =>
        execFileSync(
          "node",
          [
            CLI,
            "audit",
            "--src",
            FIXTURE,
            "--config",
            CONFIG,
            "--format",
            "json",
            "--fail-on",
            gate,
          ],
          { stdio: "pipe" },
        ),
      (error) => error.status === 2,
    );
  }
});
