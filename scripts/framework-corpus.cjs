#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const { audit } = require("../src");

const ROOT = path.join(__dirname, "..", "testcases", "corpus");
const FRAMEWORKS = new Set(["express", "fastify", "nest"]);

function routeKey(route) {
  return `${route.method} ${route.path}`;
}

function hasSchemaEvidence(route) {
  const schemas = route.io?.schemas;
  return Boolean(
    schemas?.request?.query?.schema?.properties?.probe ||
    schemas?.responses?.some(
      (response) =>
        response.contract?.schema?.properties?.ok?.type === "boolean" ||
        response.contract?.schema?.properties?.secret?.type === "boolean",
    ),
  );
}

function accuracyMetrics(report, expected) {
  const observed = new Map(report.routes.map((route) => [routeKey(route), route]));
  const expectedKeys = Object.keys(expected);
  const matched = expectedKeys.filter((key) => observed.has(key));
  const extra = [...observed.keys()].filter((key) => !expected[key]);
  const falseProven = [...observed].filter(
    ([key, route]) => route.authStatus === "proven" && expected[key]?.protected !== true,
  );
  const protectedKeys = expectedKeys.filter((key) => expected[key].protected);
  const provenMatches = protectedKeys.filter((key) => observed.get(key)?.authStatus === "proven");
  const schemaKeys = expectedKeys.filter((key) => expected[key].schema);
  const schemaMatches = schemaKeys.filter((key) => hasSchemaEvidence(observed.get(key) || {}));
  const gaps = report.routeGraph?.gaps?.length || 0;
  const opaque = report.routeGraph?.opaqueMounts?.length || 0;
  const partial = report.routes.filter((route) => route.pathConfidence !== "full").length;
  return {
    routes: {
      expected: expectedKeys.length,
      observed: observed.size,
      matched: matched.length,
      extra,
      precision: observed.size ? matched.length / observed.size : 0,
      recall: expectedKeys.length ? matched.length / expectedKeys.length : 1,
    },
    authentication: {
      expectedProven: protectedKeys.length,
      provenMatches: provenMatches.length,
      falseProven: falseProven.map(([key]) => key),
      recall: protectedKeys.length ? provenMatches.length / protectedKeys.length : 1,
    },
    schema: {
      expected: schemaKeys.length,
      matched: schemaMatches.length,
      recall: schemaKeys.length ? schemaMatches.length / schemaKeys.length : 1,
    },
    unresolvedRegistrations: gaps + opaque + partial + (report.routeGraph?.orphanRoutes || 0),
  };
}

async function requestOutcomes(framework) {
  if (framework === "express") {
    const app = require(path.join(ROOT, "express", "app.js"));
    const server = await new Promise((resolve) => {
      const value = app.listen(0, "127.0.0.1", () => resolve(value));
    });
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      return {
        health: (await fetch(`${origin}/health?probe=ok`)).status,
        secure: (await fetch(`${origin}/v1/secure`)).status,
      };
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
  if (framework === "fastify") {
    const app = require(path.join(ROOT, "fastify", "app.js"));
    try {
      const health = await app.inject({ method: "GET", url: "/health?probe=ok" });
      const secure = await app.inject({ method: "GET", url: "/v1/secure" });
      return { health: health.statusCode, secure: secure.statusCode };
    } finally {
      await app.close();
    }
  }
  const platform = process.env.NEST_PLATFORM || "express";
  const { createApplication } = require(path.join(ROOT, "nest", "runtime.cjs"));
  const app = await createApplication(platform);
  try {
    const origin = await app.getUrl();
    return {
      health: (await fetch(`${origin}/api/status/health`)).status,
      secure: (await fetch(`${origin}/api/status/secure`)).status,
    };
  } finally {
    await app.close();
  }
}

async function main() {
  const framework = process.argv[2];
  if (!FRAMEWORKS.has(framework)) {
    throw new Error("usage: node scripts/framework-corpus.cjs <express|fastify|nest>");
  }
  const src = path.join(ROOT, framework);
  const prefixes = framework === "nest" ? "/api/status" : framework === "express" ? "" : "";
  const expected = {
    [`GET ${prefixes || ""}/health`]: { protected: false, schema: true },
    [`GET ${prefixes || "/v1"}/secure`]: { protected: true, schema: false },
  };
  const report = audit(
    { mode: "static", src, exclude: framework === "nest" ? ["runtime.cjs"] : [] },
    {
      authMiddleware:
        framework === "nest" ? { DenyGuard: "authenticated" } : { requireAuth: "authenticated" },
    },
  );
  const metrics = accuracyMetrics(report, expected);
  const behavior = await requestOutcomes(framework);

  assert.equal(metrics.routes.precision, 1, JSON.stringify(metrics));
  assert.equal(metrics.routes.recall, 1, JSON.stringify(metrics));
  assert.deepEqual(metrics.authentication.falseProven, [], JSON.stringify(metrics));
  assert.equal(metrics.authentication.recall, 1, JSON.stringify(metrics));
  assert.equal(metrics.schema.recall, 1, JSON.stringify(metrics));
  assert.equal(metrics.unresolvedRegistrations, 0, JSON.stringify(metrics));
  assert.equal(behavior.health, 200);
  assert.ok(behavior.secure === 401 || behavior.secure === 403, JSON.stringify(behavior));

  process.stdout.write(
    `${JSON.stringify({ framework, platform: process.env.NEST_PLATFORM || null, metrics, behavior })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
