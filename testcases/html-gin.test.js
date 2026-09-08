"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { renderHtmlSite, resolveInput, detectRenderInput } = require("../src/html");
const { normalizeGinReport, readGinFleet } = require("../src/gin-artifacts");
const { SCRIPT } = require("../src/html-assets");

function temporary(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recon-gin-html-"));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function json(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const text = (root, file = "index.html") => fs.readFileSync(path.join(root, file), "utf8");
const spec = { openapi: "3.0.3", info: { title: "Gin API", version: "1" }, paths: {} };
function route(overrides = {}) {
  return {
    tool: "gin-recon",
    command: "audit",
    analysisProfile: "typed",
    scanCoverage: { complete: true, analyzedFiles: 2 },
    routes: [
      {
        method: "GET",
        ginPath: "/go/:id",
        normalizedPath: "/go/{id}",
        middleware: [{ displayName: "Guard" }],
        auth: { authStatus: "public", accepted: true },
      },
    ],
    findings: [{ route: "GET /go/:id", detail: "Imported finding" }],
    ...overrides,
  };
}
function fixture(root) {
  const modules = ["root", "nested"].map((id) => ({
    id,
    path: id,
    status: "ok",
    complete: true,
    report: `targets/go/${id}/routes.json`,
    artifacts: [
      { path: `targets/go/${id}/openapi.json` },
      { tree: "html", path: "../../untrusted.html" },
    ],
    suggestionArtifact: { path: `targets/go/${id}/suggestions.json` },
  }));
  const fleet = {
    tool: "gin-recon",
    toolVersion: "0.7.0",
    kind: "fleet",
    scope: { org: "acme", discoveryComplete: true },
    coverage: { complete: false },
    totals: { routes: 2, proven: 0, public: 2, unknown: 0 },
    authConfig: { middlewareCount: 0 },
    targets: [
      {
        name: "z-go",
        repository: { fullName: "acme/z-go", scannedCommit: "gin-commit" },
        status: "ok",
        complete: true,
        report: modules[0].report,
        modules: [...modules, modules[0]],
        artifacts: modules.flatMap((m) => m.artifacts),
      },
      {
        name: "a-incomplete",
        status: "ok",
        complete: false,
        modules: [{ id: "tools", status: "failed", complete: false, error: "build <failed>" }],
      },
      { name: "a-other", status: "not-go-module", complete: true },
      { name: "b-failed", status: "failed", error: "failed <script>" },
      { name: "c-inconclusive", status: "inconclusive" },
    ],
  };
  json(path.join(root, "fleet.json"), fleet);
  for (const module of modules) {
    json(path.join(root, module.report), route());
    json(path.join(root, module.artifacts[0].path), spec);
    json(path.join(root, module.suggestionArtifact.path), {
      candidates: [{ canonicalSymbol: "auth.<Guard>", routeCount: 1, knownNonAuth: false }],
    });
  }
  json(path.join(root, "fleet-auth-candidates.json"), {
    kind: "fleet-auth-suggestions",
    candidates: [
      { canonicalSymbol: "auth.<Guard>", routeCount: 2, repos: ["z-go"], nameHint: true },
    ],
  });
  return fleet;
}
function organization(root, entries = []) {
  json(path.join(root, "organization-inventory.json"), {
    kind: "github-organization-inventory",
    organization: { login: "acme" },
    repositories: entries,
    coverage: { complete: true },
  });
}

function assertVisibleStatisticsAboveRepositories(html) {
  const tableIndex = html.indexOf('<table id="repositories-table">');
  assert.ok(tableIndex > 0);
  let disclosureDepth = 0;
  let metrics = 0;
  for (const token of html.matchAll(
    /<details\b[^>]*>|<\/details>|<span class="metric__label">([^<]+)<\/span>/g,
  )) {
    if (token[1]) {
      assert.equal(disclosureDepth, 0, `${token[1]} must not be collapsed`);
      assert.ok(token.index < tableIndex, `${token[1]} must precede repositories`);
      metrics++;
    } else disclosureDepth += token[0].startsWith("</") ? -1 : 1;
  }
  assert.ok(metrics > 5, "detailed statistics must remain present");
  assert.ok(html.indexOf("<h2>Inventory scope</h2>") < tableIndex);
  assert.match(html, /<details class="reference-section" id="reference-repositories">/);
  assert.match(html, /id="repositories-table-framework"/);
}

test("Gin bundle import retains module evidence, statistics, downloads and actual logo", () =>
  temporary((root) => {
    const source = path.join(root, "bundle", "go-output"),
      output = path.join(root, "html");
    fixture(source);
    const before = fs.readFileSync(path.join(source, "fleet.json"));
    assert.equal(resolveInput(path.dirname(source)).kind, "gin-fleet");
    assert.equal(detectRenderInput(source), source);
    const result = renderHtmlSite(path.dirname(source), output);
    assert.deepEqual(result.warnings, []);
    const html = text(output);
    assertVisibleStatisticsAboveRepositories(html);
    const main = html.match(/<table id="repositories-table">([\s\S]*?)<\/table>/)[1];
    const reference = html.match(/<table id="reference-repositories-table">([\s\S]*?)<\/table>/)[1];
    assert.ok(main.indexOf("acme/z-go") < main.indexOf("acme/a-incomplete"));
    assert.doesNotMatch(main, /acme\/a-other|acme\/b-failed/);
    assert.match(reference, /acme\/a-other/);
    assert.match(reference, /<strong>acme\/a-other<\/strong>[\s\S]*?badge--good">complete/);
    assert.ok(reference.indexOf("acme/b-failed") < reference.indexOf("acme/c-inconclusive"));
    assert.match(html, /<details class="reference-section" id="reference-repositories">/);
    assert.match(html, /Gin routes \(reported\)/);
    assert.match(html, /No Gin auth middleware configured/);
    assert.match(html, /auth\.&lt;Guard&gt;/);
    assert.doesNotMatch(html, /failed <script>/);
    const detail = text(output, "repositories/z-go.html");
    assert.equal((detail.match(/data-search="gin gin:/g) || []).length, 2);
    assert.match(detail, /gin:root/);
    assert.match(detail, /gin:nested/);
    assert.match(detail, /Guard/);
    assert.match(detail, /\/go\/:id/);
    assert.match(detail, /gin-commit/);
    assert.match(detail, /href="\.\.\/data\/gin-\d+\.json" download/);
    assert.equal(result.pages.filter((file) => file.startsWith("openapi/")).length, 2);
    assert.equal(result.data.length, 8);
    for (const file of [...result.pages, ...result.assets, ...result.data])
      assert.ok(fs.statSync(path.join(output, file)).isFile(), file);
    assert.deepEqual(
      fs.readFileSync(path.join(output, "assets/logo.svg")),
      fs.readFileSync(path.join(__dirname, "../assets/logo/mark.svg")),
    );
    assert.deepEqual(fs.readFileSync(path.join(source, "fleet.json")), before);
    fs.writeFileSync(path.join(output, "notes.txt"), "keep");
    organization(path.join(root, "express"));
    renderHtmlSite(path.join(root, "express"), output);
    assert.equal(text(output, "notes.txt"), "keep");
    assert.ok(!fs.existsSync(path.join(output, "data")));
  }));

test("optional Gin companions combine repository listing but keep scanner reports separate", () =>
  temporary((root) => {
    const source = path.join(root, "input"),
      output = path.join(root, "html");
    fixture(path.join(source, "gin"));
    const inventory = {
      tool: "express-recon",
      command: "inventory",
      routes: [{ method: "GET", path: "/express-only" }],
      scanCoverage: { complete: true },
    };
    organization(source, [
      {
        repository: { fullName: "ACME/Z-GO", name: "z-go", scannedCommit: "express-commit" },
        status: "express",
        scanned: true,
        coverageComplete: true,
        express: { applicationCount: 1, routeCount: 1 },
        scan: { kind: "repository-scan", inventory },
      },
      {
        repository: { fullName: "acme/a-incomplete" },
        status: "not-express",
        scanned: true,
      },
      { repository: { fullName: "acme/a-other" }, status: "not-express" },
    ]);
    const saved = read(path.join(source, "organization-inventory.json"));
    saved.coverage.enumeration = { complete: true, pagesFetched: 2 };
    json(path.join(source, "organization-inventory.json"), saved);
    const result = renderHtmlSite(source, output);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /different commits/);
    const html = text(output);
    assert.equal((html.match(/<strong>ACME\/Z-GO<\/strong>/g) || []).length, 1);
    assert.match(html, /Gin report/);
    assert.match(html, /data-frameworks="express gin multi-framework"/);
    assert.match(
      html,
      /<span class="metric__value">2<\/span><span class="metric__label">Repositories scanned<\/span>/,
    );
    assert.match(html, /<dt>Enumeration coverage<\/dt><dd>complete<\/dd>/);
    assert.match(html, /<dt>API pages fetched<\/dt><dd>2<\/dd>/);
    assert.match(text(output, "repositories/z-go.html"), /express-only/);
    assert.doesNotMatch(text(output, "repositories/z-go.html"), /\/go\/:id/);
    assert.match(text(output, "repositories/z-go--gin.html"), /\/go\/:id/);
    assert.doesNotMatch(text(output, "repositories/z-go--gin.html"), /express-only/);
    assert.equal(result.pages.filter((file) => file.startsWith("openapi/")).length, 2);
  }));

test("Gin normalization preserves auth and handles unresolved and incomplete evidence", () =>
  temporary((root) => {
    const normalized = normalizeGinReport(
      route({
        command: undefined,
        analysisProfile: undefined,
        routes: [
          {
            method: "GET",
            normalizedPath: "/normalized",
            auth: { authStatus: "proven", tags: ["tag"], roles: ["role"], scopes: ["scope"] },
          },
          {},
        ],
        findings: [{}],
      }),
    );
    assert.equal(normalized.routes[0].path, "/normalized");
    assert.equal(normalized.routes[1].path, "<unresolved>");
    assert.equal(normalized.summary.proven, 1);
    assert.equal(normalized.summary.unknown, 1);
    assert.throws(() => normalizeGinReport({ routes: [] }), /expected/);
    json(path.join(root, "routes.json"), route());
    renderHtmlSite(path.join(root, "routes.json"), path.join(root, "html"));
    assert.match(text(path.join(root, "html")), /Source: gin-recon/);
    const fleet = fixture(path.join(root, "fleet"));
    fleet.targets[0].complete = true;
    fleet.targets[0].modules[0].report = "targets/missing/routes.json";
    fleet.targets[0].modules[1].report = "targets/wrong/routes.json";
    json(path.join(root, "fleet/targets/wrong/routes.json"), { routes: [] });
    json(path.join(root, "fleet/fleet.json"), fleet);
    const result = renderHtmlSite(path.join(root, "fleet"), path.join(root, "broken-html"));
    assert.ok(result.warnings.some((warning) => warning.includes("expected a gin-recon")));
    assert.match(text(path.join(root, "broken-html")), /Incomplete/);
  }));

test("optional malformed or mismatched companions do not break existing organization renders", () =>
  temporary((root) => {
    const source = path.join(root, "input"),
      output = path.join(root, "html");
    organization(source);
    const fleet = fixture(path.join(source, "gin"));
    fleet.scope.org = "another-org";
    json(path.join(source, "gin/fleet.json"), fleet);
    let result = renderHtmlSite(source, output);
    assert.match(result.warnings[0], /does not match/);
    assert.equal(result.data.length, 0);
    fs.writeFileSync(path.join(source, "gin/fleet.json"), "broken JSON");
    result = renderHtmlSite(source, output);
    assert.match(result.warnings[0], /Optional Gin import skipped/);
    fixture(path.join(source, "gin"));
    fixture(path.join(source, "another-gin"));
    result = renderHtmlSite(source, output);
    assert.match(result.warnings[0], /Multiple Gin fleets/);
    assert.throws(() => resolveInput(path.join(source, "gin", "missing")), /Could not read/);
    assert.throws(
      () => renderHtmlSite(path.join(source, "gin"), output, { baseline: source }),
      /requires an organization/,
    );
  }));

test("Gin references reject traversal, escaping symlinks, oversize and wrong OpenAPI artifacts", () =>
  temporary((root) => {
    const source = path.join(root, "input"),
      output = path.join(root, "html");
    const fleet = fixture(source);
    json(path.join(root, "outside.json"), route());
    fs.symlinkSync(path.join(root, "outside.json"), path.join(source, "escape.json"));
    const oversized = path.join(source, "large.json");
    const fd = fs.openSync(oversized, "w");
    fs.ftruncateSync(fd, 33 * 1024 * 1024);
    fs.closeSync(fd);
    fleet.targets[0].modules = [
      "../outside.json",
      path.join(root, "outside.json"),
      "escape.json",
      "large.json",
      "targets",
      "wrong.json",
    ].map((report, index) => ({ id: String(index), report, status: "ok" }));
    json(path.join(source, "wrong.json"), {});
    json(path.join(source, "targets/go/root/openapi.json"), route());
    json(path.join(source, "fleet.json"), fleet);
    const result = renderHtmlSite(source, output);
    assert.ok(result.warnings.some((warning) => warning.includes("contained relative")));
    assert.ok(result.warnings.some((warning) => warning.includes("escapes")));
    assert.ok(result.warnings.some((warning) => warning.includes("bounded regular")));
    assert.ok(result.warnings.some((warning) => warning.includes("expected an OpenAPI")));
    assert.equal(result.pages.filter((file) => file.startsWith("openapi/")).length, 1);
    const warnings = [];
    assert.throws(
      () => readGinFleet(path.join(source, "wrong.json"), read, read, warnings),
      /not a gin-recon fleet/,
    );
    json(path.join(source, "fleet.json"), { ...fleet, targets: Array(20001).fill({}) });
    assert.throws(
      () => readGinFleet(path.join(source, "fleet.json"), read, read, warnings),
      /20000 targets/,
    );
    json(path.join(source, "fleet.json"), {
      ...fleet,
      targets: [{ modules: Array(501).fill({}) }],
    });
    assert.throws(
      () => readGinFleet(path.join(source, "fleet.json"), read, read, warnings),
      /too many modules/,
    );
  }));

test("framework and completion filters intersect, retain groups and keep tables independent", () => {
  function control(statuses) {
    const rows = statuses.map((status, index) => ({
      dataset: { status, search: `repo${index} ${status}` },
      hidden: false,
    }));
    const groups = [...new Set(statuses)].map((status) => ({ dataset: { status }, hidden: false }));
    const search = {
      value: "",
      addEventListener: (_, callback) => {
        search.update = callback;
      },
    };
    const status = {
      value: "",
      addEventListener: (_, callback) => {
        status.update = callback;
      },
    };
    const count = {};
    const framework = {
      value: "",
      addEventListener: (_, callback) => {
        framework.update = callback;
      },
    };
    return {
      rows,
      groups,
      search,
      status,
      framework,
      count,
      table: { querySelectorAll: (selector) => (selector.includes(":not") ? rows : groups) },
      querySelector: (selector) =>
        selector.includes("search")
          ? search
          : selector.includes("status")
            ? status
            : selector.includes("framework")
              ? framework
              : count,
    };
  }
  const main = control(["complete", "complete", "incomplete"]),
    reference = control(["failed", "not-go-module"]);
  main.dataset = { filterControls: "main" };
  reference.dataset = { filterControls: "reference" };
  main.rows[0].dataset.frameworks = "express";
  main.rows[1].dataset.frameworks = "express fastify multi-framework";
  main.rows[2].dataset.frameworks = "gin";
  vm.runInNewContext(SCRIPT, {
    document: {
      querySelectorAll: () => [main, reference],
      getElementById: (id) => (id === "main" ? main : reference).table,
    },
  });
  assert.equal(main.count.textContent, "3 of 3");
  main.framework.value = "fastify";
  main.framework.update();
  assert.equal(main.count.textContent, "1 of 3");
  assert.equal(main.rows[1].hidden, false);
  assert.equal(main.groups[1].hidden, true);
  main.framework.value = "express";
  main.framework.update();
  assert.equal(main.count.textContent, "2 of 3");
  main.status.value = "incomplete";
  main.status.update();
  assert.equal(main.count.textContent, "0 of 3");
  main.framework.value = "gin";
  main.framework.update();
  assert.equal(main.count.textContent, "1 of 3");
  assert.equal(main.groups[0].hidden, true);
  assert.equal(reference.count.textContent, "2 of 2");
  main.search.value = "missing";
  main.search.update();
  assert.equal(main.count.textContent, "0 of 3");
  assert.ok(main.groups.every((group) => group.hidden));
  main.search.value = "repo2";
  main.search.update();
  assert.equal(main.count.textContent, "1 of 3");
  main.framework.value = "gi";
  main.framework.update();
  assert.equal(main.count.textContent, "0 of 3", "framework matching must use exact tokens");
});

test("organization framework choices retain legacy, mixed-framework and imported Gin identities", () =>
  temporary((root) => {
    organization(root, [
      { repository: { fullName: "acme/legacy" }, status: "express", coverageComplete: true },
      {
        repository: { fullName: "acme/mixed" },
        status: "multi-framework",
        coverageComplete: false,
        frameworks: {
          names: ["express", "fastify"],
          items: [{ name: "nestjs" }, { name: "<script>" }],
        },
      },
      { repository: { fullName: "acme/gin" }, status: "gin", coverageComplete: true },
      { repository: { fullName: "acme/unknown-mix" }, status: "multi-framework" },
      {
        repository: { fullName: "acme/failed" },
        status: "failed",
        frameworks: { names: ["fastify"] },
      },
      { repository: { fullName: "acme/other" }, status: "not-express" },
    ]);
    const output = path.join(root, "html");
    renderHtmlSite(root, output);
    const html = text(output);
    assertVisibleStatisticsAboveRepositories(html);
    const controls = html.match(
      /<div class="filters" data-filter-controls="repositories-table">([\s\S]*?)<\/select>[\s\S]*?<\/select>/,
    )[0];
    assert.match(controls, /Completion/);
    assert.match(controls, /data-filter-framework/);
    for (const name of ["express", "fastify", "nestjs", "gin", "multi-framework"])
      assert.ok(controls.includes(`<option value="${name}">${name}</option>`), name);
    assert.match(html, /data-frameworks="express fastify multi-framework nestjs"/);
    assert.match(html, /<th>Completion<\/th><th>Framework<\/th>/);
    assert.match(html, /<th>Status<\/th><th>Framework<\/th>/);
    assert.doesNotMatch(html, /Status \/ framework/);
    assert.match(html, /class="repository-status"><span class="badge badge--warn">incomplete/);
    assert.match(
      html,
      /class="framework-badges"><span class="badge badge--neutral">Express<\/span><span class="badge badge--neutral">Fastify<\/span><span class="badge badge--neutral">NestJS/,
    );
    assert.match(html, /\.badge\s*\{[^}]*justify-self: start/s);
    const main = html.match(/<table id="repositories-table">([\s\S]*?)<\/table>/)[1];
    const reference = html.match(/<table id="reference-repositories-table">([\s\S]*?)<\/table>/)[1];
    assert.equal((main.match(/<th>/g) || []).length, 7);
    assert.equal((reference.match(/<th>/g) || []).length, 8);
    for (const [table, columns] of [
      [main, 7],
      [reference, 8],
    ]) {
      for (const row of table.matchAll(/<tr data-search[^>]*>([\s\S]*?)<\/tr>/g))
        assert.equal((row[1].match(/<td\b/g) || []).length, columns);
      assert.match(table, new RegExp(`colspan="${columns}"`));
    }
    assert.match(html, /id="reference-repositories-table-framework"/);
    assert.match(html, /data-frameworks="not-reported"/);
    assert.doesNotMatch(controls, /<script>/);
  }));
