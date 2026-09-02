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

test("per-verb gaps never combine identical paths from separate applications", () => {
  const routes = [
    {
      applicationId: "app:public#app",
      method: "GET",
      path: "/health",
      authStatus: "public",
    },
    {
      applicationId: "app:admin#app",
      method: "POST",
      path: "/health",
      authStatus: "proven",
    },
  ];
  assert.deepEqual(inconsistentPaths(routes), []);

  routes.push({
    applicationId: "app:admin#app",
    method: "GET",
    path: "/health",
    authStatus: "public",
  });
  const gaps = inconsistentPaths(routes);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].applicationId, "app:admin#app");
});

test("inconsistent paths are sorted by application and path", () => {
  const routes = [
    { applicationId: "app:z", method: "GET", path: "/z", authStatus: "public" },
    { applicationId: "app:z", method: "POST", path: "/z", authStatus: "proven" },
    { applicationId: "app:a", method: "GET", path: "/a", authStatus: "proven" },
    { applicationId: "app:a", method: "POST", path: "/a", authStatus: "public" },
  ];
  assert.deepEqual(
    inconsistentPaths(routes).map((entry) => `${entry.applicationId} ${entry.path}`),
    ["app:a /a", "app:z /z"],
  );
});
