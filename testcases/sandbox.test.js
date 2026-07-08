"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const util = require("node:util");
const express = require("express");

const { installSandbox, makeStub } = require("../src/runtime/sandbox");
const {
  instrument,
  resetCapture,
  getCapturedRoots,
  harvestApp,
} = require("../src/runtime/instrument");
const { walk } = require("../src/walk");

test("awaiting a stub resolves instead of looping forever", async () => {
  const stub = makeStub("client");
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("stub await hung")), 2000);
  });
  const settled = await Promise.race([stub.connect(), guard]);
  clearTimeout(timer);
  assert.equal(typeof settled, "function");
  assert.equal(settled.then, undefined); // non-thenable, so await terminated
});

test(".then(cb) invokes cb asynchronously and chains catch/finally", async () => {
  const stub = makeStub("db");
  let called = null;
  const chained = stub
    .connect()
    .then((v) => {
      called = v;
      return "done";
    })
    .catch(() => "caught");
  assert.equal(called, null); // not invoked synchronously
  assert.equal(await chained, "done"); // catch never fired: stubs never reject
  assert.equal(typeof called, "function");
  let finallyRan = false;
  await stub.query().finally(() => {
    finallyRan = true;
  });
  assert.ok(finallyRan);
});

test("stubs chain through get/call/new with stable identity", () => {
  const stub = makeStub("pg");
  assert.equal(stub.a, stub.a);
  assert.equal(typeof stub.a.b().c, "function");
  const pool = new stub.Pool();
  assert.equal(typeof pool.query, "function");
  assert.ok("query" in pool);
});

test("stubs are inspection- and serialization-safe", () => {
  const stub = makeStub("redis");
  assert.equal(stub[Symbol.iterator], undefined);
  assert.equal(stub[Symbol.asyncIterator], undefined);
  assert.ok(util.inspect(stub).includes("express-recon stub"));
  assert.ok(`${stub}`.includes("express-recon stub"));
  assert.doesNotThrow(() => JSON.stringify(stub));
});

test("installSandbox stubs infra packages before resolution", () => {
  const sandbox = installSandbox({ stubModules: ["not-a-real-pkg", "@fake-scope/"] });
  try {
    const pg = require("pg"); // not installed anywhere — stubbed pre-resolution
    assert.ok(util.inspect(pg).includes("stub"));
    assert.equal(require("pg"), pg); // stable identity across requires
    assert.ok(util.inspect(require("mysql2/promise")).includes("stub")); // package-root match
    assert.ok(util.inspect(require("@aws-sdk/client-s3")).includes("stub")); // prefix match
    assert.ok(util.inspect(require("not-a-real-pkg")).includes("stub")); // config extra
    assert.ok(util.inspect(require("@fake-scope/anything")).includes("stub")); // config prefix
    assert.equal(require("express"), express); // never stubbed
    assert.equal(require("node:path").join("a", "b"), require("path").join("a", "b"));
    assert.ok(sandbox.diagnostics().some((d) => d.includes("pg")));
  } finally {
    sandbox.uninstall();
  }
  assert.throws(() => require("pg"), /Cannot find module/); // no cache pollution
});

test("listen never binds a port and process.exit is ignored", async () => {
  const sandbox = installSandbox();
  try {
    const port = 39471; // same fixed port twice: only possible when nothing binds
    const servers = await Promise.all(
      [express(), express()].map(
        (app) =>
          new Promise((resolve) => {
            const server = app.listen(port, () => resolve(server));
          }),
      ),
    );
    assert.equal(servers[0].address().port, 0);
    process.exit(7); // recorded + ignored — this test keeps running
    assert.ok(sandbox.diagnostics().some((d) => d.includes("process.exit(7)")));
    assert.ok(sandbox.diagnostics().some((d) => d.includes("no port was bound")));
  } finally {
    sandbox.uninstall();
  }
});

test("capture keeps top-level roots only and harvest walks them", () => {
  instrument(express);
  resetCapture();
  const app = express();
  const sub = express.Router();
  sub.get("/x", (req, res) => res.end());
  app.use("/sub", sub);
  const roots = getCapturedRoots();
  assert.equal(roots.length, 1); // sub-router and internal router filtered out
  assert.equal(roots[0], app);
  const { routes } = walk(harvestApp(roots));
  assert.deepEqual(
    routes.map((r) => `${r.method} ${r.path}`),
    ["GET /sub/x"],
  );

  resetCapture();
  assert.equal(getCapturedRoots().length, 0);

  const r1 = express.Router();
  r1.get("/one", (req, res) => res.end());
  const r2 = express.Router();
  r2.post("/two", (req, res) => res.end());
  const merged = walk(harvestApp(getCapturedRoots()));
  assert.deepEqual(merged.routes.map((r) => `${r.method} ${r.path}`).sort(), [
    "GET /one",
    "POST /two",
  ]);
});
