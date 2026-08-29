"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { inventory } = require("../src");
const { listSourceFiles } = require("../src/static/scan");

const DIR = path.join(__dirname, "fixtures", "scope-app");
const CLI = path.join(__dirname, "..", "src", "cli.js");

function paths(opts = {}) {
  return inventory({ mode: "static", src: DIR, ...opts })
    .routes.map((route) => route.path)
    .sort();
}

test("the default .express-reconignore excludes paths and supports re-inclusion", () => {
  assert.deepEqual(paths(), ["/main", "/private-keep", "/skip"]);
  const scope = inventory({ mode: "static", src: DIR }).scanCoverage.scope;
  assert.deepEqual(scope.include, []);
  assert.deepEqual(scope.exclude, []);
  assert.equal(scope.includeTests, false);
  assert.deepEqual(scope.ignoreFile, {
    enabled: true,
    path: ".express-reconignore",
    external: false,
    found: true,
    rules: 3,
    sha256: scope.ignoreFile.sha256,
  });
  assert.match(scope.ignoreFile.sha256, /^[a-f0-9]{64}$/);
  assert.match(scope.fingerprint, /^[a-f0-9]{64}$/);
  assert.ok(scope.builtIn.excludedDirectories.includes("node_modules"));
});

test("scan.ignoreFile:false disables the default scope file", () => {
  const result = inventory({ mode: "static", src: DIR, ignoreFile: false });
  assert.deepEqual(result.routes.map((route) => route.path).sort(), [
    "/generated",
    "/main",
    "/private-drop",
    "/private-keep",
    "/skip",
  ]);
  assert.deepEqual(result.scanCoverage.scope.ignoreFile, {
    enabled: false,
    path: null,
    external: false,
    found: false,
    rules: 0,
    sha256: null,
  });
});

test("an external ignore policy is applied without leaking its absolute path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-external-ignore-"));
  const ignoreFile = path.join(dir, "trusted.ignore");
  try {
    fs.writeFileSync(ignoreFile, "generated/**\n");
    const result = inventory({ mode: "static", src: DIR, ignoreFile });
    assert.deepEqual(result.routes.map((route) => route.path).sort(), [
      "/main",
      "/private-drop",
      "/private-keep",
      "/skip",
    ]);
    assert.equal(result.scanCoverage.scope.ignoreFile.path, "<external>/trusted.ignore");
    assert.equal(result.scanCoverage.scope.ignoreFile.external, true);
    assert.doesNotMatch(JSON.stringify(result.scanCoverage.scope), new RegExp(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scope fingerprints describe effective rules, not comments or include ordering", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-scope-fingerprint-"));
  const first = path.join(dir, "first.ignore");
  const second = path.join(dir, "second.ignore");
  try {
    fs.writeFileSync(first, "# first comment\ngenerated/**\n");
    fs.writeFileSync(second, "# changed comment\n/generated/**\n\n");
    const left = inventory({
      mode: "static",
      src: DIR,
      ignoreFile: first,
      include: ["src/**", "private/**", "src/**"],
    }).scanCoverage.scope;
    const right = inventory({
      mode: "static",
      src: DIR,
      ignoreFile: second,
      include: ["private/**", "src/**"],
    }).scanCoverage.scope;
    assert.notEqual(left.ignoreFile.sha256, right.ignoreFile.sha256);
    assert.equal(left.fingerprint, right.fingerprint);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("empty re-inclusion rules fail with a line-numbered diagnostic", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-invalid-ignore-"));
  const ignoreFile = path.join(dir, "invalid.ignore");
  try {
    fs.writeFileSync(ignoreFile, "generated/**\n!\n");
    assert.throws(
      () => inventory({ mode: "static", src: DIR, ignoreFile }),
      /invalid\.ignore:2: re-inclusion requires a pattern/i,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--no-ignore-file disables the repository ignore file", () => {
  const result = spawnSync(
    "node",
    [CLI, "inventory", "--src", DIR, "--no-ignore-file", "--format", "json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.routes.map((route) => route.path).sort(), [
    "/generated",
    "/main",
    "/private-drop",
    "/private-keep",
    "/skip",
  ]);
  assert.equal(report.scanCoverage.scope.ignoreFile.enabled, false);
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

test("source traversal honors the scan deadline before analysis starts", () => {
  let timedOut = false;
  const files = listSourceFiles(DIR, {
    deadline: Date.now() - 1,
    onTimeout() {
      timedOut = true;
    },
  });
  assert.deepEqual(files, []);
  assert.equal(timedOut, true);
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
