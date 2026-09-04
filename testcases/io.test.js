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

test("mines request field names from destructured handler parameters", () => {
  const { parse } = require("../src/static/ast");
  const { extractIoHints } = require("../src/static/io-hints");
  const code = `
    const handler1 = ({ body, query }, res) => {
      res.json({ title: body.title, q: query.search });
    };
    const handler2 = ({ body: { title, count }, params }, res) => {
      const { id } = params;
      res.json({ id, title, count });
    };
    const handler3 = (req, res) => {
      const { body } = req;
      res.json({ title: body.title });
    };
  `;
  const ast = parse(code, "/virtual/test.js");
  const fn1 = ast.body[0].declarations[0].init;
  const io1 = extractIoHints(fn1);
  assert.deepEqual(io1.request.body, ["title"]);
  assert.deepEqual(io1.request.query, ["search"]);

  const fn2 = ast.body[1].declarations[0].init;
  const io2 = extractIoHints(fn2);
  assert.deepEqual(io2.request.body, ["count", "title"]);
  assert.deepEqual(io2.request.params, ["id"]);

  const fn3 = ast.body[2].declarations[0].init;
  const io3 = extractIoHints(fn3);
  assert.deepEqual(io3.request.body, ["title"]);
});

test("shadowed request and body variables in inner functions or blocks do not leak into request inputs", () => {
  const { parse } = require("../src/static/ast");
  const { extractIoHints } = require("../src/static/io-hints");
  const code = `
    const handler = (req, res) => {
      const { body } = req;
      const realField = body.realField;

      // Inner helper with parameter named body
      function helper(body) {
        return body.fakeField;
      }

      // Inner block with variable named body
      if (realField) {
        const body = { innerField: true };
        console.log(body.innerField);
      }

      res.json({ ok: true, realField });
    };
  `;
  const ast = parse(code, "/virtual/test.js");
  const fn = ast.body[0].declarations[0].init;
  const io = extractIoHints(fn);
  assert.deepEqual(io.request.body, ["realField"]);
});

test("shadowed request and body variables in catch clauses and loops do not leak into request inputs", () => {
  const { parse } = require("../src/static/ast");
  const { extractIoHints } = require("../src/static/io-hints");
  const code = `
    const handler = (req, res) => {
      const { body } = req;
      const realField = body.realField;

      try {
        doSomething();
      } catch (body) {
        console.log(body.fromCatch);
      }

      for (const body of items) {
        console.log(body.fromLoop);
      }

      for (let body = 0; body < 5; body++) {
        console.log(body.fromFor);
      }

      for (const body in obj) {
        console.log(body.fromForIn);
      }

      switch (realField) {
        case "test": {
          const body = { fromSwitch: true };
          console.log(body.fromSwitch);
          break;
        }
      }

      res.json({ ok: true, realField });
    };
  `;
  const ast = parse(code, "/virtual/test.js");
  const fn = ast.body[0].declarations[0].init;
  const io = extractIoHints(fn);
  assert.deepEqual(io.request.body, ["realField"]);
});
