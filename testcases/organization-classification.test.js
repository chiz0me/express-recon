"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  classifyOrganization,
  buildScanPlan,
  loadRepositoryClassification,
  scanOrganization,
} = require("../src");
const { runClassifyOrganization, runScanOrganization } = require("../src/cli");
const SHA = "a".repeat(40);
function fixture(
  t,
  definitions = {
    app: { "package.json": '{"dependencies":{"express":"5"}}', "app.js": "" },
    go: {
      "go.mod": "module example.com/app\nrequire github.com/gin-gonic/gin v1.9.0",
      "main.go": "package main",
    },
    plain: { "README.md": "hello" },
  },
) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "recon-classification-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const state = {
    commit: SHA,
    truncated: false,
    failHead: false,
    failBlob: false,
    branch: "main",
    id: 1,
    extra: [],
    definitions,
  };
  const repositories = () =>
    Object.keys(state.definitions)
      .sort()
      .map((name, index) => ({
        id: state.id + index,
        name,
        full_name: `acme/${name}`,
        size: 1,
        default_branch: state.branch,
        pushed_at: "2026-09-18T00:00:00Z",
      }));
  const response = (value, status = 200) => ({
    ok: status === 200,
    status,
    headers: { get: () => null },
    text: async () => (typeof value === "string" ? value : JSON.stringify(value)),
  });
  const fetchImpl = async (url) => {
    url = new URL(url);
    calls.push(url.pathname);
    if (url.pathname === "/orgs/acme/repos") return response(repositories());
    if (url.pathname.includes("/commits/") && !url.pathname.includes("/git/"))
      return response(state.commit, state.failHead ? 503 : 200);
    const name = url.pathname.split("/")[3];
    const entries = Object.entries(state.definitions[name]);
    if (url.pathname.includes("/git/commits/")) return response({ tree: { sha: "b".repeat(40) } });
    if (url.pathname.includes("/git/trees/"))
      return response({
        truncated: state.truncated,
        tree: [
          ...entries.map(([file, content], i) => ({
            path: file,
            type: "blob",
            mode: "100644",
            size: Buffer.byteLength(content),
            sha: String(i + 1).padStart(40, "0"),
          })),
          ...state.extra,
        ],
      });
    if (url.pathname.includes("/git/blobs/")) {
      const content = entries[Number(url.pathname.split("/").at(-1)) - 1][1];
      return response(
        { encoding: "base64", content: Buffer.from(content).toString("base64") },
        state.failBlob ? 503 : 200,
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const options = {
    fetchImpl,
    classificationCache: path.join(root, "repository-classification.json"),
    concurrency: 2,
  };
  return { root, calls, state, options };
}

test("classifies mixed repositories and exports native immutable Gin targets", async (t) => {
  const f = fixture(t);
  f.state.definitions.mixed = {
    "api/package.json": '{"dependencies":{"web":"npm:fastify@5","@nestjs/core":"11"}}',
    "go/go.mod": "require github.com/gin-gonic/gin v1.0.0",
  };
  const catalog = await classifyOrganization("acme", f.options);
  assert.equal(catalog.coverage.complete, true);
  assert.equal(catalog.metrics.cacheMisses, 4);
  const plan = buildScanPlan(catalog);
  assert.deepEqual(
    plan.javascript.map((item) => item.repository),
    ["acme/app", "acme/mixed"],
  );
  assert.deepEqual(
    plan.gin.map((item) => item.repository),
    ["acme/go", "acme/mixed"],
  );
  assert.equal(plan.ginTargets.targets[0].git.ref, SHA);
  assert.equal(plan.ginTargets.targets[0].github.fullName, "acme/go");
  assert.deepEqual(loadRepositoryClassification(f.options.classificationCache), catalog);
  assert.deepEqual(
    catalog.repositories.find((entry) => entry.repository.name === "mixed").classification
      .frameworks,
    ["fastify", "gin", "nestjs"],
  );
});

test("warm caches check each HEAD and survive fresh route scans; changed commits invalidate negatives", async (t) => {
  const f = fixture(t, { plain: { "README.md": "hello" } });
  await classifyOrganization("acme", f.options);
  f.calls.length = 0;
  let catalog = await classifyOrganization("acme", f.options);
  assert.equal(catalog.metrics.cacheHits, 1);
  assert.deepEqual(f.calls, ["/orgs/acme/repos", "/repos/acme/plain/commits/main"]);
  f.state.commit = "c".repeat(40);
  f.state.definitions.plain["go.mod"] = "require github.com/gin-gonic/gin v1.0.0";
  catalog = await classifyOrganization("acme", f.options);
  assert.equal(catalog.metrics.invalidations.commit, 1);
  assert.equal(buildScanPlan(catalog).gin.length, 1);
  catalog = await classifyOrganization("acme", { ...f.options, reclassify: true });
  assert.equal(catalog.metrics.invalidations.forced, 1);
  f.state.branch = "release";
  catalog = await classifyOrganization("acme", f.options);
  assert.equal(catalog.metrics.invalidations.identity, 1);
  f.state.id++;
  catalog = await classifyOrganization("acme", f.options);
  assert.equal(catalog.metrics.invalidations.identity, 1);
});

test("truncated, unreadable and linked trees remain eligible and incomplete entries are retried", async (t) => {
  const f = fixture(t);
  f.state.truncated = true;
  let catalog = await classifyOrganization("acme", f.options);
  assert.equal(catalog.coverage.complete, false);
  assert.equal(buildScanPlan(catalog).gin.length, 3);
  catalog = await classifyOrganization("acme", f.options);
  assert.equal(catalog.metrics.invalidations.incomplete, 3);
  f.state.truncated = false;
  f.state.extra = [{ path: "submodule", type: "commit", mode: "160000" }];
  catalog = await classifyOrganization("acme", f.options);
  assert.equal(buildScanPlan(catalog).javascript.length, 3);
  f.state.extra = [];
  f.state.failBlob = true;
  catalog = await classifyOrganization("acme", f.options);
  assert.equal(
    catalog.repositories.find((entry) => entry.repository.name === "go").classification.complete,
    false,
  );
  f.state.failHead = true;
  catalog = await classifyOrganization("acme", f.options);
  assert.equal(catalog.metrics.invalidations["head-unavailable"], 3);
  assert.equal(buildScanPlan(catalog).gin.length, 3);
});

test("unknown Go, source-only JS and documentation remain candidates", async (t) => {
  const f = fixture(t, {
    wrapper: { "go.work": "use ./service", "service/main.go": "package main" },
    source: { "app.mts": "" },
    docs: { "api.yaml": "openapi: 3.1.0" },
  });
  const plan = buildScanPlan(await classifyOrganization("acme", f.options));
  assert.deepEqual(
    plan.gin.map((item) => item.repository),
    ["acme/wrapper"],
  );
  assert.deepEqual(
    plan.javascript.map((item) => item.repository),
    ["acme/docs", "acme/source"],
  );
});

test("cache corruption is invalidated and symlink destinations are rejected", async (t) => {
  const f = fixture(t);
  await classifyOrganization("acme", f.options);
  const original = fs.readFileSync(f.options.classificationCache, "utf8");
  const damaged = JSON.parse(original);
  damaged.repositories[0].classification.gin = "candidate";
  fs.writeFileSync(f.options.classificationCache, JSON.stringify(damaged));
  assert.throws(() => loadRepositoryClassification(f.options.classificationCache), /fingerprint/);
  const result = await classifyOrganization("acme", f.options);
  assert.equal(result.metrics.cacheHits, 0);
  assert.equal(result.diagnostics.length, 1);
  fs.rmSync(f.options.classificationCache);
  const target = path.join(f.root, "target.json");
  fs.writeFileSync(target, original);
  fs.symlinkSync(target, f.options.classificationCache);
  await assert.rejects(classifyOrganization("acme", f.options), /symbolic/);
  assert.equal(fs.readFileSync(target, "utf8"), original);
});

test("scope limits remain visible and an interrupted catalog cannot exclude pending repositories", async (t) => {
  const f = fixture(t);
  const snapshots = [];
  const catalog = await classifyOrganization("acme", {
    ...f.options,
    maxRepositories: 2,
    onProgress(event) {
      snapshots.push(loadRepositoryClassification(f.options.classificationCache));
      if (event.event === "classification-completed") throw new Error("observer failure");
    },
  });
  assert.equal(catalog.coverage.complete, false);
  assert.equal(
    buildScanPlan(catalog).skipped.some((entry) => entry.reason === "skipped-limit"),
    true,
  );
  assert.equal(buildScanPlan(snapshots[0]).gin.length, 2);
  assert.equal(
    snapshots.some((snapshot) => snapshot.metrics.repositories === 1),
    true,
  );
  const selected = await classifyOrganization("acme", { ...f.options, repositoryInclude: ["go"] });
  assert.equal(selected.metrics.repositories, 1);
  assert.equal(
    buildScanPlan(selected).skipped.filter((entry) => entry.reason === "skipped-filter").length,
    2,
  );
});

function emptyScan(commit) {
  return {
    kind: "repository-scan",
    repository: { commit, acquisition: { complete: true } },
    discovery: { packages: [], applications: [], entries: [], coverage: { complete: true } },
    inventory: {
      summary: { routes: 0, applications: 0 },
      routes: [],
      applications: [],
      scanCoverage: { complete: true },
    },
  };
}

test("scanOrganization skips proven negatives, pins candidate refs and detects revision mismatch", async (t) => {
  const f = fixture(t);
  const calls = [];
  const result = await scanOrganization("acme", {
    ...f.options,
    scanRepositoryImpl: async (name, options) => {
      calls.push([name, options.ref]);
      return emptyScan(SHA);
    },
  });
  assert.deepEqual(calls, [["acme/app", SHA]]);
  assert.equal(result.summary.skippedByClassification, 2);
  assert.equal(result.repositories.find((entry) => entry.repository.name === "go").scanned, false);
  const failed = await scanOrganization("acme", {
    ...f.options,
    scanRepositoryImpl: async () => emptyScan("f".repeat(40)),
  });
  assert.equal(failed.summary.failedRepositories, 1);
  assert.match(failed.repositories[0].error, /classified source revision/);
});

test("classify-org writes separate catalogs and plans with no route artifacts", async (t) => {
  const f = fixture(t);
  let stdout = "";
  const args = { org: "acme", out: f.root, progress: "none" };
  assert.equal(
    await runClassifyOrganization(args, {
      fetchImpl: f.options.fetchImpl,
      environment: {},
      stdout: {
        write: (text) => {
          stdout += text;
        },
      },
    }),
    0,
  );
  assert.equal(JSON.parse(stdout).ginTargets, 1);
  assert.equal(fs.existsSync(path.join(f.root, "gin-targets.json")), true);
  assert.equal(fs.existsSync(path.join(f.root, "organization-inventory.json")), false);
  f.state.failHead = true;
  assert.equal(
    await runClassifyOrganization(args, {
      fetchImpl: f.options.fetchImpl,
      environment: {},
      stdout: { write() {} },
    }),
    2,
  );
});

test("fresh CLI scans preserve classification and pass cache selection to the scanner", async (t) => {
  const f = fixture(t);
  await classifyOrganization("acme", f.options);
  const before = fs.readFileSync(f.options.classificationCache, "utf8");
  await assert.rejects(
    runScanOrganization(
      {
        org: "acme",
        out: f.root,
        overwrite: true,
        classificationCache: f.options.classificationCache,
        progress: "none",
      },
      {
        environment: {},
        scanOrganization: async (org, options) => {
          assert.equal(options.classificationCache, f.options.classificationCache);
          assert.equal(fs.readFileSync(f.options.classificationCache, "utf8"), before);
          assert.equal(options.resumeEntries.length, 0);
          throw new Error("stop after fresh reset");
        },
      },
    ),
    /stop after fresh reset/,
  );
});

test("new CLI options validate scope and command combinations", () => {
  for (const [args, pattern] of [
    [["classify-org"], /requires --org/],
    [["classify-org", "--org", "acme", "--concurrency", "9"], /integer/],
    [["classify-org", "--org", "acme", "--config", "x"], /does not accept/],
    [["classify-org", "--org", "acme", "--format", "md"], /only --format json/],
    [["scan-org", "--org", "acme", "--reclassify"], /requires classify-org/],
    [["inventory", "--classification-cache", "x"], /does not accept/],
  ]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, "../src/cli.js"), ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, pattern);
  }
});

test("classification is reusable across policy changes but never across classifier versions", async (t) => {
  const f = fixture(t);
  const first = await classifyOrganization("acme", f.options);
  const second = await classifyOrganization("acme", {
    ...f.options,
    config: { authMiddleware: { protect: true } },
  });
  assert.equal(second.metrics.cacheHits, first.metrics.repositories);
  for (const entry of second.repositories) entry.checked = false;
  assert.equal(buildScanPlan(second).gin.length, 3);
  const invalid = structuredClone(first);
  invalid.repositories[0].classification.complete = false;
  assert.throws(() => buildScanPlan(invalid), /evidence|fingerprint/);
});

test("classification validates bounds before network calls and removes repositories no longer visible", async (t) => {
  const f = fixture(t);
  for (const options of [
    { concurrency: 9 },
    { maxRepositories: 0 },
    { apiTimeoutMs: 0 },
    { repositoryInclude: "*" },
    { reclassify: "yes" },
    { onProgress: true },
  ]) {
    await assert.rejects(classifyOrganization("acme", { ...f.options, ...options }));
  }
  assert.equal(f.calls.length, 0);
  await classifyOrganization("acme", f.options);
  delete f.state.definitions.go;
  const catalog = await classifyOrganization("acme", f.options);
  assert.equal(catalog.repositories.length, 2);
  assert.equal(buildScanPlan(catalog).gin.length, 0);
});

test("classified exclusions persist as valid native organization inventory", async (t) => {
  const f = fixture(t, { plain: { "README.md": "hello" } });
  const code = await runScanOrganization(
    {
      org: "acme",
      out: f.root,
      overwrite: true,
      classificationCache: f.options.classificationCache,
      progress: "none",
    },
    {
      environment: {},
      fetchImpl: f.options.fetchImpl,
      scanOrganization: (org, options) =>
        scanOrganization(org, {
          ...options,
          fetchImpl: f.options.fetchImpl,
          scanRepositoryImpl: () => assert.fail("negative must be skipped"),
        }),
    },
  );
  assert.equal(code, 0);
  const saved = require("../src").loadOrganizationInventory(f.root);
  assert.equal(saved.report.repositories[0].status, "skipped-classification");
  assert.equal(saved.scans.size, 0);
});

test("a failed checkpoint write drains active probes before releasing its writer lock", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    classifyOrganization("acme", {
      ...f.options,
      onProgress(event) {
        if (event.event === "classification-started") {
          fs.rmSync(f.options.classificationCache);
          fs.mkdirSync(f.options.classificationCache);
        }
      },
    }),
    /write|directory|rename/i,
  );
  assert.equal(
    fs.readdirSync(f.root).some((name) => name.endsWith("express-recon-lock")),
    false,
  );
});
