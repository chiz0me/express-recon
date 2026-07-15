"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { audit, buildReport, formatters } = require("../src/index");
const { loadPackageInfo } = require("../src/static/resolve");

const FIXTURE = path.join(__dirname, "fixtures", "openapi-app");

function spec() {
  const reg = audit(
    { mode: "static", src: FIXTURE },
    { authMiddleware: { requireAuth: "authenticated" } },
  );
  const report = buildReport(reg, {
    command: "audit",
    mode: "static",
    target: loadPackageInfo(FIXTURE),
  });
  return JSON.parse(formatters.openapi.format(report));
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

test("derives security schemes and per-operation security from auth status", () => {
  const doc = spec();
  assert.ok(doc.components.securitySchemes.authenticated);
  assert.deepEqual(doc.paths["/items"].post.security, [{ authenticated: [] }]);
  // a public route gets an explicit empty security requirement
  assert.deepEqual(doc.paths["/items"].get.security, []);
});

test("carries x-express-recon traceback metadata per operation", () => {
  const doc = spec();
  const ext = doc.paths["/items/{id}"].get["x-express-recon"];
  assert.ok(ext.source.file.endsWith("app.js"));
  assert.equal(ext.authStatus, "public");
  assert.equal(ext.handlerResolved, true);
  assert.equal(ext.method, "GET");
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
  for (const verb of ["get", "post", "put", "patch", "delete"]) {
    assert.ok(wild[verb], `expected ${verb} on /wild`);
    assert.equal(wild[verb]["x-express-recon"].method, "ALL");
  }
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
