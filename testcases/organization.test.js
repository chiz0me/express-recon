"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { PassThrough } = require("node:stream");

const {
  listOrganizationRepositories,
  scanRepositoryInWorker,
  scanOrganization,
  validateOrganization,
} = require("../src/organization");
const { githubGitConfig, normalizeRepository } = require("../src/repository");
const {
  defaultOrganizationOutput,
  normalizeOrganizationOutputChoice,
  resolveExecutionContext,
  resolveOrganizationOutputArgs,
  resolveOrganizationProgressMode,
  runScanOrganization,
} = require("../src/cli");

const CLI = path.join(__dirname, "..", "src", "cli.js");
const REPOSITORY_FIXTURE = path.join(__dirname, "fixtures", "repository-app");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function repository(name, overrides = {}) {
  return {
    id: name.length,
    name,
    full_name: `acme/${name}`,
    default_branch: "main",
    private: false,
    visibility: "public",
    archived: false,
    disabled: false,
    fork: false,
    size: 10,
    ...overrides,
  };
}

function response(value, options = {}) {
  const headers = Object.fromEntries(
    Object.entries(options.headers || {}).map(([key, item]) => [key.toLowerCase(), String(item)]),
  );
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return {
    ok: options.status === undefined || (options.status >= 200 && options.status < 300),
    status: options.status || 200,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => text,
  };
}

function fakeApi(repositories, calls = []) {
  return async (url, options) => {
    calls.push({ url: new URL(url), options });
    return response(repositories, {
      headers: {
        "x-ratelimit-limit": 60,
        "x-ratelimit-remaining": 59,
        "x-ratelimit-reset": 2_000_000_000,
      },
    });
  };
}

function scanResult(fullName, options = {}) {
  const complete = options.complete !== false;
  const express = options.express === true;
  const applicationId = express ? "app:src/app.js#app" : null;
  return {
    kind: "repository-scan",
    repository: {
      source: `https://github.com/${fullName}`,
      commit: "a".repeat(40),
      acquisition: { complete },
    },
    discovery: {
      packages: express
        ? [
            {
              id: "package:.",
              root: ".",
              name: fullName.split("/")[1],
              version: "1.0.0",
              express: { field: "dependencies", range: "^5.0.0" },
            },
          ]
        : [],
      applications: express ? [{ id: applicationId, source: { file: "src/app.js", line: 1 } }] : [],
      documentation: { specifications: [], jsdoc: [] },
      discoveryCoverage: { complete },
      scanCoverage: { complete },
    },
    inventory: {
      command: options.audit === false ? "inventory" : "audit",
      routes: express
        ? [
            {
              applicationId,
              method: "GET",
              path: "/health",
              middlewares: [],
              source: { file: "src/app.js", line: 2 },
            },
          ]
        : [],
      scanCoverage: { complete },
      summary: express
        ? {
            routes: 1,
            public: 1,
            unknown: 0,
            proven: 0,
            accepted: 0,
            policyViolations: 0,
          }
        : { routes: 0, public: 0, unknown: 0, proven: 0, accepted: 0 },
    },
    documentation: { status: "needs-input" },
  };
}

function resumeEvidence(detected = true) {
  return {
    detected,
    packageCount: detected ? 1 : 0,
    packages: detected ? [{ id: "package:.", root: ".", name: "api", version: "1" }] : [],
    applicationCount: detected ? 1 : 0,
    routeCount: detected ? 1 : 0,
    documentation: { specifications: 0, jsdocSources: 0, reconciliationStatus: "needs-input" },
  };
}

function emptyOrganizationResult() {
  return {
    kind: "github-organization-inventory",
    coverage: { complete: true },
    summary: {
      repositoriesResumed: 0,
      expressRepositories: 0,
      failedRepositories: 0,
      inconclusiveRepositories: 0,
    },
    repositories: [],
  };
}

test("execution context selects safe organization progress defaults with explicit overrides", () => {
  assert.equal(resolveExecutionContext({}), "auto");
  assert.equal(resolveExecutionContext({ EXPRESS_RECON_CONTEXT: " Agent " }), "agent");
  assert.equal(resolveExecutionContext({ EXPRESS_RECON_CONTEXT: "ci" }), "ci");
  assert.throws(
    () => resolveExecutionContext({ EXPRESS_RECON_CONTEXT: "robot" }),
    /must be agent, auto, ci, or interactive/,
  );

  const implicit = { progress: "auto", provided: new Set() };
  assert.equal(resolveOrganizationProgressMode(implicit, "agent"), "none");
  assert.equal(resolveOrganizationProgressMode(implicit, "ci"), "plain");
  assert.equal(resolveOrganizationProgressMode(implicit, "interactive"), "auto");
  assert.equal(resolveOrganizationProgressMode(implicit, "auto"), "auto");
  assert.equal(
    resolveOrganizationProgressMode(
      { progress: "json", provided: new Set(["--progress"]) },
      "agent",
    ),
    "json",
  );
  assert.equal(
    resolveOrganizationProgressMode(
      { progress: "none", provided: new Set(["--no-progress"]) },
      "ci",
    ),
    "none",
  );
});

test("agent organization scans use a durable default output and stay quiet", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-agent-context-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const output = path.join(fs.realpathSync(workspace), ".express-recon", "acme");
  let stderr = "";
  let scans = 0;
  try {
    assert.equal(defaultOrganizationOutput("AcMe", workspace), output);
    const code = await runScanOrganization(
      { org: "AcMe", progress: "auto", provided: new Set() },
      {
        cwd: workspace,
        environment: { EXPRESS_RECON_CONTEXT: "agent" },
        progressStream: {
          write(value) {
            stderr += value;
            return true;
          },
        },
        async scanOrganization(_organization, options) {
          scans++;
          assert.equal(options.retainScans, false);
          assert.equal(typeof options.onRepository, "function");
          return emptyOrganizationResult();
        },
      },
    );
    assert.equal(code, 0);
    assert.equal(scans, 1);
    assert.equal(stderr, "");
    assert.ok(fs.existsSync(path.join(output, "organization-inventory.json")));

    await assert.rejects(
      runScanOrganization(
        { org: "acme", progress: "auto", provided: new Set() },
        {
          cwd: workspace,
          environment: { EXPRESS_RECON_CONTEXT: "agent" },
          async scanOrganization() {
            scans++;
            return emptyOrganizationResult();
          },
        },
      ),
      /--overwrite.*No files were changed/,
    );
    assert.equal(scans, 1);

    const overwritten = await runScanOrganization(
      {
        org: "acme",
        overwrite: true,
        progress: "auto",
        provided: new Set(["--overwrite"]),
      },
      {
        cwd: workspace,
        environment: { EXPRESS_RECON_CONTEXT: "agent" },
        async scanOrganization() {
          scans++;
          return emptyOrganizationResult();
        },
      },
    );
    assert.equal(overwritten, 0);
    assert.equal(scans, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("default organization output refuses a symbolic .express-recon root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-org-default-link-"));
  const workspace = path.join(root, "workspace");
  const blockedWorkspace = path.join(root, "blocked-workspace");
  const outside = path.join(root, "outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(blockedWorkspace);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(workspace, ".express-recon"), "dir");
  fs.writeFileSync(path.join(blockedWorkspace, ".express-recon"), "not a directory");
  try {
    assert.throws(() => defaultOrganizationOutput("acme", workspace), /symbolic \.express-recon/);
    assert.throws(
      () => defaultOrganizationOutput("acme", blockedWorkspace),
      /non-directory.*\.express-recon/,
    );
    assert.throws(
      () => defaultOrganizationOutput("acme", path.join(root, "missing")),
      /Could not resolve the scan-org working directory/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the default organization output supports checkpoint resume without --out", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-org-default-resume-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const output = defaultOrganizationOutput("acme", workspace);
  let scans = 0;
  try {
    await assert.rejects(
      runScanOrganization(
        { org: "acme", progress: "none", provided: new Set(["--progress"]) },
        {
          cwd: workspace,
          environment: { EXPRESS_RECON_CONTEXT: "agent" },
          async scanOrganization() {
            scans++;
            throw new Error("interrupted after checkpoint creation");
          },
        },
      ),
      /interrupted after checkpoint creation/,
    );
    assert.ok(fs.existsSync(path.join(output, "organization-checkpoint.json")));

    const code = await runScanOrganization(
      {
        org: "acme",
        progress: "none",
        resume: true,
        provided: new Set(["--progress", "--resume"]),
      },
      {
        cwd: workspace,
        environment: { EXPRESS_RECON_CONTEXT: "agent" },
        async scanOrganization(_organization, options) {
          scans++;
          assert.deepEqual(options.resumeEntries, []);
          return emptyOrganizationResult();
        },
      },
    );
    assert.equal(code, 0);
    assert.equal(scans, 2);
    assert.ok(fs.existsSync(path.join(output, "organization-inventory.json")));
    assert.equal(fs.existsSync(path.join(output, "organization-checkpoint.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scan-org output conflicts fail closed in automation and preserve every file", async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-org-conflict-"));
  const existing = path.join(output, "keep.txt");
  fs.writeFileSync(existing, "keep me");
  let scans = 0;
  try {
    await assert.rejects(
      runScanOrganization(
        { org: "acme", out: output, progress: "auto", provided: new Set() },
        {
          environment: { EXPRESS_RECON_CONTEXT: "agent" },
          async scanOrganization() {
            scans++;
            return emptyOrganizationResult();
          },
        },
      ),
      /--overwrite.*No files were changed/,
    );
    assert.equal(scans, 0);
    assert.equal(fs.readFileSync(existing, "utf8"), "keep me");
    assert.equal(fs.existsSync(path.join(output, "organization-checkpoint.json")), false);

    await assert.rejects(
      runScanOrganization(
        {
          org: "acme",
          out: output,
          resume: true,
          progress: "auto",
          provided: new Set(["--resume"]),
        },
        {
          environment: { EXPRESS_RECON_CONTEXT: "ci" },
          async scanOrganization() {
            scans++;
            return emptyOrganizationResult();
          },
        },
      ),
      /--resume could not find organization-checkpoint\.json/,
    );
    assert.equal(scans, 0);
    assert.equal(fs.readFileSync(existing, "utf8"), "keep me");

    await assert.rejects(
      runScanOrganization(
        { org: "acme", out: output, progress: "auto", provided: new Set() },
        {
          environment: {},
          outputConflictPrompt(state) {
            assert.equal(state.hasCheckpoint, false);
            return "cancel";
          },
          async scanOrganization() {
            scans++;
            return emptyOrganizationResult();
          },
        },
      ),
      /cancelled; no files were changed/,
    );
    assert.equal(scans, 0);
    assert.equal(fs.readFileSync(existing, "utf8"), "keep me");
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test("scan-org refuses unsafe generated output directories before enumeration", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-org-output-link-"));
  const output = path.join(root, "output");
  const outside = path.join(root, "outside");
  fs.mkdirSync(output);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(output, "repositories"), "dir");
  let scans = 0;
  try {
    await assert.rejects(
      runScanOrganization(
        {
          org: "acme",
          out: output,
          overwrite: true,
          progress: "auto",
          provided: new Set(["--overwrite"]),
        },
        {
          environment: { EXPRESS_RECON_CONTEXT: "agent" },
          async scanOrganization() {
            scans++;
            return emptyOrganizationResult();
          },
        },
      ),
      /artifact must be a regular directory.*No files were changed/,
    );
    assert.equal(scans, 0);
    assert.deepEqual(fs.readdirSync(outside), []);

    const linkedOutput = path.join(root, "linked-output");
    fs.symlinkSync(outside, linkedOutput, "dir");
    await assert.rejects(
      runScanOrganization(
        {
          org: "acme",
          out: linkedOutput,
          overwrite: true,
          progress: "auto",
          provided: new Set(["--overwrite"]),
        },
        {
          environment: { EXPRESS_RECON_CONTEXT: "agent" },
          async scanOrganization() {
            scans++;
            return emptyOrganizationResult();
          },
        },
      ),
      /scan output is not a directory/,
    );
    assert.equal(scans, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scan-org interactive overwrite starts fresh without deleting unrelated files", async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-org-overwrite-"));
  const existing = path.join(output, "keep.txt");
  fs.writeFileSync(existing, "keep me");
  let prompts = 0;
  let scans = 0;
  try {
    const code = await runScanOrganization(
      { org: "acme", out: output, progress: "auto", provided: new Set() },
      {
        environment: {},
        outputConflictPrompt(state) {
          prompts++;
          assert.equal(state.entries, 1);
          assert.equal(state.hasCheckpoint, false);
          assert.equal(state.hasInventory, false);
          return "overwrite";
        },
        async scanOrganization() {
          scans++;
          return emptyOrganizationResult();
        },
      },
    );
    assert.equal(code, 0);
    assert.equal(prompts, 1);
    assert.equal(scans, 1);
    assert.equal(fs.readFileSync(existing, "utf8"), "keep me");
    assert.ok(fs.existsSync(path.join(output, "organization-inventory.json")));
    fs.writeFileSync(path.join(output, "organization-delta.json"), "stale\n");

    const overwritten = await runScanOrganization(
      {
        org: "acme",
        out: output,
        overwrite: true,
        progress: "auto",
        provided: new Set(["--overwrite"]),
      },
      {
        environment: { EXPRESS_RECON_CONTEXT: "ci" },
        outputConflictPrompt() {
          throw new Error("explicit overwrite unexpectedly prompted");
        },
        async scanOrganization() {
          scans++;
          return emptyOrganizationResult();
        },
      },
    );
    assert.equal(overwritten, 0);
    assert.equal(scans, 2);
    assert.equal(fs.readFileSync(existing, "utf8"), "keep me");
    assert.equal(fs.existsSync(path.join(output, "organization-delta.json")), false);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test("organization output choices accept clear aliases and cancel by default", () => {
  assert.equal(normalizeOrganizationOutputChoice("r"), "resume");
  assert.equal(normalizeOrganizationOutputChoice(" Resume "), "resume");
  assert.equal(normalizeOrganizationOutputChoice("o"), "overwrite");
  assert.equal(normalizeOrganizationOutputChoice("overwrite"), "overwrite");
  assert.equal(normalizeOrganizationOutputChoice(""), "cancel");
  assert.equal(normalizeOrganizationOutputChoice("no"), "cancel");
  assert.equal(normalizeOrganizationOutputChoice("maybe"), null);
});

test("the terminal output prompt explains invalid choices before accepting overwrite", async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-org-prompt-"));
  const input = new PassThrough();
  const stderr = new PassThrough();
  input.isTTY = true;
  stderr.isTTY = true;
  stderr.columns = 120;
  let prompt = "";
  stderr.on("data", (chunk) => {
    prompt += chunk.toString();
  });
  fs.writeFileSync(path.join(output, "keep.txt"), "keep me");
  try {
    const resolved = resolveOrganizationOutputArgs(
      { out: output, progress: "auto", provided: new Set() },
      { stdin: input, stderr },
      "auto",
    );
    setImmediate(() => {
      input.write("maybe\n");
      setImmediate(() => {
        input.write("r\n");
        setImmediate(() => input.end("o\n"));
      });
    });
    const args = await resolved;
    assert.equal(args.overwrite, true);
    assert.equal(args.resume, false);
    assert.ok(args.provided.has("--overwrite"));
    assert.match(prompt, /No checkpoint is available/);
    assert.match(prompt, /Enter overwrite or cancel/);
    assert.match(prompt, /Resume is unavailable/);
    assert.equal(fs.readFileSync(path.join(output, "keep.txt"), "utf8"), "keep me");
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test("GitHub organization enumeration follows pagination and sends versioned auth", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), options });
    const page = new URL(url).searchParams.get("page");
    if (page === "1") {
      return response([repository("z-api")], {
        headers: {
          link: '<https://api.github.com/organizations/1/repos?page=2>; rel="next"',
          "x-ratelimit-limit": 5_000,
          "x-ratelimit-remaining": 4_999,
        },
      });
    }
    return response([repository("a-api", { private: true, visibility: "private" })], {
      headers: { "x-ratelimit-limit": 5_000, "x-ratelimit-remaining": 4_998 },
    });
  };

  const result = await listOrganizationRepositories("acme", {
    token: "token-for-test",
    fetchImpl,
    onPage() {
      throw new Error("observer failure must not stop pagination");
    },
  });
  assert.deepEqual(
    result.repositories.map((item) => item.fullName),
    ["acme/a-api", "acme/z-api"],
  );
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.pagesFetched, 2);
  assert.equal(result.coverage.authenticated, true);
  assert.equal(result.rateLimit.remaining, 4_998);
  assert.equal(calls[0].options.headers.Authorization, "Bearer token-for-test");
  assert.equal(calls[0].options.headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.equal(calls[0].url.searchParams.get("per_page"), "100");
  assert.doesNotMatch(JSON.stringify(result), /token-for-test/);
});

test("organization scans isolate failures, classify incomplete negatives, and honor concurrency", async () => {
  const repositories = [
    repository("active-express"),
    repository("active-failure"),
    repository("active-non-express"),
    repository("active-partial"),
    repository("archived", { archived: true }),
    repository("empty", { size: 0, default_branch: null }),
    repository("fork", { fork: true }),
  ];
  let active = 0;
  let peak = 0;
  const persisted = [];
  const scanner = async (source) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    if (source.endsWith("active-failure")) throw new Error("clone rejected token-for-test");
    const scan = scanResult(source, {
      express: source.endsWith("active-express"),
      complete: !source.endsWith("active-partial"),
    });
    if (source.endsWith("active-express")) {
      scan.discovery.documentation.specifications = [
        { path: "docs/openapi.json", format: "openapi", version: "3.1.0" },
      ];
      scan.documentation = {
        status: "cataloged",
        summary: { available: 1, openapi: 1, swagger: 0, reconciled: 0 },
      };
    }
    return scan;
  };
  const result = await scanOrganization("acme", {
    token: "token-for-test",
    fetchImpl: fakeApi(repositories),
    scanRepositoryImpl: scanner,
    concurrency: 2,
    retainScans: false,
    onRepository({ repository: item }) {
      persisted.push(item.fullName);
      return { repositoryScan: `repositories/${item.name}/repo-scan.json` };
    },
  });

  assert.equal(peak, 2);
  assert.equal(result.scope.concurrency, 2);
  assert.match(result.scope.fingerprint, /^[a-f0-9]{64}$/);
  assert.match(result.scope.configHash, /^[a-f0-9]{64}$/);
  assert.match(result.scope.scanHash, /^[a-f0-9]{64}$/);
  assert.equal(result.summary.repositoriesScanned, 3);
  assert.equal(result.summary.expressRepositories, 1);
  assert.equal(result.summary.nonExpressRepositories, 1);
  assert.equal(result.summary.inconclusiveRepositories, 1);
  assert.equal(result.summary.failedRepositories, 1);
  assert.equal(result.summary.skippedArchived, 1);
  assert.equal(result.summary.skippedForks, 1);
  assert.equal(result.summary.emptyRepositories, 1);
  assert.equal(result.summary.applications, 1);
  assert.equal(result.summary.routes, 1);
  assert.equal(result.summary.specificationRepositories, 1);
  assert.equal(result.summary.apiSpecifications, 1);
  assert.equal(result.summary.openapiSpecifications, 1);
  assert.equal(result.summary.swaggerSpecifications, 0);
  assert.equal(result.summary.catalogedRepositories, 1);
  assert.deepEqual(result.summary.auth, {
    public: 1,
    unknown: 0,
    proven: 0,
    accepted: 0,
    policyViolations: 0,
  });
  assert.equal(result.coverage.complete, false);
  assert.ok(result.coverage.incompleteRepositories.includes("acme/active-failure"));
  assert.ok(result.coverage.incompleteRepositories.includes("acme/active-partial"));
  assert.deepEqual(persisted.sort(), [
    "acme/active-express",
    "acme/active-non-express",
    "acme/active-partial",
  ]);
  assert.ok(result.repositories.every((item) => item.scan === undefined));
  assert.doesNotMatch(JSON.stringify(result), /token-for-test/);
  assert.match(result.repositories.find((item) => item.status === "failed").error, /\[REDACTED\]/);
});

test("organization progress covers skips, resume, concurrent phases, failures, and completion", async () => {
  const repositories = [
    repository("archived", { archived: true }),
    repository("bad"),
    repository("good"),
    repository("resumed"),
  ];
  const events = [];
  const resumed = {
    repository: { id: "resumed".length, fullName: "acme/resumed" },
    status: "express",
    coverageComplete: true,
    express: resumeEvidence(),
    command: "audit",
    auditSummary: { public: 1 },
    commit: "b".repeat(40),
  };
  const result = await scanOrganization("acme", {
    token: "token-for-test",
    fetchImpl: fakeApi(repositories),
    concurrency: 2,
    retainScans: false,
    resumeEntries: [resumed],
    onProgress(event) {
      events.push(event);
    },
    async scanRepositoryImpl(source, options) {
      options.onProgress({ phase: "inventorying" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (source.endsWith("/bad")) throw new Error("token-for-test clone failed");
      return scanResult(source, { express: true });
    },
  });

  assert.equal(events[0].event, "enumeration-started");
  assert.equal(events.at(-1).event, "scan-finished");
  assert.ok(events.every((event) => event.kind === "organization-scan-progress"));
  assert.ok(events.every((event) => event.organization === "acme"));
  assert.ok(events.every((event) => !Number.isNaN(Date.parse(event.timestamp))));
  assert.equal(
    events.find((event) => event.event === "enumeration-page").repositoriesDiscovered,
    4,
  );
  const ready = events.find((event) => event.event === "enumeration-completed");
  assert.deepEqual(
    {
      discovered: ready.discovered,
      selected: ready.selected,
      resumed: ready.resumed,
      pending: ready.pending,
      concurrency: ready.concurrency,
    },
    { discovered: 4, selected: 3, resumed: 1, pending: 2, concurrency: 2 },
  );
  assert.equal(
    events.find((event) => event.event === "repository-skipped").status,
    "skipped-archived",
  );
  assert.equal(
    events.find((event) => event.event === "repository-resumed").repository,
    "acme/resumed",
  );
  assert.equal(events.filter((event) => event.event === "repository-phase").length, 2);
  assert.equal(
    Math.max(
      ...events
        .filter((event) => event.event === "repository-started")
        .map((event) => event.active),
    ),
    2,
  );
  const failure = events.find((event) => event.event === "repository-failed");
  assert.match(failure.error, /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(events), /token-for-test/);
  assert.equal(events.at(-1).processed, 3);
  assert.equal(events.at(-1).failed, 1);
  assert.equal(result.summary.repositoriesResumed, 1);
});

test("a failing progress observer is disabled without changing organization evidence", async () => {
  const result = await scanOrganization("acme", {
    token: "token-for-test",
    fetchImpl: fakeApi([repository("api")]),
    scanRepositoryImpl: async (source) => scanResult(source, { express: true }),
    onProgress() {
      throw new Error("observer exposed token-for-test");
    },
  });
  assert.equal(result.summary.expressRepositories, 1);
  assert.match(result.diagnostics.at(-1), /progress callback disabled/);
  assert.doesNotMatch(result.diagnostics.at(-1), /token-for-test/);
  await assert.rejects(
    scanOrganization("acme", { onProgress: true, fetchImpl: fakeApi([]) }),
    /onProgress must be a function/,
  );
  const asynchronous = await scanOrganization("acme", {
    fetchImpl: fakeApi([]),
    onProgress: async () => {},
  });
  assert.match(asynchronous.diagnostics.at(-1), /onProgress must be synchronous/);
});

test("repository limits are fail-visible and default execution is sequential", async () => {
  let active = 0;
  let peak = 0;
  const result = await scanOrganization("acme", {
    fetchImpl: fakeApi([repository("one"), repository("three"), repository("two")]),
    maxRepositories: 2,
    scanRepositoryImpl: async (source) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return scanResult(source, { express: true, audit: false });
    },
  });
  assert.equal(peak, 1);
  assert.equal(result.scope.concurrency, 1);
  assert.equal(result.summary.repositoriesScanned, 2);
  assert.equal(result.summary.skippedByLimit, 1);
  assert.equal(result.coverage.complete, false);
});

test("the real concurrency worker scans and returns a cleaned repository result", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-org-worker-"));
  try {
    fs.cpSync(REPOSITORY_FIXTURE, root, { recursive: true });
    git(root, ["init", "--quiet"]);
    git(root, ["config", "user.email", "tests@example.test"]);
    git(root, ["config", "user.name", "express-recon tests"]);
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "fixture"]);
    const phases = [];
    const result = await scanRepositoryInWorker(
      root,
      { ref: "HEAD", config: {}, scan: {} },
      (event) => phases.push(event.phase),
    );
    assert.equal(result.kind, "repository-scan");
    assert.equal(result.repository.executedTargetCode, false);
    assert.ok(result.inventory.routes.some((route) => route.path === "/health"));
    assert.deepEqual(phases, [
      "acquiring",
      "discovering",
      "inventorying",
      "documenting",
      "cleaning-up",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scan-org CLI orchestration streams detailed artifacts and writes a compact index", async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-org-output-"));
  try {
    const code = await runScanOrganization(
      {
        org: "acme",
        out: output,
        maxRepos: "5",
        concurrency: "2",
        includeArchived: false,
        includeForks: false,
        includeTests: false,
      },
      {
        environment: { GH_TOKEN: "token-for-test" },
        async scanOrganization(organization, options) {
          assert.equal(organization, "acme");
          assert.equal(options.token, "token-for-test");
          assert.equal(options.maxRepositories, 5);
          assert.equal(options.concurrency, 2);
          assert.equal(options.retainScans, false);
          const item = { name: "api", fullName: "acme/api" };
          const scan = scanResult("acme/api", { express: true });
          scan.documentation = {
            status: "merged",
            document: { openapi: "3.1.0", info: { title: "API", version: "1" }, paths: {} },
            report: { schemaVersion: "1.0", summary: {} },
            summary: {
              discovered: 2,
              available: 2,
              unavailable: 0,
              openapi: 1,
              swagger: 1,
              reconciled: 0,
              documentsRetained: true,
            },
            specifications: [
              {
                path: "docs/openapi.json",
                format: "openapi",
                version: "3.1.0",
                title: "Source API",
                status: "available",
                document: {
                  openapi: "3.1.0",
                  info: { title: "Source API", version: "1" },
                  paths: {},
                },
              },
              {
                path: "docs/swagger.json",
                format: "swagger",
                version: "2.0",
                title: "Legacy API",
                status: "available",
                document: {
                  swagger: "2.0",
                  info: { title: "Legacy API", version: "1" },
                  paths: {},
                },
              },
            ],
          };
          const artifacts = await options.onRepository({
            repository: item,
            status: "express",
            express: resumeEvidence(),
            coverageComplete: true,
            scan,
          });
          return {
            kind: "github-organization-inventory",
            coverage: { complete: true },
            summary: { repositoriesResumed: 0 },
            repositories: [{ repository: item, status: "express", artifacts }],
          };
        },
      },
    );
    assert.equal(code, 0);
    const aggregate = JSON.parse(
      fs.readFileSync(path.join(output, "organization-inventory.json"), "utf8"),
    );
    assert.equal(aggregate.repositories[0].scan, undefined);
    assert.equal(aggregate.repositories[0].artifacts.routes, "repositories/api/routes.json");
    assert.equal(aggregate.repositories[0].artifacts.specifications.length, 2);
    assert.equal(aggregate.resume.repositoriesReused, 0);
    for (const file of [
      "repo-scan.json",
      "discovery.json",
      "routes.json",
      "openapi.json",
      "docs-report.json",
    ]) {
      assert.ok(fs.existsSync(path.join(output, "repositories", "api", file)), file);
    }
    for (const specification of aggregate.repositories[0].artifacts.specifications) {
      assert.ok(fs.existsSync(path.join(output, specification.artifact)));
    }
    const persistedScan = JSON.parse(
      fs.readFileSync(path.join(output, "repositories", "api", "repo-scan.json"), "utf8"),
    );
    assert.ok(
      persistedScan.documentation.specifications.every(
        (item) => item.status === "retained" && !Object.hasOwn(item, "document"),
      ),
    );
    assert.equal(fs.existsSync(path.join(output, "organization-checkpoint.json")), false);
    assert.doesNotMatch(
      fs.readFileSync(path.join(output, "organization-inventory.json"), "utf8"),
      /token-for-test/,
    );
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test("scan-org baseline writes bounded organization and exact route deltas", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-org-baseline-"));
  const before = path.join(root, "before");
  const current = path.join(root, "current");
  fs.mkdirSync(before);
  fs.mkdirSync(current);
  const run = (output, routes, runOptions = {}) =>
    runScanOrganization(
      {
        org: "acme",
        out: output,
        ...(runOptions.baseline ? { baseline: runOptions.baseline } : {}),
        ...(runOptions.resume ? { resume: true } : {}),
        includeArchived: false,
        includeForks: false,
        includeTests: false,
      },
      {
        environment: {},
        async scanOrganization(_organization, options) {
          const item = { id: 1, name: "api", fullName: "acme/api" };
          const scan = scanResult("acme/api", { express: true });
          scan.repository.commit = String.fromCharCode(96 + routes.length).repeat(40);
          scan.inventory.routes = routes;
          scan.inventory.summary.routes = routes.length;
          const express = { ...resumeEvidence(), routeCount: routes.length };
          const artifacts = await options.onRepository({
            repository: item,
            status: "express",
            express,
            coverageComplete: true,
            scan,
          });
          return {
            schemaVersion: "1.0",
            tool: "express-recon",
            toolVersion: "0.8.0",
            kind: "github-organization-inventory",
            organization: { login: "acme" },
            coverage: { complete: runOptions.complete !== false },
            summary: { repositoriesResumed: 0, routes: routes.length },
            repositories: [
              {
                repository: item,
                status: "express",
                commit: scan.repository.commit,
                coverageComplete: true,
                express,
                artifacts,
              },
            ],
          };
        },
      },
    );
  try {
    const stable = {
      applicationId: "app:src/app.js#app",
      method: "GET",
      path: "/health",
      authStatus: "public",
      middlewares: [],
      tags: [],
      roles: [],
      scopes: [],
    };
    assert.equal(await run(before, [stable]), 0);
    let overlapScans = 0;
    await assert.rejects(
      runScanOrganization(
        {
          org: "acme",
          out: before,
          baseline: before,
          overwrite: true,
          progress: "none",
          provided: new Set(["--baseline", "--out", "--overwrite", "--progress"]),
        },
        {
          environment: {},
          async scanOrganization() {
            overlapScans++;
            return emptyOrganizationResult();
          },
        },
      ),
      /baseline directory and --out must be separate/,
    );
    assert.equal(overlapScans, 0);
    assert.equal(
      await run(current, [stable, { ...stable, method: "POST", path: "/accounts" }], {
        baseline: before,
        complete: false,
      }),
      0,
    );
    assert.ok(fs.existsSync(path.join(current, "comparison-baseline")));
    assert.ok(fs.existsSync(path.join(current, "organization-checkpoint.json")));
    assert.equal(
      await run(
        current,
        [
          stable,
          { ...stable, method: "POST", path: "/accounts" },
          { ...stable, method: "DELETE", path: "/accounts/:id" },
        ],
        { resume: true },
      ),
      0,
    );
    const delta = JSON.parse(
      fs.readFileSync(path.join(current, "organization-delta.json"), "utf8"),
    );
    const aggregate = JSON.parse(
      fs.readFileSync(path.join(current, "organization-inventory.json"), "utf8"),
    );
    assert.equal(delta.summary.addedRoutes, 2);
    assert.equal(delta.repositories[0].changes.routes.details.addedRoutes[0].path, "/accounts");
    assert.equal(aggregate.delta.summary.addedRoutes, 2);
    assert.equal(aggregate.delta.artifact, "organization-delta.json");
    assert.equal(aggregate.delta.repositories.length, 1);
    assert.equal(fs.existsSync(path.join(current, "comparison-baseline")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scan-org JSON progress reports durable checkpoints without contaminating artifacts", async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-org-progress-"));
  let stderr = "";
  try {
    const code = await runScanOrganization(
      {
        org: "acme",
        out: output,
        progress: "json",
        includeArchived: false,
        includeForks: false,
        includeTests: false,
      },
      {
        environment: {},
        progressStream: {
          write(value) {
            stderr += value;
            return true;
          },
        },
        async scanOrganization(_organization, options) {
          const item = { id: 3, name: "api", fullName: "acme/api" };
          const scan = scanResult("acme/api", { express: true });
          options.onProgress({
            event: "enumeration-completed",
            organization: "acme",
            discovered: 1,
            selected: 1,
            resumed: 0,
            pending: 1,
            concurrency: 1,
            total: 1,
          });
          options.onProgress({
            event: "repository-started",
            organization: "acme",
            repository: "acme/api",
            processed: 0,
            total: 1,
            active: 1,
            concurrency: 1,
          });
          const artifacts = await options.onRepository({
            repository: item,
            status: "express",
            express: resumeEvidence(),
            coverageComplete: true,
            scan,
          });
          options.onProgress({
            event: "repository-completed",
            organization: "acme",
            repository: "acme/api",
            status: "express",
            processed: 1,
            total: 1,
            active: 0,
            failed: 0,
          });
          options.onProgress({
            event: "scan-finished",
            organization: "acme",
            complete: true,
            processed: 1,
            completed: 1,
            total: 1,
            failed: 0,
            expressRepositories: 1,
            failedRepositories: 0,
          });
          return {
            kind: "github-organization-inventory",
            coverage: { complete: true },
            summary: {
              repositoriesResumed: 0,
              expressRepositories: 1,
              failedRepositories: 0,
            },
            repositories: [{ repository: item, status: "express", scanned: true, artifacts }],
          };
        },
      },
    );
    assert.equal(code, 0);
    const progress = stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(progress.every((event) => event.kind === "organization-scan-progress"));
    const durable = progress.find((event) => event.event === "checkpoint-written");
    assert.equal(durable.repository, "acme/api");
    assert.equal(durable.completedRepositories, 1);
    assert.equal(durable.total, 1);
    assert.equal(progress.at(-1).event, "scan-finished");
    assert.doesNotMatch(
      fs.readFileSync(path.join(output, "organization-inventory.json"), "utf8"),
      /organization-scan-progress/,
    );
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test("scan-org JSON progress turns operational failures into redacted JSONL", async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-org-json-failure-"));
  let stderr = "";
  try {
    await assert.rejects(
      runScanOrganization(
        { org: "acme", out: output, progress: "json", includeArchived: false, includeForks: false },
        {
          environment: { GH_TOKEN: "token-for-test" },
          progressStream: {
            write(value) {
              stderr += value;
              return true;
            },
          },
          async scanOrganization() {
            throw new Error("GitHub rejected token-for-test");
          },
        },
      ),
      /token-for-test/,
    );
    const events = stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.at(-1).event, "scan-failed");
    assert.match(events.at(-1).error, /\[REDACTED\]/);
    assert.doesNotMatch(stderr, /token-for-test/);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test("scan-org progress and quiet modes preserve incomplete CI gates", async () => {
  for (const mode of ["plain", "none"]) {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), `express-recon-org-gate-${mode}-`));
    let stderr = "";
    try {
      const code = await runScanOrganization(
        {
          org: "acme",
          out: output,
          progress: mode,
          failOn: "incomplete",
          includeArchived: false,
          includeForks: false,
        },
        {
          environment: {},
          progressStream: {
            write(value) {
              stderr += value;
              return true;
            },
          },
          stderr: {
            write(value) {
              stderr += value;
              return true;
            },
          },
          async scanOrganization() {
            return {
              kind: "github-organization-inventory",
              coverage: { complete: false },
              summary: {
                repositoriesResumed: 0,
                expressRepositories: 0,
                failedRepositories: 1,
                inconclusiveRepositories: 0,
              },
              repositories: [
                {
                  repository: { name: "api", fullName: "acme/api" },
                  status: "failed",
                  scanned: false,
                  error: "clone failed",
                },
              ],
            };
          },
        },
      );
      assert.equal(code, 2);
      if (mode === "plain") {
        assert.match(stderr, /FAILED acme\/api · clone failed/);
        assert.match(stderr, /FINISHED acme · 1\/1 processed/);
        assert.match(stderr, /GATE incomplete · organization inventory is incomplete/);
        assert.ok(stderr.indexOf("FAILED acme/api") < stderr.indexOf("FINISHED acme"));
      } else {
        assert.match(stderr, /express-recon \[warn\]: acme\/api: clone failed/);
        assert.match(stderr, /express-recon: organization inventory is incomplete/);
        assert.doesNotMatch(stderr, /FINISHED/);
      }
    } finally {
      fs.rmSync(output, { recursive: true, force: true });
    }
  }
});

test("scan-org resumes valid artifacts, retries damaged work, and rejects scope changes", async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-org-resume-"));
  const args = {
    org: "acme",
    out: output,
    maxRepos: "5",
    concurrency: "1",
    includeArchived: false,
    includeForks: false,
    includeTests: false,
  };
  const items = [repository("one"), repository("two")];
  try {
    await assert.rejects(
      runScanOrganization(args, {
        environment: {},
        async scanOrganization(_organization, options) {
          for (const value of items) {
            const item = { id: value.id, name: value.name, fullName: value.full_name };
            const scan = scanResult(value.full_name, { express: true });
            await options.onRepository({
              repository: item,
              status: "express",
              express: resumeEvidence(),
              coverageComplete: true,
              scan,
            });
          }
          throw new Error("simulated process interruption");
        },
      }),
      /simulated process interruption/,
    );
    const checkpoint = path.join(output, "organization-checkpoint.json");
    assert.ok(fs.existsSync(checkpoint));

    let resumedScannerCalls = 0;
    await assert.rejects(
      runScanOrganization(
        { ...args, resume: true, include: ["src/**"] },
        {
          environment: {},
          async scanOrganization() {
            resumedScannerCalls++;
          },
        },
      ),
      /checkpoint does not match/,
    );
    assert.equal(resumedScannerCalls, 0);

    fs.appendFileSync(path.join(output, "repositories", "two", "routes.json"), "corrupt");
    const scanned = [];
    let resumePrompts = 0;
    const code = await runScanOrganization(
      { ...args, concurrency: "2" },
      {
        environment: {},
        outputConflictPrompt(state) {
          resumePrompts++;
          assert.equal(state.hasCheckpoint, true);
          assert.equal(state.hasRepositories, true);
          return "resume";
        },
        scanOrganization(organization, options) {
          return scanOrganization(organization, {
            ...options,
            fetchImpl: fakeApi(items),
            scanRepositoryImpl: async (source) => {
              scanned.push(source);
              return scanResult(source, { express: true });
            },
          });
        },
      },
    );
    assert.equal(code, 0);
    assert.equal(resumePrompts, 1);
    assert.deepEqual(scanned, ["acme/two"]);
    const aggregate = JSON.parse(
      fs.readFileSync(path.join(output, "organization-inventory.json"), "utf8"),
    );
    assert.equal(aggregate.summary.repositoriesResumed, 1);
    assert.equal(aggregate.scope.concurrency, 2);
    assert.equal(
      aggregate.repositories.find((entry) => entry.resumed).repository.fullName,
      "acme/one",
    );
    assert.equal(aggregate.resume.repositoriesReused, 1);
    assert.equal(aggregate.resume.requested, true);
    assert.equal(aggregate.resume.checkpoint, null);
    assert.equal(fs.existsSync(checkpoint), false);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test("partial API pagination returns explicit incomplete coverage", async () => {
  let page = 0;
  const result = await listOrganizationRepositories("acme", {
    token: "token-for-test",
    fetchImpl: async () => {
      page++;
      if (page === 1) {
        return response([repository("one")], {
          headers: { link: '<https://api.github.com/orgs/acme/repos?page=2>; rel="next"' },
        });
      }
      return response({ message: "rate limit exceeded for token-for-test" }, { status: 403 });
    },
  });
  assert.equal(result.repositories.length, 1);
  assert.equal(result.coverage.complete, false);
  assert.match(result.diagnostics[0], /pagination stopped at page 2/);
  assert.doesNotMatch(JSON.stringify(result), /token-for-test/);
});

test("enumeration failures emit a redacted terminal progress event", async () => {
  const events = [];
  await assert.rejects(
    scanOrganization("acme", {
      token: "token-for-test",
      fetchImpl: async () =>
        response({ message: "token-for-test is unauthorized" }, { status: 401 }),
      onProgress: (event) => events.push(event),
    }),
    /\[REDACTED\] is unauthorized/,
  );
  assert.deepEqual(
    events.map((event) => event.event),
    ["enumeration-started", "enumeration-failed"],
  );
  assert.doesNotMatch(JSON.stringify(events), /token-for-test/);
});

test("missing completeness evidence cannot prove a repository is non-Express", async () => {
  const result = await scanOrganization("acme", {
    fetchImpl: fakeApi([repository("unknown")]),
    scanRepositoryImpl: async (source) => {
      const scan = scanResult(source, { express: false });
      delete scan.inventory.scanCoverage;
      return scan;
    },
  });
  assert.equal(result.repositories[0].status, "inconclusive");
  assert.equal(result.repositories[0].coverageComplete, false);
  assert.equal(result.coverage.complete, false);
});

test("library resume entries fail closed and repository identity changes force a rescan", async () => {
  const valid = {
    repository: { id: 3, fullName: "acme/one" },
    status: "express",
    coverageComplete: true,
    express: resumeEvidence(),
    command: "audit",
    auditSummary: { public: 1 },
    commit: "a".repeat(40),
    artifacts: { repositoryScan: "repositories/one/repo-scan.json" },
  };
  for (const [resumeEntries, pattern] of [
    [{}, /must be an array/],
    [[null], /must be an object/],
    [[{ ...valid, repository: { fullName: "invalid" } }], /fullName is invalid/],
    [[{ ...valid, status: "failed" }], /not a complete resumable/],
    [[{ ...valid, express: null }], /must contain framework evidence/],
    [[{ ...valid, express: { detected: false } }], /does not match its status/],
    [[{ ...valid, command: "review" }], /command must be inventory or audit/],
    [[{ ...valid, commit: "bad" }], /commit must be a Git object id/],
    [[valid, valid], /contains duplicate/],
  ]) {
    await assert.rejects(
      scanOrganization("acme", {
        resumeEntries,
        retainScans: false,
        fetchImpl: () => {
          throw new Error("resume validation reached GitHub unexpectedly");
        },
      }),
      pattern,
    );
  }
  await assert.rejects(
    scanOrganization("acme", { resumeEntries: [valid], fetchImpl: fakeApi([]) }),
    /requires retainScans: false/,
  );

  let scans = 0;
  const changedIdentity = await scanOrganization("acme", {
    resumeEntries: [{ ...valid, repository: { ...valid.repository, id: 999 } }],
    retainScans: false,
    fetchImpl: fakeApi([repository("one")]),
    scanRepositoryImpl: async (source) => {
      scans++;
      return scanResult(source, { express: true });
    },
  });
  assert.equal(scans, 1);
  assert.equal(changedIdentity.summary.repositoriesResumed, 0);
});

test("GitHub Git authentication is scoped and does not expose plaintext in arguments", () => {
  const config = githubGitConfig(normalizeRepository("acme/private-api"), "token-for-test");
  assert.equal(config.length, 1);
  assert.equal(config[0].key, "http.https://github.com/.extraHeader");
  assert.match(config[0].value, /^Authorization: Basic /);
  assert.doesNotMatch(config[0].value, /token-for-test/);
  assert.throws(
    () => githubGitConfig(normalizeRepository("https://git.example.test/acme/api.git"), "token"),
    /scoped to github\.com/,
  );
});

test("organization and CLI limits fail before making a GitHub request", () => {
  assert.throws(() => validateOrganization("invalid/name"), /GitHub organization/);
  for (const args of [
    ["scan-org"],
    ["scan-org", "--org", "acme", "--max-repos", "0"],
    ["scan-org", "--org", "invalid/name", "--out", "unused"],
    ["scan-org", "--org", "acme", "--out", "unused", "--resume", "--resume"],
    ["scan-org", "--org", "acme", "--out", "unused", "--overwrite", "--overwrite"],
    ["scan-org", "--org", "acme", "--out", "unused", "--resume", "--overwrite"],
    ["scan-org", "--org", "acme", "--concurrency", "9"],
    ["scan-org", "--org", "acme", "--progress", "loud"],
    ["scan-org", "--org", "acme", "--progress", "plain", "--no-progress"],
    ["scan-org", "--org", "acme", "--ref", "main"],
    ["scan-org", "--org", "acme", "--fail-on", "public"],
  ]) {
    const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1, `${args.join(" ")} unexpectedly succeeded`);
    assert.ok(result.stderr.trim());
  }
});
