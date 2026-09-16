"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { renderHtmlSite, checkHtmlSite } = require("../src/html");
const {
  enrichOpenApi,
  normalizeHost,
  repositoryKey,
  validateBindings,
} = require("../src/domain-openapi");
const { loadDomainInventory, validateDomainInventory } = require("../src/domain-inventory");
const { createDiagnosticCollector } = require("../src/report-diagnostics");

const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const document = () => ({
  openapi: "3.0.3",
  info: { title: "API", version: "1" },
  paths: { "/health": { get: { responses: { 200: { description: "OK" } } } } },
});
function domainRepo(overrides = {}) {
  const now = new Date().toISOString();
  return {
    repository: { key: "github.com/acme/api", fullName: "acme/api", id: 1 },
    status: "complete",
    sourceCommit: "d".repeat(40),
    lastSuccessAt: now,
    domains: [
      {
        hostname: "api.example.test",
        scopes: ["internal"],
        environments: ["production"],
        observations: [
          {
            hostname: "api.example.test",
            scheme: "https",
            port: null,
            urlPath: null,
            paths: ["/*"],
            scope: "internal",
            environment: "production",
            source: {
              file: "deployment/infra/production-api.yaml",
              pointer: "/ingress/internal/hosts/0/host",
              documentIndex: 0,
              observedAt: now,
              commit: "d".repeat(40),
            },
          },
        ],
      },
    ],
    ...overrides,
  };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-domains-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "scan");
  const output = path.join(root, "html");
  const inventory = {
    kind: "github-organization-inventory",
    organization: { login: "acme" },
    summary: { routes: 1, applications: 1 },
    repositories: [
      {
        repository: { fullName: "acme/api", name: "api", id: 1 },
        status: "express",
        coverageComplete: true,
        express: { routeCount: 1, applicationCount: 1 },
        artifacts: {
          repositoryScan: "repositories/api/repo-scan.json",
          openapi: "repositories/api/openapi.json",
        },
      },
      { repository: { fullName: "acme/unscanned", name: "unscanned" }, status: "not-express" },
    ],
  };
  const scan = {
    kind: "repository-scan",
    repository: { source: "https://github.com/acme/api" },
    inventory: {
      applications: [{ id: "app:a", name: "app", routeCount: 1 }],
      routes: [{ method: "GET", path: "/health", applicationId: "app:a" }],
    },
  };
  const catalog = {
    schemaVersion: 1,
    kind: "deployment-domain-inventory",
    updatedAt: new Date().toISOString(),
    repositories: [domainRepo()],
  };
  write(path.join(input, "organization-inventory.json"), inventory);
  write(path.join(input, "repositories/api/repo-scan.json"), scan);
  write(path.join(input, "repositories/api/openapi.json"), document());
  write(path.join(input, "domain-inventory.json"), catalog);
  return { input, output, inventory, scan, catalog, root };
}

test("plain render CLI discovers domain sidecar, adds table/evidence/servers and leaves all inputs unchanged", (t) => {
  const f = fixture(t);
  const files = [
    "domain-inventory.json",
    "organization-inventory.json",
    "repositories/api/repo-scan.json",
    "repositories/api/openapi.json",
  ];
  const before = files.map((file) => fs.readFileSync(path.join(f.input, file), "utf8"));
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "../src/cli.js"), "render", "--input", f.input, "--out", f.output],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const manifest = read(path.join(f.output, "render-manifest.json"));
  assert.deepEqual(manifest.warnings, []);
  assert.ok(manifest.pages.includes("domains.html"));
  assert.ok(manifest.data.includes("domain-merge.json"));
  assert.match(fs.readFileSync(path.join(f.output, "index.html"), "utf8"), /<th>Domains<\/th>/);
  assert.match(fs.readFileSync(path.join(f.output, "index.html"), "utf8"), /1 hosts/);
  const index = fs.readFileSync(path.join(f.output, "index.html"), "utf8");
  assert.match(index, /id="repositories-table-domain"[^>]+data-filter-domain/);
  assert.match(index, /data-domains="api\.example\.test"/);
  assert.match(index, /data-label="Domains"/);
  assert.match(index, /repository-table-wrap--domains/);
  assert.match(index, /\.repository-table-wrap > table \{ table-layout: fixed; \}/);
  assert.match(index, /@media screen and \(max-width: 1000px\)/);
  assert.match(fs.readFileSync(path.join(f.output, "index.html"), "utf8"), /Not scanned/);
  assert.match(
    fs.readFileSync(path.join(f.output, "repositories/api.html"), "utf8"),
    /api\.example\.test/,
  );
  assert.match(
    fs.readFileSync(path.join(f.output, "openapi/api.js"), "utf8"),
    /https:\/\/api\.example\.test/,
  );
  assert.match(
    fs.readFileSync(path.join(f.output, "domains.html"), "utf8"),
    /deployment\/infra\/production-api.yaml/,
  );
  assert.equal(read(path.join(f.output, "domain-merge.json")).uniqueHosts, 1);
  assert.deepEqual(
    files.map((file) => fs.readFileSync(path.join(f.input, file), "utf8")),
    before,
  );
  assert.equal(checkHtmlSite(f.input, f.output).current, true);
  f.catalog.repositories[0].domains = [];
  write(path.join(f.input, "domain-inventory.json"), f.catalog);
  assert.equal(checkHtmlSite(f.input, f.output).current, false);
  renderHtmlSite(f.input, f.output);
  assert.match(fs.readFileSync(path.join(f.output, "domains.html"), "utf8"), /No hosts recorded/);
  assert.doesNotMatch(
    fs.readFileSync(path.join(f.output, "index.html"), "utf8"),
    /data-filter-domain>/,
  );
  fs.unlinkSync(path.join(f.input, "domain-inventory.json"));
  renderHtmlSite(f.input, f.output);
  assert.equal(fs.existsSync(path.join(f.output, "domains.html")), false);
  assert.equal(fs.existsSync(path.join(f.output, "domain-merge.json")), false);
  assert.doesNotMatch(
    fs.readFileSync(path.join(f.output, "index.html"), "utf8"),
    /data-filter-domain>/,
  );
});

test("collapsed zero-route rows retain domain search and original repository evidence links", (t) => {
  const f = fixture(t);
  f.inventory.repositories.unshift({
    repository: { fullName: "acme/background", name: "background", id: 2 },
    status: "express",
    coverageComplete: true,
    express: { routeCount: 0, applicationCount: 1 },
  });
  f.catalog.repositories.push(
    domainRepo({
      repository: { key: "github.com/acme/background", fullName: "acme/background", id: 2 },
    }),
  );
  write(path.join(f.input, "organization-inventory.json"), f.inventory);
  write(path.join(f.input, "domain-inventory.json"), f.catalog);
  renderHtmlSite(f.input, f.output);
  const html = fs.readFileSync(path.join(f.output, "index.html"), "utf8");
  const main = html.match(/<table id="repositories-table">([\s\S]*?)<\/table>/)[1];
  const collapsed = html.match(
    /<details class="reference-section" id="no-routes-repositories">([\s\S]*?)<\/details>/,
  )[1];
  assert.match(main, /acme\/api/);
  assert.match(main, /href="domains.html#repository-1"/);
  assert.doesNotMatch(main, /acme\/background/);
  assert.match(collapsed, /id="no-routes-repositories-table-domain"[^>]+data-filter-domain/);
  assert.match(collapsed, /data-domains="api.example.test"/);
  assert.match(collapsed, /href="domains.html#repository-0"/);
  assert.match(collapsed, /data-sort-name="acme\/background"/);
});

test("shared assets and exact app bindings work with sidecars; domain text is escaped", (t) => {
  const f = fixture(t);
  f.scan.inventory.applications.push({ id: "app:b" });
  write(path.join(f.input, "repositories/api/repo-scan.json"), f.scan);
  const api = document();
  api["x-express-recon"] = { reconciliation: { applicationId: "app:b" } };
  write(path.join(f.input, "repositories/api/openapi.json"), api);
  f.catalog.repositories[0].domains[0].observations[0].source.file = "<script>alert(1)</script>";
  write(path.join(f.input, "domain-inventory.json"), f.catalog);
  const rule = { repository: "acme/api", applicationId: "app:b", hostname: "api.example.test" };
  write(path.join(f.input, "domain-bindings.json"), { schemaVersion: 1, bindings: [rule] });
  renderHtmlSite(f.input, f.output, { sharedAssets: true });
  assert.match(
    fs.readFileSync(path.join(f.output, "openapi/index.js"), "utf8"),
    /https:\/\/api\.example\.test/,
  );
  assert.doesNotMatch(
    fs.readFileSync(path.join(f.output, "domains.html"), "utf8"),
    /<script>alert/,
  );
  write(path.join(f.input, "domain-bindings.json"), { schemaVersion: 1, bindings: [rule, rule] });
  const result = renderHtmlSite(f.input, f.output);
  assert.ok(result.diagnostics.some((d) => d.message.includes("Overlapping")));
  assert.ok(
    fs.existsSync(path.join(f.output, "openapi/api.html")),
    "optional enrichment failure must not hide the API page",
  );
});

test("malformed, null, oversized and symbolic domain sidecars warn without breaking route rendering", (t) => {
  const f = fixture(t);
  const file = path.join(f.input, "domain-inventory.json");
  for (const invalid of ["{", "null", '{"schemaVersion":99}', '"x"']) {
    fs.writeFileSync(file, invalid);
    const result = renderHtmlSite(f.input, f.output);
    assert.ok(result.warnings.some((w) => w.includes("Domain sidecar ignored")));
    assert.ok(fs.existsSync(path.join(f.output, "openapi/api.html")));
  }
  fs.truncateSync(file, 64 * 1024 * 1024 + 1);
  assert.ok(renderHtmlSite(f.input, f.output).warnings.some((w) => w.includes("64 MiB")));
  fs.unlinkSync(file);
  const elsewhere = path.join(f.root, "catalog.json");
  write(elsewhere, f.catalog);
  fs.symlinkSync(elsewhere, file);
  assert.ok(renderHtmlSite(f.input, f.output).warnings.some((w) => w.includes("non-symbolic")));
});

test("identity mismatch, absent repositories and incomplete scans stay explicit", (t) => {
  const f = fixture(t);
  const extra = domainRepo({
    repository: { key: "github.com/acme/other", fullName: "acme/other" },
    status: "partial",
  });
  f.catalog.repositories.push(extra);
  f.catalog.repositories[0].repository.id = 99;
  write(path.join(f.input, "domain-inventory.json"), f.catalog);
  const result = renderHtmlSite(f.input, f.output);
  assert.ok(result.warnings.some((w) => w.includes("ID mismatch")));
  assert.equal(read(path.join(f.output, "domain-merge.json")).uniqueHosts, 0);
  f.catalog.repositories[0].repository.id = 1;
  f.catalog.repositories[0].status = "partial";
  write(path.join(f.input, "domain-inventory.json"), f.catalog);
  renderHtmlSite(f.input, f.output);
  assert.equal(read(path.join(f.output, "domain-merge.json")).incompleteRepositories, 1);
  assert.doesNotMatch(
    fs.readFileSync(path.join(f.output, "openapi/api.js"), "utf8"),
    /https:\/\/api\.example\.test/,
  );
  const collector = createDiagnosticCollector([]);
  assert.equal(
    loadDomainInventory(f.input, [{ repository: { fullName: "bad" } }], collector).summary
      .matchedRepositories,
    0,
  );
});

test("sidecar contract rejects malformed observations and bindings", (t) => {
  const f = fixture(t);
  for (const mutate of [
    (c) => {
      c.repositories.push(c.repositories[0]);
    },
    (c) => {
      c.repositories[0].domains.push(c.repositories[0].domains[0]);
    },
    (c) => {
      c.repositories[0].domains[0].hostname = "not a domain";
    },
    (c) => {
      c.repositories[0].domains[0].observations[0].scope = "public";
    },
    (c) => {
      c.repositories[0].domains[0].observations[0].port = "70000";
    },
    (c) => {
      c.repositories[0].domains[0].observations[0].urlPath = "//evil.example";
    },
  ]) {
    const clone = structuredClone(f.catalog);
    mutate(clone);
    assert.throws(() => validateDomainInventory(clone));
  }
  write(path.join(f.input, "domain-bindings.json"), { schemaVersion: 8 });
  assert.ok(renderHtmlSite(f.input, f.output).warnings.some((w) => w.includes("Bindings")));
  write(path.join(f.input, "domain-bindings.json"), null);
  assert.ok(
    renderHtmlSite(f.input, f.output).diagnostics.some(
      (d) => d.artifactPath === "domain-bindings.json",
    ),
  );
});

test("native OpenAPI enrichment preserves authored data, deduplicates and refuses unsafe associations", () => {
  const repo = domainRepo();
  const opts = { applicationIds: ["app:a"] };
  const source = document();
  source.paths["/health"].get.servers = [{ url: "https://authored.example" }];
  const enriched = enrichOpenApi(source, repo, opts);
  assert.equal(enriched.serversAdded, 1);
  assert.equal(source.servers, undefined);
  assert.deepEqual(source.paths, enriched.document.paths);
  assert.equal(enrichOpenApi(enriched.document, repo, opts).serversAdded, 0);
  assert.equal(enrichOpenApi({}, repo, opts).serversAdded, 0);
  for (const patch of [
    { applicationIds: [] },
    { applicationIds: ["app:a", "app:b"] },
    { scope: "external" },
    { environment: "staging" },
    { now: Date.now() + 31 * 86400000 },
  ]) {
    assert.equal(enrichOpenApi(source, repo, { ...opts, ...patch }).serversAdded, 0);
  }
  for (const mutate of [
    (r) => {
      r.status = "error";
    },
    (r) => {
      r.domains[0].observations[0].scheme = null;
    },
    (r) => {
      r.domains[0].observations[0].paths = ["/api/*"];
    },
    (r) => {
      r.domains[0].observations[0].hostname = "*.example.test";
    },
  ]) {
    const clone = structuredClone(repo);
    mutate(clone);
    assert.equal(enrichOpenApi(source, clone, opts).serversAdded, 0);
  }
  const prefixed = { ...source, servers: [{ url: "/v1" }] };
  assert.equal(enrichOpenApi(prefixed, repo, opts).serversAdded, 0);
  const binding = {
    repository: "acme/api",
    applicationId: "app:a",
    specification: "api.yaml",
    hostname: "api.example.test",
    environment: "production",
    scope: "internal",
    scheme: "http",
    basePath: "/v1",
  };
  const bindings = validateBindings({ schemaVersion: 1, bindings: [binding] });
  const bound = enrichOpenApi(prefixed, repo, { ...opts, specification: "api.yaml", bindings });
  assert.equal(bound.document.servers[1].url, "http://api.example.test/v1");
  assert.equal(
    enrichOpenApi(prefixed, repo, { ...opts, specification: "other.yaml", bindings }).serversAdded,
    0,
  );
  assert.throws(
    () =>
      enrichOpenApi(source, repo, {
        ...opts,
        specification: "api.yaml",
        bindings: { schemaVersion: 1, bindings: [binding, binding] },
      }),
    /Overlapping/,
  );
});

test("Swagger compatibility does not overwrite authored fields or arbitrarily pick a domain", () => {
  const repo = domainRepo();
  const opts = { applicationIds: ["app:a"] };
  const api = { swagger: "2.0", info: { title: "API", version: "1" }, paths: {} };
  assert.equal(enrichOpenApi(api, repo, opts).document.host, "api.example.test");
  assert.equal(
    enrichOpenApi({ ...api, host: "authored.example" }, repo, opts).document.host,
    "authored.example",
  );
  assert.equal(enrichOpenApi({ ...api, schemes: ["http"] }, repo, opts).serversAdded, 0);
  const bindings = validateBindings({
    schemaVersion: 1,
    bindings: [
      {
        repository: "acme/api",
        applicationId: "app:a",
        hostname: "api.example.test",
        basePath: "/v1",
      },
    ],
  });
  assert.equal(enrichOpenApi(api, repo, { ...opts, bindings }).document.basePath, "/v1");
  assert.equal(
    enrichOpenApi({ ...api, basePath: "/v1" }, repo, { ...opts, bindings }).serversAdded,
    1,
  );
  assert.equal(
    enrichOpenApi({ ...api, basePath: "/" }, repo, { ...opts, bindings }).serversAdded,
    0,
  );
});

test("host, binding and repository normalization reject unsafe values", () => {
  for (const value of [
    null,
    "",
    "${HOST}",
    "host with spaces",
    "foo/bar",
    "ftp://api.example",
    "https://a@b.test",
    "https://a.test?q=secret",
    "a.test:70000",
    "a.test:0",
    "-bad.test",
  ])
    assert.equal(normalizeHost(value), null);
  assert.equal(normalizeHost("API.TEST.").hostname, "api.test");
  assert.equal(normalizeHost("api.test:8443").port, "8443");
  assert.equal(normalizeHost("https://api.test/v1").urlPath, "/v1");
  assert.equal(normalizeHost("127.0.0.1").hostname, "127.0.0.1");
  assert.equal(repositoryKey("ACME/API"), "github.com/acme/api");
  for (const value of [null, "api", "acme/..", "acme/."]) assert.throws(() => repositoryKey(value));
  const rule = { repository: "acme/api", applicationId: "a", hostname: "api.test" };
  for (const patch of [
    { applicationId: null },
    { hostname: "Invalid Host" },
    { scheme: "ftp" },
    { scope: "unknown" },
    { basePath: "//evil" },
  ]) {
    assert.throws(() => validateBindings({ schemaVersion: 1, bindings: [{ ...rule, ...patch }] }));
  }
});
