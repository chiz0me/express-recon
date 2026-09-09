"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { generateKeyPairSync } = require("node:crypto");
const api = require("../src");
const { credentialFreeEnvironment } = require("../src/github-auth");
const { semanticSourceHash } = require("../src/source-semantics");
const { writeRepositoryArtifacts } = require("../src/cli");

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});
const appEnvironment = {
  GITHUB_APP_ID: "456",
  GITHUB_INSTALLATION_ID: "789",
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_TOKEN: "ambient-pat",
};
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status });

test("GitHub App selection, organization verification and shared renewal span a three-hour scan", async () => {
  let now = Date.now(),
    issued = 0;
  const tokens = [];
  const provider = api.createGitHubTokenProvider({
    environment: appEnvironment,
    now: () => now,
    fetchImpl: async (url, options) => {
      assert.match(options.headers.Authorization, /^Bearer /i);
      assert.equal(options.redirect, "error");
      if (!url.endsWith("access_tokens"))
        return reply({
          id: 789,
          account: { type: "Organization", login: "acme" },
          repository_selection: "selected",
        });
      issued++;
      const token = `opaque-${issued}-${"x".repeat(5000)}.arbitrary`;
      tokens.push(token);
      return reply({
        token,
        expires_at: new Date(now + 3600000).toISOString(),
        repository_selection: "selected",
        permissions: { contents: "read" },
      });
    },
  });
  assert.equal(provider.mode, "github-app");
  assert.equal((await provider.verifyOrganization("ACME")).repositorySelection, "selected");
  await assert.rejects(provider.verifyOrganization("another"), /does not belong/);
  for (let hour = 0; hour < 4; hour++) {
    const values = await Promise.all(Array.from({ length: 20 }, () => provider.getToken()));
    assert.equal(new Set(values).size, 1);
    assert.equal(issued, hour + 1);
    now += 3600000;
  }
  for (const token of [...tokens, "ambient-pat", privateKey])
    assert.equal(provider.redact(`error ${token}`), "error [REDACTED]");
  const clean = credentialFreeEnvironment({ ...appEnvironment, GH_TOKEN: "secret", PATH: "/bin" });
  assert.deepEqual(clean, { PATH: "/bin" });
});

test("auth never falls back to an ambient identity and reports malformed settings", async () => {
  assert.throws(
    () =>
      api.createGitHubTokenProvider({
        environment: { GITHUB_APP_ID: "1", GITHUB_TOKEN: "ambient" },
      }),
    /Incomplete/,
  );
  assert.throws(() => api.createGitHubTokenProvider({ auth: "invalid" }), /--auth/);
  assert.throws(() => api.createGitHubTokenProvider({ auth: "github-app" }), /Incomplete/);
  assert.throws(
    () =>
      api.createGitHubTokenProvider({ environment: { ...appEnvironment, GITHUB_APP_ID: "NaN" } }),
    /positive/,
  );
  assert.throws(
    () =>
      api.createGitHubTokenProvider({
        environment: { ...appEnvironment, GITHUB_APP_PRIVATE_KEY: 4 },
      }),
    /PEM/,
  );
  assert.throws(() => api.createGitHubTokenProvider({ token: "bad\nvalue" }), /opaque/);
  assert.equal(
    await api
      .createGitHubTokenProvider({
        auth: "token",
        environment: { ...appEnvironment, GH_TOKEN: "pat" },
      })
      .getToken(),
    "pat",
  );
  assert.equal(await api.createGitHubTokenProvider().getToken(), null);
  const failed = api.createGitHubTokenProvider({
    environment: { ...appEnvironment, GITHUB_APP_PRIVATE_KEY: privateKey.replaceAll("\n", "\\n") },
    fetchImpl: async () => reply({ message: "ambient-pat" }, 401),
  });
  await assert.rejects(failed.getToken(), /HTTP 401/);
  await assert.rejects(failed.verifyOrganization("acme"), /HTTP 401/);
});

test("failed renewal retains one identity, does not reuse expired tokens, and sanitizes response errors", async () => {
  let now = Date.now(),
    calls = 0;
  const provider = api.createGitHubTokenProvider({
    environment: appEnvironment,
    now: () => now,
    fetchImpl: async () => {
      calls++;
      if (calls === 1)
        return reply({
          token: "initial-secret",
          expires_at: new Date(now + 3600000).toISOString(),
          repository_selection: "all",
          permissions: {},
        });
      return reply({}, 403);
    },
  });
  assert.equal(await provider.getToken(), "initial-secret");
  now += 3600000;
  const attempts = await Promise.allSettled(Array.from({ length: 10 }, () => provider.getToken()));
  assert.equal(calls, 2);
  assert.ok(
    attempts.every(
      (attempt) => attempt.status === "rejected" && /HTTP 403/.test(attempt.reason.message),
    ),
  );
  const malformed = api.createGitHubTokenProvider({
    environment: appEnvironment,
    fetchImpl: async () => new Response('{"token":"unrecognized-secret", BROKEN'),
  });
  await assert.rejects(
    malformed.getToken(),
    (error) => /invalid JSON/.test(error.message) && !error.message.includes("unrecognized-secret"),
  );
  const huge = api.createGitHubTokenProvider({
    environment: appEnvironment,
    fetchImpl: async () => new Response("x".repeat(1048577)),
  });
  await assert.rejects(huge.getToken(), /1 MiB/);
});

test("scan workers receive refreshed opaque tokens and progress never leaks them", async () => {
  const received = [],
    progress = [];
  const provider = api.createGitHubTokenProvider({ token: "scan-secret" });
  const result = await api.scanOrganization("acme", {
    tokenProvider: provider,
    repositoryAttempts: 1,
    repositoryInclude: ["api*"],
    fetchImpl: async () =>
      reply(
        ["api", "other"].map((name, index) => ({
          id: index + 1,
          name,
          full_name: `acme/${name}`,
          default_branch: "main",
          size: 1,
        })),
      ),
    onProgress: (event) => progress.push(event),
    scanRepositoryImpl: (_repository, options) => {
      received.push(options.githubToken);
      assert.equal(options.privateKey, undefined);
      assert.equal(options.tokenProvider, undefined);
      options.onProgress({ phase: "scan-secret" });
      throw new Error(
        "failure scan-secret " + Buffer.from("x-access-token:scan-secret").toString("base64"),
      );
    },
  });
  assert.deepEqual(received, ["scan-secret"]);
  assert.doesNotMatch(JSON.stringify({ result, progress }), /scan-secret/);
  assert.match(JSON.stringify(progress), /REDACTED/);
});

test("installation enumeration preserves filters, pagination, and selected-access coverage", async () => {
  const urls = [];
  const provider = {
    mode: "github-app",
    getToken: async () => "installation",
    verifyOrganization: async () => ({ repositorySelection: "selected", authenticated: true }),
    redact: String,
  };
  const result = await api.listOrganizationRepositories("acme", {
    tokenProvider: provider,
    include: ["api*"],
    fetchImpl: async (url) => {
      urls.push(String(url));
      return reply({
        total_count: 2,
        repositories: ["api", "other"].map((name, index) => ({
          id: index + 1,
          name,
          full_name: `acme/${name}`,
          default_branch: "main",
          size: 1,
        })),
      });
    },
  });
  assert.match(urls[0], /\/installation\/repositories/);
  assert.equal(result.coverage.organizationAccessComplete, false);
  assert.equal(result.coverage.visibility, "installation-accessible");
});

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function fixture(t, multiple = false) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "recon-git-workflow-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source"),
    inventory = path.join(temp, "inventory");
  fs.mkdirSync(source);
  fs.mkdirSync(inventory);
  writeJson(path.join(source, "package.json"), {
    name: "api",
    version: "1.0.0",
    dependencies: { express: "^5" },
  });
  fs.writeFileSync(
    path.join(source, "app.js"),
    'const express = require("express");\nconst app = express();\napp.get("/health", (req, res) => res.json({ ok: true }));\nmodule.exports = app;\n',
  );
  if (multiple)
    fs.writeFileSync(
      path.join(source, "other.js"),
      'const express = require("express");\nconst other = express();\nother.get("/other", (req, res) => res.end());\nmodule.exports = other;\n',
    );
  git(source, "init", "-b", "main");
  git(source, "config", "user.email", "test@example.invalid");
  git(source, "config", "user.name", "Test");
  git(source, "remote", "add", "origin", "https://github.com/acme/api.git");
  git(source, "add", ".");
  git(source, "commit", "-m", "fixture");
  const report = await api.scanOrganization("acme", {
    config: {},
    scan: {},
    retainScans: false,
    fetchImpl: async () =>
      reply([{ id: 1, name: "api", full_name: "acme/api", default_branch: "main", size: 1 }]),
    scanRepositoryImpl: () => api.scanRepository(source),
    onRepository: (payload) =>
      writeRepositoryArtifacts(inventory, payload.repository, payload.scan),
  });
  writeJson(path.join(inventory, "organization-inventory.json"), report);
  return { temp, source, inventory, report, workspace: path.join(inventory, "workspaces", "api") };
}

test("Git inventory prepares, accepts, relocates, validates and renders enrichment without source", async (t) => {
  const f = await fixture(t);
  api.prepareWorkspaces({
    input: f.inventory,
    repository: "api",
    root: f.source,
    output: f.workspace,
  });
  const initial = api.loadRefreshWorkspace(f.workspace);
  assert.equal(initial.manifest.provenance.commit, git(f.source, "rev-parse", "HEAD"));
  const edited = initial.openapi;
  edited.paths["/health"].get.summary = "Accepted health documentation";
  writeJson(path.join(f.workspace, "openapi.json"), edited);
  assert.throws(() => api.loadSavedState(f.workspace), /integrity|modified|changed|hash/i);
  const accepted = api.refreshSourceWorkspace({
    root: f.source,
    output: f.workspace,
    acceptEnrichment: true,
  });
  assert.deepEqual(api.loadRefreshWorkspace(f.workspace).generated, initial.generated);
  assert.equal(
    accepted.enrichmentSummary.staleOperations,
    0,
    JSON.stringify(accepted.enrichmentSummary),
  );
  const moved = path.join(f.temp, "relocated-source");
  fs.renameSync(f.source, moved);
  fs.appendFileSync(path.join(moved, "app.js"), '\napp.get("/uncommitted", () => {});\n');
  fs.writeFileSync(
    path.join(moved, "untracked.js"),
    'const express = require("express"); const app = express(); app.get("/unexpected", () => {});',
  );
  api.refreshSourceWorkspace({ root: moved, output: f.workspace });
  assert.equal(api.loadRefreshWorkspace(f.workspace).openapi.paths["/uncommitted"], undefined);
  git(moved, "add", "app.js");
  git(moved, "commit", "-m", "different commit");
  const before = fs.readFileSync(path.join(f.workspace, "refresh-manifest.json"), "utf8");
  assert.throws(
    () => api.refreshSourceWorkspace({ root: moved, output: f.workspace }),
    /revision differs/,
  );
  assert.equal(fs.readFileSync(path.join(f.workspace, "refresh-manifest.json"), "utf8"), before);
  fs.rmSync(moved, { recursive: true, force: true });
  assert.equal(api.loadSavedState(f.workspace).kind, "refresh-workspace");
  assert.equal(api.loadSavedState(f.inventory).scans.size, 1);
  const html = path.join(f.temp, "html");
  api.renderHtmlSite(f.inventory, html, { sharedAssets: true });
  assert.equal(api.checkHtmlSite(f.inventory, html, { sharedAssets: true }).current, true);
  const page = fs.readFileSync(path.join(html, "openapi", "index.html"), "utf8");
  assert.match(page, /Accepted health documentation/);
  assert.equal(page.endsWith("\n"), true);
  assert.doesNotMatch(page, /[\t ]+$/m);
  fs.appendFileSync(path.join(html, "index.html"), "outdated");
  const mtime = fs.statSync(path.join(html, "index.html")).mtimeMs;
  assert.equal(api.checkHtmlSite(f.inventory, html, { sharedAssets: true }).current, false);
  assert.equal(fs.statSync(path.join(html, "index.html")).mtimeMs, mtime);
});

test("multiple applications get stable independent workspace identities", async (t) => {
  const f = await fixture(t, true);
  assert.throws(
    () =>
      api.prepareWorkspaces({
        input: f.inventory,
        repository: "api",
        root: f.source,
        output: f.workspace,
      }),
    /Select an application/,
  );
  const result = api.prepareWorkspaces({
    input: f.inventory,
    repository: "acme/api",
    applicationId: "all",
    root: f.source,
    output: f.workspace,
  });
  assert.equal(result.workspaces.length, 2);
  const identities = result.workspaces.map(
    (item) => api.loadRefreshWorkspace(item.output).manifest.provenance.applicationId,
  );
  assert.equal(new Set(identities).size, 2);
});

test("native settings changes stay stale across refreshes and render as needing review", async (t) => {
  const f = await fixture(t);
  const prepare = { input: f.inventory, repository: "api", root: f.source, output: f.workspace };
  api.prepareWorkspaces(prepare);
  const doc = readJson(path.join(f.workspace, "openapi.json"));
  doc.paths["/health"].get.summary = "Saved review";
  writeJson(path.join(f.workspace, "openapi.json"), doc);
  api.refreshSourceWorkspace({ root: f.source, output: f.workspace, acceptEnrichment: true });
  const changed = api.prepareWorkspaces({
    ...prepare,
    scanSettings: { config: {}, scan: { includeTests: true } },
  });
  assert.equal(changed.workspaces[0].enrichmentSummary.staleOperations, 1);
  assert.equal(
    api.refreshSourceWorkspace({ root: f.source, output: f.workspace }).enrichmentSummary
      .staleOperations,
    1,
  );
  const output = path.join(f.temp, "site");
  api.renderHtmlSite(f.inventory, output);
  assert.match(
    fs.readFileSync(path.join(output, "repositories", "api.html"), "utf8"),
    /scan-settings-changed/,
  );
  const old = fs.readFileSync(path.join(output, "index.html"), "utf8");
  fs.appendFileSync(path.join(f.workspace, "source.json"), "corrupted");
  assert.throws(() => api.renderHtmlSite(f.inventory, output), /Invalid enrichment workspace/);
  assert.equal(fs.readFileSync(path.join(output, "index.html"), "utf8"), old);
});

test("offline validation checks complete hashes, references, contracts and never writes", async (t) => {
  const f = await fixture(t);
  const saved = require("../src/saved-state");
  assert.equal(api.loadOrganizationInventory(f.inventory).validation.integrity, "legacy-unhashed");
  saved.writeOrganizationManifest(f.inventory, f.report);
  assert.equal(api.loadOrganizationInventory(f.inventory).validation.integrity, "verified");
  api.prepareWorkspaces({
    input: f.inventory,
    repository: "api",
    root: f.source,
    output: f.workspace,
  });
  const output = path.join(f.temp, "site");
  api.renderHtmlSite(f.inventory, output);
  const methods = ["writeFileSync", "mkdirSync", "mkdtempSync", "renameSync", "rmSync"];
  for (const name of methods)
    t.mock.method(fs, name, () => {
      throw new Error(`Unexpected write: ${name}`);
    });
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected network access");
  });
  try {
    api.loadSavedState(f.inventory);
    api.loadSavedState(f.workspace);
    assert.equal(api.checkHtmlSite(f.inventory, output).current, true);
    assert.equal(
      api.checkHtmlSite(f.inventory, path.join(f.temp, "missing", "site")).current,
      false,
    );
  } finally {
    t.mock.restoreAll();
  }
  const routesFile = path.join(f.inventory, f.report.repositories[0].artifacts.routes);
  fs.appendFileSync(routesFile, " ");
  assert.throws(() => api.loadSavedState(f.inventory), /integrity check/);
  assert.throws(
    () => saved.validateReferences({ $ref: "https://example.test/spec" }),
    /self-contained/,
  );
  assert.throws(() => saved.validateReferences({ $ref: "#/missing" }), /Unresolved/);
  assert.throws(() => saved.containedFile(f.inventory, "../outside"), /safe relative/);
  saved.validateReferences({ definitions: { "a/b": {} }, $ref: "#/definitions/a~1b" });
  saved.validateReferences({ definitions: { item: { $anchor: "item" } }, $ref: "#item" });
  assert.throws(() => saved.validateReferences({ $ref: "#missing" }), /Unresolved/);
  assert.throws(() => saved.validateReferences({ $ref: "#/bad~escape" }), /pointer escape/);
  const contracts = require("../src/saved-state-schema");
  assert.throws(() => contracts.validateSavedToolVersion("999.0.0"), /newer/);
  assert.throws(() => contracts.validateSavedToolVersion("invalid"), /Invalid/);
  assert.throws(() => contracts.validateSavedContract("source", {}), /schema/);
  contracts.validateSavedToolVersion("0.1.0");
});

test("native prepare, refresh, validate and deterministic rendering are supported by the CLI", async (t) => {
  const f = await fixture(t);
  const cli = (...args) =>
    spawnSync(process.execPath, [path.join(__dirname, "../src/cli.js"), ...args], {
      encoding: "utf8",
      env: credentialFreeEnvironment(),
    });
  const prepared = cli(
    "prepare",
    "--input",
    f.inventory,
    "--repo",
    "acme/api",
    "--src",
    f.source,
    "--out",
    f.workspace,
  );
  assert.equal(prepared.status, 0, prepared.stderr);
  const refreshed = cli(
    "refresh",
    "--src",
    f.source,
    "--out",
    f.workspace,
    "--fail-on",
    "enrichment-unreviewed",
  );
  assert.equal(refreshed.status, 2, refreshed.stderr);
  const validated = cli("validate", "--input", f.workspace);
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(JSON.parse(validated.stdout).validation.integrity, "verified");
  const output = path.join(f.temp, "site");
  const rendered = cli(
    "render",
    "--input",
    f.inventory,
    "--out",
    output,
    "--workspaces",
    f.workspace,
    "--shared-assets",
  );
  assert.equal(rendered.status, 0, rendered.stderr);
  const checked = cli(
    "render",
    "--input",
    f.inventory,
    "--out",
    output,
    "--workspaces",
    f.workspace,
    "--shared-assets",
    "--check",
  );
  assert.equal(checked.status, 0, checked.stderr);
  fs.appendFileSync(path.join(output, "index.html"), "outdated");
  assert.equal(
    cli("render", "--input", f.inventory, "--out", output, "--shared-assets", "--check").status,
    2,
  );
  const override = cli("refresh", "--src", f.source, "--out", f.workspace, "--include-tests");
  assert.equal(override.status, 1);
  assert.match(override.stderr, /saved source settings/);
});

test("offline incomplete inventory validation checks checkpoint scope, files and commits", async (t) => {
  const f = await fixture(t);
  const checkpoints = require("../src/organization-checkpoint");
  const entry = f.report.repositories[0];
  const scan = readJson(path.join(f.inventory, entry.artifacts.repositoryScan));
  const identity = checkpoints.organizationCheckpointIdentity("acme", {
    ...f.report.scope,
    config: f.report.scanSettings.config,
    scan: f.report.scanSettings.scan,
  });
  const checkpoint = checkpoints.initialCheckpoint("acme", identity);
  checkpoint.completed = [
    checkpoints.checkpointEntry({ ...entry, scan }, entry.artifacts, f.inventory),
  ];
  const file = path.join(f.inventory, "organization-checkpoint.json");
  writeJson(file, checkpoint);
  assert.equal(api.loadSavedState(f.inventory).scans.size, 1);
  const wrong = structuredClone(checkpoint);
  wrong.completed[0].files = [];
  writeJson(file, wrong);
  assert.throws(() => api.loadSavedState(f.inventory), /integrity records/);
  wrong.completed[0].files = checkpoint.completed[0].files;
  wrong.completed[0].commit = "f".repeat(40);
  writeJson(file, wrong);
  assert.throws(() => api.loadSavedState(f.inventory), /repository evidence differs/);
  wrong.scope.configHash = "0".repeat(64);
  writeJson(file, wrong);
  assert.throws(() => api.loadSavedState(f.inventory), /scope differs/);
});

test("semantic evidence ignores comments and formatting but preserves docs and JSON business fields", () => {
  const hash = (file, text) => semanticSourceHash(file, Buffer.from(text));
  assert.equal(hash("app.js", "const x = 1;"), hash("app.js", "// ordinary comment\nconst x=1;\n"));
  assert.notEqual(
    hash("app.js", "const x = 1;"),
    hash("app.js", "/** documentation */\nconst x=1;"),
  );
  assert.notEqual(hash("app.js", "const x = 1;"), hash("app.js", "const x = 2;"));
  assert.equal(hash("data.json", '{"a":1,"b":2}'), hash("data.json", '{ "b": 2, "a": 1 }'));
  assert.notEqual(hash("data.json", '{"start":1}'), hash("data.json", '{"start":2}'));
  assert.notEqual(hash("unknown.txt", "first"), hash("unknown.txt", "second"));
});
