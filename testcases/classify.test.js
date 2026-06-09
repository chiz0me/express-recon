"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { inconsistentPaths } = require("../src/classify");

test("flags a path where one verb is proven and another is public", () => {
  const routes = [
    { method: "GET", path: "/widgets/:id", authStatus: "proven" },
    { method: "POST", path: "/widgets/:id", authStatus: "proven" },
    { method: "PATCH", path: "/widgets/:id", authStatus: "public" },
    { method: "GET", path: "/health", authStatus: "public" },
  ];
  const gaps = inconsistentPaths(routes);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].path, "/widgets/:id");
  assert.deepEqual(
    gaps[0].methods.map((m) => `${m.method}=${m.authStatus}`),
    ["GET=proven", "PATCH=public", "POST=proven"],
  );
});

test("reports no gaps when every method on a path agrees", () => {
  const routes = [
    { method: "GET", path: "/a", authStatus: "public" },
    { method: "POST", path: "/a", authStatus: "public" },
  ];
  assert.deepEqual(inconsistentPaths(routes), []);
});
