"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { loadRenderBundle, importRenderBundles, LIMITS } = require("../src/render-bundle");
const { renderHtmlSite, resolveInput, inputKind, defaultRenderOutput } = require("../src/html");
const EXAMPLE = path.join(__dirname, "../examples/render-bundle");
const VALIDATOR = path.join(__dirname, "../src/render-bundle.js");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-bundle-test-"));
  const bundle = path.join(root, "producer");
  fs.cpSync(EXAMPLE, bundle, { recursive: true });
  const file = path.join(bundle, "render-bundle.json");
  const manifest = read(file);
  try {
    return run({ root, bundle, file, manifest, output: path.join(root, "html") });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function native(root, overrides = {}) {
  const report = {
    kind: "github-organization-inventory",
    organization: { login: "example-org" },
    summary: { repositoriesDiscovered: 5 },
    coverage: { complete: true, incompleteRepositories: [] },
    repositories: [
      {
        repository: {
          name: "catalog",
          fullName: "example-org/catalog",
          commit: "0123456789abcdef0123456789abcdef01234567",
        },
        status: "express",
        scanned: true,
        coverageComplete: true,
        routeGraphComplete: true,
        express: { applicationCount: 1, routeCount: 1 },
        scan: {
          kind: "repository-scan",
          repository: {
            source: "example-org/catalog",
            commit: "0123456789abcdef0123456789abcdef01234567",
          },
          inventory: {
            command: "inventory",
            tool: "express-recon",
            routes: [{ method: "GET", path: "/native", applicationId: "app" }],
            applications: [],
            scanCoverage: { complete: true },
          },
        },
      },
    ],
    ...overrides,
  };
  write(path.join(root, "organization-inventory.json"), report);
  return report;
}

test("published example validates offline without confusing valid with complete", () => {
  const { report, manifest, warnings } = loadRenderBundle(path.join(EXAMPLE, "render-bundle.json"));
  assert.deepEqual(warnings, []);
  assert.equal(manifest.schemaVersion, "1.0");
  assert.equal(report.coverage.complete, false);
  assert.equal(report.summary.routes, 1);
  assert.equal(report.summary.applications, 1);
  assert.equal(report.summary.failedRepositories, 1);
  const scan = report.repositories[0].scan;
  assert.equal(scan.inventory.command, "inventory");
  assert.equal(scan.inventory.routes[0].authStatus, "unknown");
  assert.equal(
    scan.imported.auth[0].basis,
    read(path.join(EXAMPLE, "routes.json")).routes[0].auth.basis,
  );
  assert.equal(scan.imported.files.length, 3);
});

test("standalone bundles retain styling, framework filters, stats, evidence and reference outcomes", () =>
  fixture(({ bundle, file, output }) => {
    const result = renderHtmlSite(bundle, output);
    assert.equal(inputKind(read(file)), "render-bundle");
    assert.equal(resolveInput(bundle).file, file);
    assert.equal(defaultRenderOutput(file), `${bundle}-html`);
    assert.equal(result.source.kind, "render-bundle");
    assert.deepEqual(result.warnings, []);
    assert.equal(result.pages.length, 4);
    const html = fs.readFileSync(path.join(output, "index.html"), "utf8");
    for (const text of [
      "data-filter-framework",
      'value="django"',
      "Files examined (files)",
      "sample-recon",
      "Route observations",
      "<style",
      '<details class="reference-section" id="reference-repositories">',
    ])
      assert.ok(html.includes(text), text);
    assert.doesNotMatch(html, /src="https?:/);
    const detail = fs.readFileSync(path.join(output, "repositories/catalog.html"), "utf8");
    assert.match(detail, /Handlers resolved \(handlers\)/);
    assert.match(detail, /guard semantics have not been verified/);
    assert.match(detail, /0123456789abcdef/);
    assert.match(detail, /\.\.\/data\/import-/);
    assert.match(
      fs.readFileSync(path.join(output, "repositories/worker.html"), "utf8"),
      /Repository unavailable/,
    );
    assert.ok(result.data.every((reference) => fs.existsSync(path.join(output, reference))));
    const evidence = result.data.map((reference) => read(path.join(output, reference)));
    assert.ok(evidence.some((value) => value.synthetic === true));
    // Ownership cleanup supports the new data paths while preserving unrelated files.
    fs.writeFileSync(path.join(output, "notes.txt"), "keep");
    renderHtmlSite(file, output);
    assert.equal(fs.readFileSync(path.join(output, "notes.txt"), "utf8"), "keep");
    assert.throws(
      () => renderHtmlSite(file, output, { baseline: bundle }),
      /requires an organization/,
    );
  }));

test("reserved fields, versions, outcome contradictions and duplicate identities fail explicitly", () =>
  fixture(({ file, manifest }) => {
    const cases = [
      (value) => {
        value.schemaVersion = "2.0";
      },
      (value) => {
        value.typo = true;
      },
      (value) => {
        value.repositories[0].outcome = "failed";
      },
      (value) => {
        delete value.repositories[0].routes;
      },
      (value) => {
        value.repositories.push({ ...value.repositories[0], name: "CATALOG" });
      },
      (value) => {
        value.statistics.push(value.statistics[0]);
      },
      (value) => {
        value.repositories[0].statistics.push(value.repositories[0].statistics[0]);
      },
      (value) => {
        value.extensions = { unnamespaced: true };
      },
      (value) => {
        value.generatedAt = "yesterday";
      },
    ];
    for (const mutate of cases) {
      const changed = structuredClone(manifest);
      mutate(changed);
      write(file, changed);
      assert.throws(() => loadRenderBundle(file), /Invalid render bundle|Duplicate/);
    }
  }));

test("route contracts reject duplicate IDs, undeclared frameworks and unsupported versions", () =>
  fixture(({ bundle, file }) => {
    const routeFile = path.join(bundle, "routes.json");
    const original = read(routeFile);
    for (const [mutate, pattern] of [
      [(value) => value.routes.push(value.routes[0]), /Duplicate route id/],
      [
        (value) => {
          value.routes[0].framework = "spring";
        },
        /undeclared framework/,
      ],
      [
        (value) => {
          value.schemaVersion = "1.1";
        },
        /Invalid render routes/,
      ],
      [
        (value) => {
          value.routes[0].auth = { status: "proven" };
        },
        /Invalid render routes/,
      ],
    ]) {
      const changed = structuredClone(original);
      mutate(changed);
      write(routeFile, changed);
      assert.throws(() => loadRenderBundle(file), pattern);
    }
  }));

test("partial paths and unknown coverage stay conservative with missing optional route fields", () =>
  fixture(({ bundle, file, manifest }) => {
    manifest.repositories = [manifest.repositories[0]];
    manifest.coverage = { complete: true, reasons: [] };
    manifest.repositories[0].coverage.complete = null;
    delete manifest.statistics;
    delete manifest.repositories[0].statistics;
    delete manifest.repositories[0].specifications;
    delete manifest.repositories[0].evidence;
    write(file, manifest);
    write(path.join(bundle, "routes.json"), {
      kind: "render-routes",
      schemaVersion: "1.0",
      routes: [
        {
          id: "unresolved",
          method: "ANY",
          path: null,
          pathConfidence: "unknown",
          framework: "django",
        },
        {
          id: "partial",
          method: "GET",
          path: "/prefix",
          pathConfidence: "partial",
          framework: "django",
        },
      ],
    });
    const { report } = loadRenderBundle(file);
    const scan = report.repositories[0].scan;
    assert.equal(report.coverage.complete, false);
    assert.equal(scan.imported.complete, false);
    assert.equal(scan.inventory.routes[0].path, "<unresolved>");
    assert.equal(scan.inventory.applications[0].routeCount, 2);
    assert.equal(scan.inventory.routes[0].authStatus, undefined);
    assert.equal(scan.imported.reasons.length, 1);
    write(path.join(bundle, "routes.json"), {
      kind: "render-routes",
      schemaVersion: "1.0",
      routes: [],
    });
    assert.equal(loadRenderBundle(file).report.repositories[0].coverageComplete, null);
  }));

test("artifact paths reject traversal, URLs, platform paths and encoding", () =>
  fixture(({ file, manifest }) => {
    for (const reference of [
      "../secret.json",
      "/tmp/secret.json",
      "C:\\secret.json",
      "https://example.test/data",
      "data/../secret.json",
      "./routes.json",
      "routes%2ejson",
      "routes.json#fragment",
      "file?.json",
    ]) {
      const changed = structuredClone(manifest);
      changed.repositories[0].routes.path = reference;
      write(file, changed);
      assert.throws(() => loadRenderBundle(file), /Invalid render bundle/, reference);
    }
  }));

test("missing, malformed, escaping, oversized and hash-mismatched files preserve partial evidence", () =>
  fixture(({ root, bundle, file, manifest }) => {
    const outside = path.join(root, "outside.json");
    write(outside, { secret: "not-imported" });
    fs.symlinkSync(outside, path.join(bundle, "escaping.json"));
    fs.symlinkSync(path.join(bundle, "evidence.json"), path.join(bundle, "contained.json"));
    fs.mkdirSync(path.join(bundle, "directory.json"));
    fs.writeFileSync(path.join(bundle, "malformed.json"), "{");
    const large = path.join(bundle, "large.json");
    const descriptor = fs.openSync(large, "w");
    fs.ftruncateSync(descriptor, LIMITS.fileBytes + 1);
    fs.closeSync(descriptor);
    manifest.repositories[0].evidence = [
      "missing.json",
      "escaping.json",
      "directory.json",
      "malformed.json",
      "large.json",
      "contained.json",
    ].map((name) => ({ path: name, label: name }));
    manifest.repositories[0].routes.sha256 = "0".repeat(64);
    write(file, manifest);
    const result = loadRenderBundle(file);
    assert.equal(result.warnings.length, 6);
    assert.equal(result.report.repositories[0].coverageComplete, false);
    assert.equal(result.report.repositories[0].scan.inventory.routes.length, 0);
    assert.equal(result.report.repositories[0].scan.imported.files.length, 2);
    assert.match(result.warnings.join(" "), /SHA-256 mismatch/);
    assert.match(result.warnings.join(" "), /escapes bundle folder/);
    assert.doesNotMatch(JSON.stringify(result.report), /not-imported/);
    manifest.repositories[0].routes.sha256 = createHash("sha256")
      .update(fs.readFileSync(path.join(bundle, "routes.json")))
      .digest("hex");
    write(file, manifest);
    assert.equal(loadRenderBundle(file).report.repositories[0].scan.inventory.routes.length, 1);
  }));

test("read budgets and deeply nested extension data are bounded", () =>
  fixture(({ file, manifest }) => {
    assert.throws(
      () => loadRenderBundle(file, { budget: { bytes: LIMITS.totalBytes, references: 0 } }),
      /256 MiB/,
    );
    assert.throws(
      () => loadRenderBundle(file, { budget: { bytes: 0, references: 10000 } }),
      /artifact count/,
    );
    assert.throws(
      () => loadRenderBundle(file, { budget: { bytes: 0, references: 9999 } }),
      /artifact count/,
    );
    let deep = "value";
    for (let index = 0; index < 65; index++) deep = { nested: deep };
    manifest.extensions = { "sample-recon.deep": deep };
    write(file, manifest);
    assert.throws(() => loadRenderBundle(file), /complexity limit/);
  }));

test("native companion imports preserve native evidence and add separately attributed pages", () =>
  fixture(({ root, file, manifest, output }) => {
    const original = native(root);
    const rendered = renderHtmlSite(root, output);
    assert.equal(rendered.source.kind, "organization");
    assert.deepEqual(rendered.warnings, []);
    assert.ok(rendered.pages.includes("repositories/catalog--sample-recon.html"));
    assert.equal(
      read(path.join(root, "organization-inventory.json")).repositories[0].scan.inventory.routes[0]
        .path,
      "/native",
    );
    const html = fs.readFileSync(path.join(output, "index.html"), "utf8");
    assert.match(html, /value="express"/);
    assert.match(html, /value="django"/);
    const primary = fs.readFileSync(path.join(output, "repositories/catalog.html"), "utf8");
    const secondary = fs.readFileSync(
      path.join(output, "repositories/catalog--sample-recon.html"),
      "utf8",
    );
    assert.match(primary, /\/native/);
    assert.doesNotMatch(primary, /Catalog API/);
    assert.match(secondary, /Catalog API/);
    assert.doesNotMatch(secondary, /different or unknown commits/);
    manifest.repositories[0].commit = "different";
    write(file, manifest);
    const input = resolveInput(root);
    importRenderBundles(input, []);
    assert.equal(input.value.repositories[0].coverageComplete, false);
    assert.equal(input.value.repositories[0].frameworks.routeCount, 2);
    assert.equal(input.value.summary.repositoriesDiscovered, 5);
    assert.equal(input.value.repositories[0].scan.inventory.routes[0].path, "/native");
    assert.match(
      input.value.repositories[0].importedScans[0].imported.reasons.join(),
      /different or unknown commits/,
    );
    assert.deepEqual(read(path.join(root, "organization-inventory.json")), original);
  }));

test("invalid optional bundles and mismatching organizations never break native rendering", () =>
  fixture(({ root, bundle, file, manifest, output }) => {
    native(root);
    manifest.organization.owner = "different-owner";
    manifest.repositories[0].routes.path = "not-present.json";
    write(file, manifest);
    const result = renderHtmlSite(root, output);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /host\/owner does not match/);
    assert.doesNotMatch(result.warnings[0], /not-present/);
    fs.writeFileSync(file, "{");
    assert.equal(renderHtmlSite(root, output).warnings.length, 1);
    assert.throws(() => renderHtmlSite(bundle, output), /Could not parse/);
    assert.equal(read(path.join(output, "render-manifest.json")).source.kind, "organization");
  }));

test("duplicate sources are skipped before merge; escaping companion manifest symlinks are ignored", () =>
  fixture(({ root, bundle, file, manifest, output }) => {
    native(root);
    const copy = path.join(root, "duplicate");
    fs.cpSync(bundle, copy, { recursive: true });
    const rendered = renderHtmlSite(root, output);
    assert.equal(
      rendered.warnings.filter((warning) => warning.includes("duplicate source")).length,
      2,
    );
    assert.equal(rendered.pages.length, 2);
    fs.renameSync(path.join(copy, "render-bundle.json"), path.join(copy, "hidden.json"));
    for (const producer of ["express-recon", "gin-recon"]) {
      manifest.producer.name = producer;
      write(file, manifest);
      const input = resolveInput(root);
      if (producer === "gin-recon") input.value.gin = {};
      const warnings = [];
      importRenderBundles(input, warnings);
      assert.equal(warnings.length, 1);
      assert.equal(input.value.imports, undefined);
    }
    fs.renameSync(file, path.join(bundle, "hidden.json"));
    fs.symlinkSync(path.join(bundle, "hidden.json"), file);
    assert.deepEqual(renderHtmlSite(root, output).warnings, []);
  }));

test("generic host identities stay case-sensitive and render a neutral organization label", () =>
  fixture(({ file, manifest, output }) => {
    manifest.organization = { host: "git.example.test", owner: "Engineering" };
    manifest.repositories.push({ ...manifest.repositories[1], name: "Worker" });
    write(file, manifest);
    assert.equal(loadRenderBundle(file).report.repositories.length, 3);
    assert.throws(
      () =>
        loadRenderBundle(file, {
          organization: { host: "git.example.test", owner: "engineering" },
        }),
      /does not match/,
    );
    renderHtmlSite(file, output);
    assert.doesNotMatch(
      fs.readFileSync(path.join(output, "index.html"), "utf8"),
      /GitHub organization inventory/,
    );
  }));

test("imports can supply a main detail page for a reference repository, retaining negative evidence", () =>
  fixture(({ root, output, manifest, file }) => {
    native(root, {
      coverage: { complete: false, incompleteRepositories: ["example-org/catalog"] },
      repositories: [
        {
          repository: { name: "catalog", fullName: "example-org/catalog" },
          status: "not-express",
          coverageComplete: false,
        },
      ],
    });
    const result = renderHtmlSite(root, output);
    assert.deepEqual(result.warnings, []);
    assert.ok(result.pages.includes("repositories/catalog.html"));
    assert.match(
      fs.readFileSync(path.join(output, "repositories/catalog.html"), "utf8"),
      /different or unknown commits/,
    );
    manifest.repositories[0].outcome = "inconclusive";
    manifest.repositories[0].coverage.complete = false;
    write(file, manifest);
    assert.equal(renderHtmlSite(root, output).warnings.length, 0);
  }));

test("optional bundle set limits are fail-visible and discovery remains shallow", () =>
  fixture(({ root, output, file }) => {
    native(root);
    for (let index = 0; index < 32; index++)
      write(path.join(root, `producer-${index}`, "render-bundle.json"), read(file));
    const result = renderHtmlSite(root, output);
    assert.match(result.warnings[0], /More than 32 optional render bundles/);
    const warnings = [];
    importRenderBundles({ kind: "routes" }, warnings);
    assert.deepEqual(warnings, []);
  }));

test("invalid route contract fails transactionally and imported text is escaped", () =>
  fixture(({ bundle, file, output }) => {
    const routesFile = path.join(bundle, "routes.json");
    const routes = read(routesFile);
    routes.routes[0].path = '</code><script>alert("unsafe")</script>';
    routes.routes[0].auth.basis = "<img src=x onerror=alert(1)>";
    write(routesFile, routes);
    renderHtmlSite(file, output);
    const page = path.join(output, "repositories/catalog.html");
    const original = fs.readFileSync(page, "utf8");
    assert.match(original, /&lt;script&gt;/);
    assert.doesNotMatch(original, /<img src=x/);
    routes.routes[0].framework = "not-declared";
    write(routesFile, routes);
    assert.throws(() => renderHtmlSite(file, output), /undeclared framework/);
    assert.equal(fs.readFileSync(page, "utf8"), original);
  }));

test("validator CLI is compact and returns distinct validity failures", () =>
  fixture(({ file, manifest }) => {
    const run = (args) => spawnSync(process.execPath, [VALIDATOR, ...args], { encoding: "utf8" });
    const valid = run([file]);
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(JSON.parse(valid.stdout), { valid: true, repositories: 2, warnings: [] });
    assert.equal(run([]).status, 1);
    manifest.repositories[0].routes.path = "missing.json";
    write(file, manifest);
    const partial = run([file]);
    assert.equal(partial.status, 1);
    assert.equal(JSON.parse(partial.stdout).valid, false);
    manifest.schemaVersion = "future";
    write(file, manifest);
    const invalid = run([file]);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Invalid render bundle/);
  }));

test("published native schema remains exactly the runtime report contract", () => {
  assert.deepEqual(
    require("../schemas/native/report-v2.schema.json"),
    require("../src/schema").REPORT_SCHEMA,
  );
  assert.equal(
    spawnSync(process.execPath, [path.join(__dirname, "../scripts/export-schemas.js"), "--check"])
      .status,
    0,
  );
});

test("falsy JSON route files cannot masquerade as complete route evidence", () =>
  fixture(({ bundle, file }) => {
    for (const value of [null, false, 0, ""]) {
      write(path.join(bundle, "routes.json"), value);
      assert.throws(() => loadRenderBundle(file), /Invalid render routes/);
    }
  }));

test("invalid specifications degrade coverage and code modules are never imported", () =>
  fixture(({ bundle, file, manifest, output }) => {
    const marker = path.join(bundle, "executed.txt");
    fs.writeFileSync(
      path.join(bundle, "spec.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad"); module.exports = {};`,
    );
    write(path.join(bundle, "invalid-spec.json"), {
      openapi: "4.0.0",
      info: { title: "Not supported", version: "1" },
      paths: {},
    });
    fs.writeFileSync(
      path.join(bundle, "swagger.yaml"),
      'swagger: "2.0"\ninfo:\n  title: Legacy API\n  version: "1"\npaths: {}\n',
    );
    manifest.repositories[0].specifications = ["spec.js", "invalid-spec.json", "swagger.yaml"].map(
      (name) => ({ path: name, label: name }),
    );
    write(file, manifest);
    const result = loadRenderBundle(file);
    assert.equal(result.warnings.length, 2);
    assert.equal(result.report.repositories[0].coverageComplete, false);
    assert.equal(result.report.repositories[0].scan.documentation.specifications.length, 1);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(renderHtmlSite(file, output).warnings.length, 2);
  }));

test("copied porting skill has valid frontmatter and resolves contracts from the installed package", () => {
  // Equivalent frontmatter checks when the skill-creator Python helper lacks PyYAML.
  const YAML = require("yaml");
  const markdown = fs.readFileSync(
    path.join(__dirname, "../skills/express-recon-render-port/SKILL.md"),
    "utf8",
  );
  const match = markdown.match(/^---\n([\s\S]+?)\n---\n/);
  assert.ok(match);
  const metadata = YAML.parse(match[1]);
  assert.deepEqual(Object.keys(metadata).sort(), ["description", "name"]);
  assert.match(metadata.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(metadata.name.length <= 64);
  assert.equal(typeof metadata.description, "string");
  assert.ok(metadata.description.length > 0 && metadata.description.length <= 1024);
  assert.doesNotMatch(metadata.description, /[<>]/);
  assert.doesNotMatch(markdown, /\[TODO:/);
  assert.match(markdown, /require\.resolve\("express-recon\/package\.json"\)/);
  assert.match(markdown, /do not invent schema fields/i);
});
