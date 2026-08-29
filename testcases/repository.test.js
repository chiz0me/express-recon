"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const { scanRepository } = require("../src/index");
const { normalizeRepository, validRef } = require("../src/repository");

const FIXTURE = path.join(__dirname, "fixtures", "repository-app");
const CLI = path.join(__dirname, "..", "src", "cli.js");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function withRepository(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-git-fixture-"));
  try {
    fs.cpSync(FIXTURE, root, { recursive: true });
    fs.writeFileSync(path.join(root, "oversized.js"), "x".repeat(2048));
    fs.symlinkSync("app.js", path.join(root, "linked-app.js"));
    git(root, ["init", "--quiet"]);
    git(root, ["config", "user.email", "tests@example.test"]);
    git(root, ["config", "user.name", "express-recon tests"]);
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "fixture"]);
    return run(root, git(root, ["rev-parse", "HEAD"]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("scans a Git ref through a bounded non-executing source snapshot", () => {
  withRepository((root, commit) => {
    const progress = [];
    const result = scanRepository(root, {
      scan: { maxFileBytes: 1024, maxTotalBytes: 1024 * 1024 },
      onProgress(event) {
        progress.push(event);
      },
      config: {
        authMiddleware: { requireAuth: "authenticated" },
        openapi: {
          securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
          securityByTag: { authenticated: ["bearerAuth"] },
        },
      },
    });
    assert.equal(result.kind, "repository-scan");
    assert.equal(result.repository.commit, commit);
    assert.equal(result.repository.executedTargetCode, false);
    assert.equal(result.repository.installedDependencies, false);
    assert.equal(result.repository.followedSubmodules, false);
    assert.equal(result.repository.followedSymlinks, false);
    assert.equal(result.repository.acquisition.skippedSymlinks, 1);
    assert.equal(result.repository.acquisition.skippedFiles, 1);
    assert.equal(result.repository.acquisition.complete, false);

    assert.ok(result.inventory.routes.some((route) => route.path === "/health"));
    assert.equal(result.inventory.target.name, "repository-app");
    assert.equal(result.documentation.status, "merged");
    assert.equal(
      result.documentation.document.paths["/health"].get.summary,
      "Authored repository health",
    );
    assert.equal(
      result.documentation.document.paths["/health"].get.description,
      "Enriched from JSDoc",
    );
    assert.ok(result.documentation.document.paths["/code-only"].get);
    assert.deepEqual(result.documentation.document.paths["/code-only"].get.security, [
      { bearerAuth: [] },
    ]);
    assert.deepEqual(
      progress.map((event) => event.phase),
      ["acquiring", "discovering", "inventorying", "documenting", "cleaning-up"],
    );
    assert.ok(progress.every((event) => event.kind === "repository-scan-progress"));
    assert.equal(progress.find((event) => event.phase === "inventorying").applications, 1);
    assert.ok(progress.find((event) => event.phase === "documenting").routes > 0);
  });
});

test("scan-repo CLI emits portable provenance, discovery, inventory, and docs", () => {
  withRepository((root, commit) => {
    const result = JSON.parse(
      execFileSync("node", [CLI, "scan-repo", "--repo", root, "--ref", "HEAD"], {
        encoding: "utf8",
      }),
    );
    assert.equal(result.repository.commit, commit);
    assert.equal(result.discovery.applications.length, 1);
    assert.ok(result.inventory.routes.every((route) => !path.isAbsolute(route.source.file)));
    assert.equal(result.documentation.status, "merged");
  });
});

test("ignored symlinks make repository acquisition explicitly incomplete", () => {
  withRepository((root) => {
    const result = scanRepository(root, {
      onProgress() {
        throw new Error("observer failed");
      },
    });
    assert.equal(result.repository.acquisition.skippedFiles, 0);
    assert.equal(result.repository.acquisition.skippedSymlinks, 1);
    assert.equal(result.repository.acquisition.complete, false);
  });
});

test("repository snapshots are removed after successful and failed scans", () => {
  withRepository((root) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-cleanup-test-"));
    const modulePath = path.join(__dirname, "..", "src");
    const environment = {
      ...process.env,
      TMPDIR: tempRoot,
      TMP: tempRoot,
      TEMP: tempRoot,
    };
    try {
      const success = spawnSync(
        process.execPath,
        ["-e", `require(${JSON.stringify(modulePath)}).scanRepository(process.argv[1])`, root],
        { encoding: "utf8", env: environment },
      );
      assert.equal(success.status, 0, success.stderr);
      assert.deepEqual(fs.readdirSync(tempRoot), []);

      const failure = spawnSync(
        process.execPath,
        [
          "-e",
          `try { require(${JSON.stringify(modulePath)}).scanRepository(process.argv[1], { ref: "missing-ref" }); process.exitCode = 2 } catch {}`,
          root,
        ],
        { encoding: "utf8", env: environment },
      );
      assert.equal(failure.status, 0, failure.stderr);
      assert.deepEqual(fs.readdirSync(tempRoot), []);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

test("partial-clone materialization retains scoped GitHub authentication", () => {
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-git-auth-"));
  const bin = path.join(root, "bin");
  const log = path.join(root, "git.jsonl");
  const fakeGit = path.join(bin, "git");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    fakeGit,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const count = Number(process.env.GIT_CONFIG_COUNT || 0);
const config = Array.from({ length: count }, (_, index) => ({
  key: process.env[\`GIT_CONFIG_KEY_\${index}\`],
  value: process.env[\`GIT_CONFIG_VALUE_\${index}\`],
}));
fs.appendFileSync(
  process.env.EXPRESS_RECON_TEST_GIT_LOG,
  JSON.stringify({
    args,
    config,
    hasRawTokenVariables: Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN),
  }) + "\\n",
);
if (args[0] === "init") fs.mkdirSync(args.at(-1), { recursive: true });
if (args.includes("rev-parse")) process.stdout.write("${"a".repeat(40)}\\n");
if (args.includes("ls-tree")) {
  process.stdout.write("100644 blob ${"b".repeat(40)} 3\\tapp.js\\0");
}
if (args.includes("cat-file")) process.stdout.write("abc");
`,
    { mode: 0o755 },
  );
  const output = path.join(root, "report");
  try {
    const result = spawnSync(
      process.execPath,
      [CLI, "scan-repo", "--repo", "acme/private-api", "--out", output],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
          EXPRESS_RECON_TEST_GIT_LOG: log,
          GH_TOKEN: "token-for-test",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    const report = JSON.parse(fs.readFileSync(path.join(output, "repo-scan.json"), "utf8"));
    assert.equal(report.repository.acquisition.complete, true);
    const calls = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const call = (command) => calls.find((item) => item.args.includes(command));
    for (const command of ["fetch", "rev-parse", "ls-tree", "cat-file"]) {
      const invocation = call(command);
      assert.ok(invocation, command);
      assert.deepEqual(
        invocation.config.map((item) => item.key),
        ["http.https://github.com/.extraHeader"],
      );
      const encoded = invocation.config[0].value.replace(/^Authorization: Basic /, "");
      assert.equal(Buffer.from(encoded, "base64").toString(), "x-access-token:token-for-test");
    }
    assert.deepEqual(call("init").config, []);
    assert.deepEqual(call("remote").config, []);
    assert.ok(calls.every((item) => item.hasRawTokenVariables === false));
    assert.doesNotMatch(JSON.stringify(calls.map((item) => item.args)), /token-for-test/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scan-repo runs a deterministic audit when auth configuration is supplied", () => {
  withRepository((root) => {
    const result = scanRepository(root, {
      config: { authMiddleware: { requireAuth: "authenticated" } },
    });
    assert.equal(result.inventory.command, "audit");
    assert.ok(result.inventory.findings.some((finding) => finding.id === "public-route"));
  });
});

test("repository input rejects credentials, unsafe protocols, and option-like refs", () => {
  assert.throws(
    () => normalizeRepository("https://token@github.com/owner/repo.git"),
    /must not embed credentials/,
  );
  assert.throws(() => normalizeRepository("http://github.com/owner/repo.git"), /Only HTTPS/);
  assert.equal(validRef("refs/heads/main"), true);
  assert.equal(validRef("-c.core.hooksPath=evil"), false);
  assert.equal(validRef("main..evil"), false);
  assert.equal(normalizeRepository("owner/repo").remote, "https://github.com/owner/repo.git");

  const phases = [];
  assert.throws(
    () =>
      scanRepository(path.join(os.tmpdir(), "missing-express-recon-repository"), {
        onProgress: (event) => phases.push(event.phase),
      }),
    /Could not read local Git repository/,
  );
  assert.deepEqual(phases, ["acquiring", "acquisition-failed"]);
});

test("trusted local app auto-selection requires an explicit execution acknowledgement", () => {
  const denied = spawnSync(
    "node",
    [CLI, "inventory", "--mode", "hybrid", "--src", FIXTURE, "--app", "auto", "--format", "json"],
    { encoding: "utf8" },
  );
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /requires --allow-exec/);

  const report = JSON.parse(
    execFileSync(
      "node",
      [
        CLI,
        "inventory",
        "--mode",
        "hybrid",
        "--src",
        FIXTURE,
        "--app",
        "auto",
        "--allow-exec",
        "--format",
        "json",
      ],
      { encoding: "utf8" },
    ),
  );
  assert.equal(report.mode, "hybrid");
  assert.ok(report.routes.some((route) => route.path === "/health" && route.presence === "both"));
});

test("scan-repo never accepts target execution options", () => {
  const result = spawnSync(
    "node",
    [CLI, "scan-repo", "--repo", FIXTURE, "--app", "auto", "--allow-exec"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /scan-repo does not accept/);
});
