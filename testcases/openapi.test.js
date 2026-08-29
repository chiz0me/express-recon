"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { audit, buildReport, formatters } = require("../src/index");
const { loadPackageInfo } = require("../src/static/resolve");

const FIXTURE = path.join(__dirname, "fixtures", "openapi-app");
const CONFIG = {
  authMiddleware: { requireAuth: "authenticated" },
  openapi: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      sessionCookie: { type: "apiKey", in: "cookie", name: "session" },
    },
    securityByTag: {
      authenticated: ["bearerAuth"],
      session: ["sessionCookie"],
    },
  },
};

function report() {
  const reg = audit({ mode: "static", src: FIXTURE }, CONFIG);
  return buildReport(reg, {
    command: "audit",
    mode: "static",
    target: loadPackageInfo(FIXTURE),
  });
}

function spec() {
  return JSON.parse(formatters.openapi.format(report()));
}

test("emits a valid OpenAPI 3.1 envelope with target info", () => {
  const doc = spec();
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.info.title, "openapi-fixture API");
  assert.equal(doc.info.version, "9.9.9");
  assert.equal(doc["x-express-recon"].schemasArePlaceholders, true);
});

test("templates Express path params and emits path parameters", () => {
  const doc = spec();
  const op = doc.paths["/items/{id}"].get;
  const idParam = op.parameters.find((p) => p.in === "path" && p.name === "id");
  assert.ok(idParam);
  assert.equal(idParam.required, true);
});

test("maps request body hints to a placeholder object schema", () => {
  const doc = spec();
  const schema = doc.paths["/items"].post.requestBody.content["application/json"].schema;
  assert.equal(schema.type, "object");
  assert.deepEqual(Object.keys(schema.properties).sort(), ["name", "price"]);
});

test("maps query hints to query parameters", () => {
  const doc = spec();
  const names = doc.paths["/items"].get.parameters
    .filter((p) => p.in === "query")
    .map((p) => p.name)
    .sort();
  assert.deepEqual(names, ["limit", "status"]);
});

test("maps response statuses and always adds a default", () => {
  const doc = spec();
  const responses = doc.paths["/items"].post.responses;
  assert.ok(responses["201"]);
  assert.ok(responses.default);
});

test("emits only explicitly mapped security schemes", () => {
  const doc = spec();
  assert.deepEqual(doc.components.securitySchemes.bearerAuth, {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
  });
  assert.deepEqual(doc.paths["/items"].post.security, [{ bearerAuth: [] }]);
  // a public route gets an explicit empty security requirement
  assert.deepEqual(doc.paths["/items"].get.security, []);
});

test("unmapped auth tags stay as audit evidence instead of becoming invented bearer schemes", () => {
  const value = report();
  delete value.openapi;
  const doc = JSON.parse(formatters.openapi.format(value));
  assert.equal(doc.components, undefined);
  assert.equal(doc.paths["/items"].post.security, undefined);
  assert.deepEqual(doc.paths["/items"].post["x-express-recon"].unmappedAuthTags, ["authenticated"]);
});

test("multiple mapped guards are conjunctive in one security requirement", () => {
  const value = report();
  const route = value.routes.find((item) => item.method === "POST" && item.path === "/items");
  route.tags.push("session");
  const doc = JSON.parse(formatters.openapi.format(value));
  assert.deepEqual(doc.paths["/items"].post.security, [{ bearerAuth: [], sessionCookie: [] }]);
});

test("prototype-like schema fields and security schemes remain ordinary data", () => {
  const value = report();
  const route = value.routes.find((item) => item.method === "POST" && item.path === "/items");
  route.io.request.body = ["__proto__"];
  value.openapi = {
    securitySchemes: Object.fromEntries([
      ["__proto__", { type: "apiKey", in: "header", name: "x-auth" }],
    ]),
    securityByTag: { authenticated: ["__proto__"] },
  };
  const doc = formatters.openapi.build(value);
  const properties =
    doc.paths["/items"].post.requestBody.content["application/json"].schema.properties;
  const requirement = doc.paths["/items"].post.security[0];
  assert.equal(Object.hasOwn(properties, "__proto__"), true);
  assert.deepEqual(properties.__proto__, {});
  assert.equal(Object.hasOwn(requirement, "__proto__"), true);
  assert.deepEqual(requirement.__proto__, []);
  assert.equal(Object.hasOwn(doc.components.securitySchemes, "__proto__"), true);
});

test("non-slash catch-all paths become valid OpenAPI path keys", () => {
  const value = report();
  const existing = value.routes.find((item) => item.method === "GET" && item.path === "/items");
  value.routes = [{ ...structuredClone(existing), path: "*" }];
  const doc = formatters.openapi.build(value);
  assert.ok(doc.paths["/{wildcard}"].get);
  assert.equal(Object.hasOwn(doc.paths, "{wildcard}"), false);
});

test("carries x-express-recon traceback metadata per operation", () => {
  const doc = spec();
  const ext = doc.paths["/items/{id}"].get["x-express-recon"];
  assert.ok(ext.source.file.endsWith("app.js"));
  assert.equal(ext.authStatus, "public");
  assert.equal(ext.handlerResolved, true);
  assert.ok(ext.handlerSource.file.endsWith("app.js"));
  assert.equal(typeof ext.handlerSource.line, "number");
  assert.equal(ext.method, "GET");
  assert.match(ext.applicationId, /^app:/);
});

test("surfaces the handler name for controller-backed operations", () => {
  const doc = spec();
  assert.equal(
    doc.paths["/members/{id}"].get["x-express-recon"].handlerName,
    "controllers.getUser",
  );
  // inline handlers report a null name
  assert.equal(doc.paths["/items"].get["x-express-recon"].handlerName, null);
});

test("expands router.all() across concrete verbs, flagged as ALL", () => {
  const doc = spec();
  const wild = doc.paths["/wild"];
  for (const verb of ["get", "post", "put", "patch", "delete", "head", "options", "trace"]) {
    assert.ok(wild[verb], `expected ${verb} on /wild`);
    assert.equal(wild[verb]["x-express-recon"].method, "ALL");
  }
});

test("duplicate operations are reported instead of disappearing silently", () => {
  const value = report();
  const existing = value.routes.find((item) => item.method === "GET" && item.path === "/items");
  value.routes.push({
    ...structuredClone(existing),
    source: { file: "/tmp/duplicate.js", line: 9 },
  });
  const doc = JSON.parse(formatters.openapi.format(value));
  assert.deepEqual(doc["x-express-recon"].duplicateOperations, [
    {
      keptApplicationId: existing.applicationId,
      droppedApplicationId: existing.applicationId,
      method: "GET",
      path: "/items",
      keptSource: existing.source,
      droppedSource: { file: "/tmp/duplicate.js", line: 9 },
    },
  ]);
});

test("operationIds are unique across the document", () => {
  const doc = spec();
  const ids = [];
  for (const item of Object.values(doc.paths))
    for (const op of Object.values(item)) ids.push(op.operationId);
  assert.equal(new Set(ids).size, ids.length);
});

test("inventory specs carry no security section", () => {
  const { inventory } = require("../src/index");
  const report = buildReport(inventory({ mode: "static", src: FIXTURE }), {
    command: "inventory",
    mode: "static",
  });
  const doc = JSON.parse(formatters.openapi.format(report));
  assert.equal(doc.components, undefined);
  assert.equal(doc.paths["/items"].get.security, undefined);
});
