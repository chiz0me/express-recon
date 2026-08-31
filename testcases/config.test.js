"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { loadConfig, validateConfig, audit } = require("../src");

const FIXTURE = path.join(__dirname, "fixtures", "static-app");
const YAML_CONFIG = path.join(__dirname, "fixtures", "policy.yaml");
const JSON_CONFIG = path.join(__dirname, "fixtures", "policy-array.json");
const CLI = path.join(__dirname, "..", "src", "cli.js");

test("YAML configuration is data-only and carries structured auth grants", () => {
  const config = loadConfig(YAML_CONFIG);
  const report = audit({ mode: "static", src: FIXTURE }, config);
  const route = report.routes.find((item) => item.path === "/me");
  assert.equal(route.authStatus, "proven");
  assert.deepEqual(route.roles, ["member"]);
  assert.deepEqual(route.scopes, ["profile:read"]);
});

test("a top-level JSON policy array is accepted as shorthand", () => {
  const config = loadConfig(JSON_CONFIG);
  assert.equal(config.policies[0].id, "health-rate-limit");
});

test("auth wrapper configuration rejects non-name values", () => {
  assert.throws(
    () =>
      audit(
        { mode: "static", src: FIXTURE },
        { authMiddleware: {}, authWrappers: ["asyncHandler", ""] },
      ),
    /authWrappers must be an array of non-empty wrapper names/,
  );
});

test("configuration rejects unknown fields and malformed scan/baseline values", () => {
  assert.throws(() => validateConfig({ authMiddlewares: {} }), /unknown field/);
  assert.throws(() => validateConfig({ scan: { includes: ["src/**"] } }), /unknown field/);
  assert.throws(() => validateConfig({ scan: { include: "src/**" } }), /array/);
  assert.throws(() => validateConfig({ scan: { includeHidden: "yes" } }), /boolean/);
  assert.doesNotThrow(() => validateConfig({ scan: { includeHidden: true } }));
  assert.throws(() => validateConfig({ acceptedPublic: ["get /health"] }), /METHOD \/path/);
  assert.throws(() => validateConfig({ acceptedPublic: ["GET /health "] }), /METHOD \/path/);
  assert.throws(
    () => validateConfig({ acceptedPublic: ["GET /health\nPOST /admin"] }),
    /METHOD \/path/,
  );
  assert.throws(() => validateConfig({ scan: { maxFiles: 0 } }), /scan.maxFiles/);
  assert.throws(() => validateConfig({ scan: { maxFileBytes: 100 } }), /scan.maxFileBytes/);
  assert.throws(() => validateConfig({ scan: { maxTotalBytes: 100 } }), /scan.maxTotalBytes/);
  assert.throws(() => validateConfig({ scan: { timeoutMs: 99 } }), /scan.timeoutMs/);
  assert.doesNotThrow(() => validateConfig({ acceptedPublic: ["GET /"] }));
  assert.doesNotThrow(() =>
    validateConfig({
      acceptedPublic: [
        {
          applicationId: "app:src/app.js#app",
          method: "GET",
          path: "/health",
        },
      ],
    }),
  );
  assert.throws(
    () =>
      validateConfig({
        acceptedPublic: [{ applicationId: "app:x#app", method: "get", path: "/health" }],
      }),
    /uppercase HTTP method/,
  );
  assert.throws(
    () =>
      validateConfig({
        acceptedPublic: [{ applicationId: " app:x#app", method: "GET", path: "/health" }],
      }),
    /applicationId/,
  );
  assert.throws(
    () =>
      validateConfig({
        acceptedPublic: [{ applicationId: "app:x#app", method: "GET", path: "/health " }],
      }),
    /path/,
  );
  assert.throws(
    () =>
      validateConfig({
        acceptedPublic: [
          { applicationId: "app:x#app", method: "GET", path: "/health", typo: true },
        ],
      }),
    /unknown field/,
  );
});

test("configuration validates boot limits even for static scans", () => {
  assert.throws(() => validateConfig({ boot: { timeout: 1000 } }), /unknown field/);
  assert.throws(
    () => validateConfig({ boot: { timeoutMs: 100, settleMs: 100 } }),
    /settleMs must be less/,
  );
});

test("OpenAPI security mappings require explicit, defined schemes", () => {
  const valid = {
    openapi: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      securityByTag: { authenticated: ["bearerAuth"] },
    },
  };
  assert.doesNotThrow(() => validateConfig(valid));
  assert.throws(
    () =>
      validateConfig({
        openapi: {
          securitySchemes: {},
          securityByTag: { authenticated: ["missing"] },
        },
      }),
    /undefined security scheme/,
  );
  assert.throws(
    () =>
      validateConfig({
        openapi: { securitySchemes: { "bad:name": { type: "http" } } },
      }),
    /invalid component name/,
  );
  assert.throws(
    () =>
      audit(
        { mode: "static", src: FIXTURE },
        { openapi: { securityByTag: { authenticated: ["missing"] } } },
      ),
    /undefined security scheme/,
  );
});

test("CLI accepts JSON and YAML data-only policy files", () => {
  for (const config of [YAML_CONFIG, JSON_CONFIG]) {
    const result = spawnSync(
      "node",
      [
        CLI,
        "audit",
        "--src",
        FIXTURE,
        "--config",
        config,
        "--format",
        "json",
        "--fail-on",
        "policy:health-rate-limit",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.ok(
      JSON.parse(result.stdout).findings.some((item) => item.ruleId === "health-rate-limit"),
    );
  }
});
