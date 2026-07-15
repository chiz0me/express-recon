"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { inventory } = require("../src/index");

const FIXTURE = path.join(__dirname, "fixtures", "openapi-app");

function byKey(routes) {
  const map = {};
  for (const r of routes) map[`${r.method} ${r.path}`] = r;
  return map;
}

test("mines request field names per source from inline handlers", () => {
  const routes = byKey(inventory({ mode: "static", src: FIXTURE }).routes);
  assert.deepEqual(routes["GET /items"].io.request.query, ["limit", "status"]);
  assert.deepEqual(routes["POST /items"].io.request.body, ["name", "price"]);
  assert.deepEqual(routes["GET /items/:id"].io.request.params, ["id"]);
  assert.deepEqual(routes["GET /whoami"].io.request.headers, ["authorization", "x-api-key"]);
});

test("mines response statuses and object-literal keys", () => {
  const routes = byKey(inventory({ mode: "static", src: FIXTURE }).routes);
  assert.deepEqual(routes["GET /items"].io.responses, [
    { status: 200, bodyKeys: ["items", "limit", "status", "total"] },
  ]);
  assert.deepEqual(routes["POST /items"].io.responses, [
    { status: 201, bodyKeys: ["id", "name", "price"] },
  ]);
  // res.send(string) records status 200 with no derivable body keys.
  assert.deepEqual(routes["ALL /wild"].io.responses, [{ status: 200, bodyKeys: null }]);
});

test("resolves inline and same-file handlers with a source location", () => {
  const routes = byKey(inventory({ mode: "static", src: FIXTURE }).routes);
  const r = routes["GET /items"];
  assert.equal(r.io.handlerResolved, true);
  assert.ok(r.io.handlerSource.file.endsWith("app.js"));
  assert.equal(typeof r.io.handlerSource.line, "number");
});

test("resolves an imported controller one hop across files", () => {
  const routes = byKey(inventory({ mode: "static", src: FIXTURE }).routes);
  const r = routes["GET /users/:id"];
  assert.equal(r.io.handlerResolved, true);
  assert.ok(r.io.handlerSource.file.endsWith("controllers.js"));
  assert.deepEqual(r.io.request.params, ["id"]);
  assert.deepEqual(r.io.request.query, ["expand"]);
  assert.deepEqual(r.io.responses, [{ status: 200, bodyKeys: ["email", "expand", "id"] }]);
});

test("marks a bare-package handler unresolved without inventing hints", () => {
  const routes = byKey(inventory({ mode: "static", src: FIXTURE }).routes);
  const r = routes["GET /opaque"];
  assert.equal(r.io.handlerResolved, false);
  assert.equal(r.io.handlerSource, null);
  assert.deepEqual(r.io.request.body, []);
  assert.deepEqual(r.io.responses, []);
});

test("captures the handler name even when the body isn't mined", () => {
  const routes = byKey(inventory({ mode: "static", src: FIXTURE }).routes);
  // named import used directly
  assert.equal(routes["GET /users/:id"].io.handlerName, "getUser");
  // dotted member expression, resolved cross-file
  assert.equal(routes["GET /members/:id"].io.handlerName, "controllers.getUser");
  assert.equal(routes["GET /members/:id"].io.handlerResolved, true);
  // unresolved bare-package handler still gets a name
  assert.equal(routes["GET /opaque"].io.handlerName, "render");
  // inline handlers have no name
  assert.equal(routes["GET /items"].io.handlerName, undefined);
});

test("never leaks the transient handlerRef into the report", () => {
  const routes = inventory({ mode: "static", src: FIXTURE }).routes;
  for (const r of routes) assert.equal(r.__handlerRef, undefined);
});
