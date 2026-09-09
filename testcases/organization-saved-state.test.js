"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const api = require("../src");
const { runScanOrganization } = require("../src/cli");
const { credentialFreeEnvironment } = require("../src/github-auth");
const CLI = path.join(__dirname, "../src/cli.js");
const missing = "#/components/responses/ForbiddenResponse";
const broken = `openapi: 3.0.3
info:
  title: Broken source
  version: '1'
paths:
  /health:
    get:
      responses:
        '403':
          $ref: '${missing}'
`;
const git = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recon-invalid-catalog-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    output = path.join(root, "inventory");
  fs.mkdirSync(source);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(source, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Test");
  git(source, "config", "user.email", "test@example.invalid");
  git(source, "add", ".");
  git(source, "commit", "-m", "fixture");
  const state = { calls: 0, fail: false, headFailure: false };
  const fetchImpl = async (url, options) => {
    if (String(url).includes("/commits/")) {
      assert.equal(options.headers.Accept, "application/vnd.github.sha");
      return new Response(git(source, "rev-parse", "HEAD"), {
        status: state.headFailure ? 503 : 200,
      });
    }
    return new Response(
      JSON.stringify([
        {
          id: 1,
          name: "api",
          full_name: "acme/api",
          default_branch: "main",
          size: 1,
          pushed_at: "2026-09-09T00:00:00Z",
        },
      ]),
    );
  };
  const run = (overrides = {}) =>
    runScanOrganization(
      {
        org: "acme",
        out: output,
        progress: "none",
        failOn: "incomplete",
        repoAttempts: "1",
        provided: new Set(["--progress"]),
        ...overrides,
      },
      {
        environment: {},
        stderr: { write() {} },
        scanOrganization: (org, options) =>
          api.scanOrganization(org, {
            ...options,
            fetchImpl,
            scanRepositoryImpl: (_repo, settings) => {
              state.calls++;
              if (state.fail) throw new Error("operational acquisition failure");
              return api.scanRepository(source, settings);
            },
          }),
      },
    );
  return { root, source, output, state, run };
}

const app = {
  "package.json": JSON.stringify({
    name: "api",
    version: "1.0.0",
    dependencies: { express: "^5" },
  }),
  "app.js":
    'const express = require("express"); const app = express(); app.get("/health", (req, res) => res.json({ ok: true })); module.exports = app;\n',
};

test("invalid retained references survive scan-org gates, offline validation, rendering, integrity checks and resume", async (t) => {
  const f = fixture(t, {
    ...app,
    "airbyte-api/server-api/src/main/openapi/api.yaml": broken,
    "swagger.json": JSON.stringify({
      swagger: "2.0",
      info: { title: "Valid source", version: "1" },
      paths: {},
    }),
  });
  assert.equal(await f.run(), 2);
  const saved = api.loadOrganizationInventory(f.output);
  assert.equal(saved.report.summary.failedRepositories, 0);
  assert.equal(saved.report.coverage.complete, false);
  assert.equal(saved.validation.integrity, "verified");
  assert.match(saved.validation.warnings.join("\n"), /ForbiddenResponse/);
  const entry = saved.report.repositories[0];
  const spec = entry.artifacts.specifications.find((item) => item.status === "invalid");
  assert.equal(spec.diagnostic.repository, "acme/api");
  assert.equal(spec.diagnostic.sourcePath, spec.path);
  assert.equal(spec.diagnostic.artifactPath, spec.artifact);
  assert.equal(spec.diagnostic.reference, missing);
  assert.equal(fs.readFileSync(path.join(f.output, spec.artifact), "utf8"), broken);
  assert.ok(json(path.join(f.output, "organization-manifest.json")).integrity[spec.artifact]);
  assert.equal(json(path.join(f.output, "organization-checkpoint.json")).completed.length, 1);
  assert.equal(
    json(path.join(f.output, "organization-checkpoint.json")).completed[0].coverageComplete,
    false,
  );
  const validate = spawnSync(process.execPath, [CLI, "validate", "--input", f.output], {
    encoding: "utf8",
    env: credentialFreeEnvironment(),
  });
  assert.equal(validate.status, 0, validate.stderr);
  assert.equal(JSON.parse(validate.stdout).valid, true);
  assert.equal(JSON.parse(validate.stdout).diagnosticSummary.invalidSpecifications, 1);
  assert.equal(JSON.parse(validate.stdout).diagnosticSummary.affectedRepositories, 1);
  assert.deepEqual(
    JSON.parse(validate.stdout).validation.diagnostics,
    saved.validation.diagnostics,
  );
  for (const shared of [false, true]) {
    const site = path.join(f.root, `site-${shared}`);
    const render = spawnSync(
      process.execPath,
      [CLI, "render", "--input", f.output, "--out", site, ...(shared ? ["--shared-assets"] : [])],
      { encoding: "utf8", env: credentialFreeEnvironment() },
    );
    assert.equal(render.status, 0, render.stderr);
    const summary = JSON.parse(render.stdout).diagnosticSummary;
    assert.deepEqual(summary, {
      total: 1,
      byCategory: { "invalid-api-specification": 1, artifact: 0, render: 0 },
      invalidSpecifications: 1,
      affectedRepositories: 1,
    });
    const manifest = json(path.join(site, "render-manifest.json"));
    assert.match(manifest.warnings.join("\n"), /acme\/api.*api.yaml.*ForbiddenResponse.*Artifact:/);
    assert.match(fs.readFileSync(path.join(site, "index.html"), "utf8"), /ForbiddenResponse/);
    const html = fs.readFileSync(path.join(site, "index.html"), "utf8");
    assert.ok(html.includes("Invalid API specifications"));
    assert.ok(html.includes("Retained raw copy"));
    assert.ok(!html.includes("Artifact warnings"));
    assert.ok(!html.includes("unavailable or unsafe"));
    assert.deepEqual(manifest.diagnosticSummary, summary);
    assert.deepEqual(manifest.diagnostics, saved.validation.diagnostics);
    assert.ok(
      manifest.pages.some((reference) => reference.startsWith("openapi/")),
      "valid specification remains viewable",
    );
    for (const reference of [...manifest.pages, ...manifest.assets].filter((name) =>
      name.startsWith("openapi/"),
    ))
      assert.doesNotMatch(fs.readFileSync(path.join(site, reference), "utf8"), /ForbiddenResponse/);
  }
  assert.equal(await f.run({ resume: true }), 2);
  assert.equal(f.state.calls, 1);
  assert.equal(
    api.loadOrganizationInventory(f.output).report.repositories[0].coverageComplete,
    false,
  );
  fs.appendFileSync(path.join(f.output, spec.artifact), "# tampered\n");
  assert.throws(() => api.loadOrganizationInventory(f.output), /integrity check/);
  const priorSite = fs.readFileSync(path.join(f.root, "site-false/index.html"), "utf8");
  assert.throws(
    () => api.renderHtmlSite(f.output, path.join(f.root, "site-false")),
    /integrity check/,
  );
  assert.equal(fs.readFileSync(path.join(f.root, "site-false/index.html"), "utf8"), priorSite);
  assert.equal(await f.run({ resume: true }), 2);
  assert.equal(f.state.calls, 2);
  assert.equal(api.loadOrganizationInventory(f.output).validation.integrity, "verified");

  // A changed commit must invalidate reuse even if GitHub's push marker is unchanged.
  fs.appendFileSync(path.join(f.source, "app.js"), "// changed revision\n");
  git(f.source, "add", ".");
  git(f.source, "commit", "-m", "new revision");
  assert.equal(await f.run({ resume: true }), 2);
  assert.equal(f.state.calls, 3);
  assert.equal(
    api.loadOrganizationInventory(f.output).report.repositories[0].commit,
    git(f.source, "rev-parse", "HEAD"),
  );

  // Failed refresh of previously checkpointed evidence must not leave an inconsistent checkpoint.
  f.state.headFailure = true;
  f.state.fail = true;
  assert.equal(await f.run({ resume: true }), 2);
  assert.equal(api.loadOrganizationInventory(f.output).report.repositories[0].status, "failed");
  assert.equal(json(path.join(f.output, "organization-checkpoint.json")).completed.length, 0);
  f.state.headFailure = false;
  f.state.fail = false;
  assert.equal(await f.run({ resume: true }), 2);
  assert.equal(api.loadOrganizationInventory(f.output).report.repositories[0].status, "express");
});

test("malformed and schema-invalid retained specifications are preserved as invalid raw artifacts", async (t) => {
  const f = fixture(t, {
    ...app,
    "malformed.yaml": "openapi: 3.0.3\npaths: [\n",
    "invalid.json": '{"openapi":"3.0.3","paths":{}}',
  });
  assert.equal(await f.run(), 2);
  const saved = api.loadOrganizationInventory(f.output);
  assert.equal(saved.validation.warnings.length, 2);
  assert.ok(
    saved.report.repositories[0].artifacts.specifications.every(
      (item) => item.status === "invalid",
    ),
  );
  api.renderHtmlSite(f.output, path.join(f.root, "site"));
});

test("documentation-only repositories show invalid specification warnings without a supported framework", async (t) => {
  const f = fixture(t, { "airbyte-api/server-api/src/main/openapi/api.yaml": broken });
  assert.equal(await f.run(), 2);
  const saved = api.loadOrganizationInventory(f.output);
  assert.equal(saved.report.repositories[0].status, "inconclusive");
  assert.equal(saved.report.summary.failedRepositories, 0);
  const site = path.join(f.root, "site");
  const rendered = api.renderHtmlSite(f.output, site);
  assert.match(rendered.warnings.join("\n"), /acme\/api.*api.yaml.*ForbiddenResponse/);
  assert.ok(fs.readFileSync(path.join(site, "index.html"), "utf8").includes(missing));
  assert.ok(rendered.pages.every((name) => !name.startsWith("openapi/")));
  assert.equal(await f.run({ resume: true }), 2);
  assert.equal(f.state.calls, 1);
  assert.equal(
    api.loadOrganizationInventory(f.output).report.repositories[0].coverageComplete,
    false,
  );
});

test("file-limit and no-framework incomplete results are reusable with bounded path and byte diagnostics", async (t) => {
  const files = Object.fromEntries(
    Array.from({ length: 25 }, (_, i) => [`large-${i}.json`, " ".repeat(2048)]),
  );
  const f = fixture(t, files);
  const config = path.join(f.root, "config.json");
  fs.writeFileSync(config, JSON.stringify({ scan: { maxFileBytes: 1024 } }));
  assert.equal(await f.run({ config }), 2);
  let saved = api.loadOrganizationInventory(f.output);
  assert.equal(saved.report.repositories[0].status, "inconclusive");
  const acquisition = saved.scans.get("acme/api").repository.acquisition;
  assert.equal(acquisition.oversizedFiles.length, 20);
  assert.equal(acquisition.oversizedFileCount, 25);
  assert.ok(
    acquisition.oversizedFiles.every(
      (item) => item.bytes === 2048 && item.maxFileBytes === 1024 && !path.isAbsolute(item.path),
    ),
  );
  assert.match(
    acquisition.diagnostics.join("\n"),
    /large-0.json.*2048 bytes.*scan.maxFileBytes \(1024\)/,
  );
  assert.match(acquisition.diagnostics.join("\n"), /5 additional oversized/);
  assert.equal(await f.run({ config, resume: true }), 2);
  assert.equal(f.state.calls, 1);
  assert.equal(
    api.loadOrganizationInventory(f.output).report.repositories[0].status,
    "inconclusive",
  );
  fs.writeFileSync(config, JSON.stringify({ scan: { maxFileBytes: 4096 } }));
  assert.equal(await f.run({ config, resume: true }), 0);
  assert.equal(f.state.calls, 2);
  saved = api.loadOrganizationInventory(f.output);
  assert.equal(saved.report.coverage.complete, true);
});

test("parser and symlink coverage gaps preserve evidence and status on resume", async (t) => {
  const f = fixture(t, { ...app, "broken.js": "export const = ;\n" });
  fs.symlinkSync("app.js", path.join(f.source, "linked.js"));
  git(f.source, "add", ".");
  git(f.source, "commit", "-m", "symlink");
  assert.equal(await f.run(), 2);
  const before = api.loadOrganizationInventory(f.output);
  assert.equal(before.scans.get("acme/api").repository.acquisition.skippedSymlinks, 1);
  assert.equal(before.scans.get("acme/api").inventory.scanCoverage.complete, false);
  assert.equal(await f.run({ resume: true }), 2);
  assert.equal(f.state.calls, 1);
  const after = api.loadOrganizationInventory(f.output);
  assert.deepEqual(after.scans.get("acme/api"), before.scans.get("acme/api"));
  assert.equal(after.report.repositories[0].coverageComplete, false);
});

test("generated OpenAPI reference errors remain strict and identify repository, app, source and artifact", async (t) => {
  const f = fixture(t, app);
  assert.equal(await f.run(), 0);
  const saved = api.loadOrganizationInventory(f.output);
  const scan = saved.scans.get("acme/api");
  assert.equal(scan.documentation.status, "merged");
  scan.documentation.report.sources.base = "original/api.yaml";
  scan.documentation.document.paths["/health"].get.responses[403] = { $ref: missing };
  assert.throws(
    () =>
      require("../src/cli").writeRepositoryArtifacts(
        f.output,
        saved.report.repositories[0].repository,
        scan,
      ),
    (error) => {
      for (const value of [
        "acme/api",
        scan.inventory.applications[0].id,
        "original/api.yaml",
        "repositories/api/openapi.json",
        missing,
      ])
        assert.ok(error.message.includes(value), `Missing reference context: ${value}`);
      return true;
    },
  );
  assert.equal(api.loadOrganizationInventory(f.output).validation.integrity, "verified");
});
