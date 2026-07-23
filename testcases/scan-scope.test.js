"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { inventory } = require("../src");

const DIR = path.join(__dirname, "fixtures", "scope-app");
const CLI = path.join(__dirname, "..", "src", "cli.js");

function paths(opts = {}) {
  return inventory({ mode: "static", src: DIR, ...opts })
    .routes.map((route) => route.path)
    .sort();
}

test("the default .express-reconignore excludes paths and supports re-inclusion", () => {
  assert.deepEqual(paths(), ["/main", "/private-keep", "/skip"]);
});

test("scan.ignoreFile:false disables the default scope file", () => {
  assert.deepEqual(paths({ ignoreFile: false }), [
    "/generated",
    "/main",
    "/private-drop",
    "/private-keep",
    "/skip",
  ]);
});

test("root-relative include and exclude globs compose", () => {
  assert.deepEqual(
    paths({
      ignoreFile: false,
      include: ["src/**"],
      exclude: ["src/skip/**"],
    }),
    ["/main"],
  );
});

test("CLI scan config and repeatable scope flags are applied", () => {
  const configured = spawnSync(
    "node",
    [
      CLI,
      "inventory",
      "--src",
      DIR,
      "--config",
      path.join(DIR, "scope.config.js"),
      "--format",
      "json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(configured.status, 0, configured.stderr);
  assert.deepEqual(
    JSON.parse(configured.stdout).routes.map((route) => route.path),
    ["/main"],
  );

  const flags = spawnSync(
    "node",
    [
      CLI,
      "inventory",
      "--src",
      DIR,
      "--include",
      "private/**",
      "--exclude",
      "private/drop.js",
      "--format",
      "json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(flags.status, 0, flags.stderr);
  assert.deepEqual(
    JSON.parse(flags.stdout).routes.map((route) => route.path),
    ["/private-keep"],
  );
});

test("an explicitly missing ignore file fails clearly", () => {
  assert.throws(
    () => inventory({ mode: "static", src: DIR, ignoreFile: "missing.ignore" }),
    /Could not read scan ignore file/,
  );
});

test("common test fixture directories are excluded by default and can be opted in", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-test-dirs-"));
  const source = (route) =>
    `const express = require("express"); const app = express(); app.get("${route}", handler);`;
  try {
    for (const [subdir, route] of [
      ["src", "/production"],
      ["testcases", "/testcase"],
      ["spec", "/spec"],
      ["specs", "/specs"],
    ]) {
      fs.mkdirSync(path.join(dir, subdir), { recursive: true });
      fs.writeFileSync(path.join(dir, subdir, "routes.js"), source(route));
    }
    const defaultPaths = inventory({ mode: "static", src: dir }).routes.map((route) => route.path);
    assert.deepEqual(defaultPaths, ["/production"]);
    const allPaths = inventory({ mode: "static", src: dir, includeTests: true })
      .routes.map((route) => route.path)
      .sort();
    assert.deepEqual(allPaths, ["/production", "/spec", "/specs", "/testcase"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
