"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  MAX_JSON_BYTES,
  escapeHtml,
  inputKind,
  renderHtmlSite,
  resolveInput,
} = require("../src/html");

const CLI = path.join(__dirname, "..", "src", "cli.js");

function temporary(name, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `express-recon-${name}-`));
  try {
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function routeReport(overrides = {}) {
  return {
    schemaVersion: "2.0",
    tool: "express-recon",
    toolVersion: "0.6.0",
    command: "audit",
    mode: "static",
    target: { name: "payments", version: "1.0.0" },
    applications: [
      {
        id: "app:src/app.js#app",
        name: "app.js#app",
        source: { file: "src/app.js", line: 8 },
        routeCount: 2,
      },
    ],
    routes: [
      {
        applicationId: "app:src/app.js#app",
        method: "GET",
        path: "/accounts",
        pathConfidence: "full",
        source: { file: "src/routes.js", line: 14 },
        middlewares: [{ name: "requireAuth", kind: "identifier", raw: "requireAuth" }],
        authStatus: "proven",
        tags: ["authenticated"],
        roles: ["reader"],
        scopes: [],
      },
      {
        applicationId: "app:src/app.js#app",
        method: "POST",
        path: "/accounts/<dynamic>",
        pathConfidence: "partial",
        source: null,
        middlewares: [],
        authStatus: "public",
        accepted: true,
        tags: [],
        roles: [],
        scopes: [],
      },
    ],
    globalMiddleware: [],
    summary: {
      routes: 2,
      public: 1,
      unknown: 0,
      proven: 1,
      accepted: 1,
      policyViolations: 0,
      policyExceptions: 0,
    },
    findings: [
      {
        id: "public-route",
        ruleId: "public-route",
        severity: "high",
        method: "POST",
        path: "/accounts/<dynamic>",
        detail: "No configured authentication guard matched.",
      },
    ],
    scanCoverage: {
      discovered: 4,
      analyzed: 3,
      failed: 1,
      skipped: 0,
      limited: false,
      totalBytes: 100,
      complete: false,
    },
    diagnostics: ["src/broken.js could not be parsed"],
    ...overrides,
  };
}

function repositoryScan(overrides = {}) {
  return {
    schemaVersion: "1.0",
    tool: "express-recon",
    toolVersion: "0.6.0",
    kind: "repository-scan",
    repository: {
      kind: "https",
      source: "acme/payments",
      requestedRef: "HEAD",
      commit: "abc123",
      executedTargetCode: false,
      installedDependencies: false,
      acquisition: { materializedFiles: 4, materializedBytes: 100 },
    },
    discovery: {
      packages: [
        {
          id: "package:.",
          root: ".",
          name: "payments",
          express: { versions: ["5.1.0"] },
        },
      ],
      applications: [],
      documentation: { specifications: ["openapi.yaml"], jsdoc: ["src/routes.js"] },
      orphanRoutes: 0,
    },
    inventory: routeReport(),
    documentation: {
      status: "merged",
      report: {
        summary: {
          codeOperations: 2,
          documentedOperations: 1,
          codeOnlyOperations: 1,
          docsOnlyOperations: 0,
          conflicts: 0,
        },
      },
    },
    ...overrides,
  };
}

test("HTML renderer escapes untrusted report content and creates an offline route site", () => {
  temporary("html-routes", (root) => {
    const payload = `<img src=x onerror="alert(1)"><script>alert(2)</script>`;
    const report = routeReport({
      target: { name: payload },
      routes: [
        {
          ...routeReport().routes[0],
          path: payload,
          middlewares: [{ name: payload, kind: "unknown", raw: payload }],
        },
      ],
    });
    writeJson(path.join(root, "routes.json"), report);
    const result = renderHtmlSite(root, path.join(root, "site"));
    const html = fs.readFileSync(result.output, "utf8");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "site", "render-manifest.json"), "utf8"),
    );

    assert.equal(result.source.kind, "routes");
    assert.equal(result.pages.length, 1);
    assert.equal(manifest.kind, "express-recon-html-site");
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /assets\/report\.css/);
    assert.match(html, /data-filter-search/);
    assert.match(html, /Incomplete scan coverage/);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.ok(fs.existsSync(path.join(root, "site", "assets", "report.js")));
    assert.ok(fs.existsSync(path.join(root, "site", "assets", "report.css")));
  });
});

test("repository folders render discovery, provenance, findings, routes, and docs", () => {
  temporary("html-repository", (root) => {
    writeJson(path.join(root, "repo-scan.json"), repositoryScan());
    writeJson(path.join(root, "routes.json"), routeReport({ target: { name: "wrong-priority" } }));
    const detected = resolveInput(root);
    assert.equal(detected.kind, "repository");
    assert.equal(path.basename(detected.file), "repo-scan.json");

    const result = renderHtmlSite(root, path.join(root, "site"));
    const html = fs.readFileSync(result.output, "utf8");
    for (const expected of [
      "acme/payments",
      "Repository snapshot",
      "Discovery",
      "Applications",
      "Findings",
      "Routes",
      "Documentation reconciliation",
      "Express 5.1.0",
    ]) {
      assert.match(html, new RegExp(expected.replace("/", "\\/")));
    }
  });
});

test("organization rendering writes per-repository pages and contains unsafe artifact paths", () => {
  temporary("html-organization", (root) => {
    const artifact = path.join(root, "repositories", "payments", "repo-scan.json");
    writeJson(artifact, repositoryScan());
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.json`);
    writeJson(outside, repositoryScan({ repository: { source: "must-not-be-read" } }));
    try {
      const organization = {
        schemaVersion: "1.0",
        tool: "express-recon",
        toolVersion: "0.6.0",
        kind: "github-organization-inventory",
        organization: { login: `acme<script>alert(1)</script>` },
        scope: { executionMode: "static", executedTargetCode: false },
        coverage: { complete: false, incompleteRepositories: ["acme/unsafe"] },
        summary: {
          repositoriesDiscovered: 3,
          repositoriesScanned: 2,
          expressRepositories: 2,
          applications: 2,
          routes: 4,
          failedRepositories: 0,
          inconclusiveRepositories: 1,
        },
        repositories: [
          {
            repository: { name: "payments", fullName: "acme/payments" },
            status: "express",
            scanned: true,
            coverageComplete: true,
            express: {
              applicationCount: 1,
              routeCount: 2,
              documentation: { reconciliationStatus: "merged" },
            },
            artifacts: { repositoryScan: "repositories/payments/repo-scan.json" },
          },
          {
            repository: { name: "payments", fullName: "acme/payments-copy" },
            status: "express",
            scanned: true,
            coverageComplete: true,
            express: { applicationCount: 1, routeCount: 2, documentation: {} },
            scan: repositoryScan({ repository: { source: "acme/payments-copy" } }),
          },
          {
            repository: { name: "unsafe", fullName: "acme/unsafe" },
            status: "inconclusive",
            scanned: true,
            coverageComplete: false,
            express: { applicationCount: 0, routeCount: 0, documentation: {} },
            artifacts: { repositoryScan: `../${path.basename(outside)}` },
          },
        ],
      };
      writeJson(path.join(root, "organization-inventory.json"), organization);
      const result = renderHtmlSite(root, path.join(root, "site"));
      const html = fs.readFileSync(result.output, "utf8");
      const manifest = JSON.parse(
        fs.readFileSync(path.join(root, "site", "render-manifest.json"), "utf8"),
      );

      assert.equal(result.source.kind, "organization");
      assert.equal(manifest.pages.length, 3);
      assert.equal(manifest.warnings.length, 1);
      assert.match(manifest.warnings[0], /escapes the input folder/);
      assert.match(html, /GitHub organization inventory/);
      assert.match(html, /Incomplete organization inventory/);
      assert.match(html, /Some detailed reports could not be rendered/);
      assert.match(html, /repositories\/payments\.html/);
      assert.match(html, /repositories\/payments-2\.html/);
      assert.match(html, /acme&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.doesNotMatch(html, /must-not-be-read/);
      assert.ok(fs.existsSync(path.join(root, "site", "repositories", "payments.html")));
      assert.ok(fs.existsSync(path.join(root, "site", "repositories", "payments-2.html")));
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

test("HTML input and output validation fail clearly", () => {
  temporary("html-invalid", (root) => {
    assert.equal(escapeHtml(`<&>"'`), "&lt;&amp;&gt;&quot;&#39;");
    assert.equal(inputKind(routeReport()), "routes");
    assert.equal(inputKind(repositoryScan()), "repository");
    assert.throws(() => inputKind({ routes: [] }), /Unsupported HTML report input/);
    assert.throws(() => renderHtmlSite(), /requires an input path/);
    assert.throws(() => renderHtmlSite(root), /requires an output directory/);
    assert.throws(
      () => resolveInput(path.join(root, "missing")),
      /Could not read HTML report input/,
    );
    assert.throws(() => resolveInput(root), /No supported report found/);

    const directoryInput = path.join(root, "directory-input");
    fs.mkdirSync(path.join(directoryInput, "routes.json"), { recursive: true });
    assert.throws(() => resolveInput(directoryInput), /input is not a file/);

    writeJson(path.join(root, "routes.json"), { nope: true });
    assert.throws(() => resolveInput(root), /Unsupported HTML report input/);
    fs.writeFileSync(path.join(root, "routes.json"), "not json");
    assert.throws(() => resolveInput(root), /Could not parse HTML report input/);

    fs.truncateSync(path.join(root, "routes.json"), MAX_JSON_BYTES + 1);
    assert.throws(() => resolveInput(root), /exceeds/);

    writeJson(path.join(root, "routes.json"), routeReport());
    fs.writeFileSync(path.join(root, "output-file"), "occupied");
    assert.throws(
      () => renderHtmlSite(root, path.join(root, "output-file")),
      /output is not a directory/,
    );

    const incompleteRepository = path.join(root, "incomplete-repository.json");
    writeJson(incompleteRepository, { kind: "repository-scan", inventory: {} });
    const fallback = renderHtmlSite(incompleteRepository, path.join(root, "fallback-site"));
    assert.match(fs.readFileSync(fallback.output, "utf8"), /Inventory unavailable/);
  });
});

test("organization rendering rejects absolute, missing, wrong-kind, and escaping symlink artifacts", () => {
  temporary("html-artifacts", (root) => {
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.json`);
    const wrongKind = path.join(root, "repositories", "wrong", "routes.json");
    writeJson(outside, repositoryScan());
    writeJson(wrongKind, routeReport());
    const symlink = path.join(root, "repositories", "linked", "repo-scan.json");
    fs.mkdirSync(path.dirname(symlink), { recursive: true });
    fs.symlinkSync(outside, symlink);
    try {
      writeJson(path.join(root, "organization-inventory.json"), {
        kind: "github-organization-inventory",
        organization: { login: "acme" },
        coverage: { complete: true },
        summary: {},
        repositories: [
          {
            repository: { fullName: "acme/absolute" },
            artifacts: { repositoryScan: outside },
          },
          {
            repository: { fullName: "acme/missing" },
            artifacts: { repositoryScan: "repositories/missing/repo-scan.json" },
          },
          {
            repository: { fullName: "acme/wrong" },
            artifacts: { repositoryScan: "repositories/wrong/routes.json" },
          },
          {
            repository: { fullName: "acme/linked" },
            artifacts: { repositoryScan: "repositories/linked/repo-scan.json" },
          },
        ],
      });
      const result = renderHtmlSite(root, path.join(root, "site"));
      assert.equal(result.pages.length, 1);
      assert.equal(result.warnings.length, 4);
      assert.ok(result.warnings.some((warning) => /must be relative/.test(warning)));
      assert.ok(result.warnings.some((warning) => /Could not read|ENOENT/.test(warning)));
      assert.ok(result.warnings.some((warning) => /wrong kind/.test(warning)));
      assert.ok(result.warnings.some((warning) => /symlink escapes/.test(warning)));
      assert.ok(result.warnings.every((warning) => !warning.includes(root)));
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

test("rerendering removes only stale files owned by the previous manifest", () => {
  temporary("html-rerender", (root) => {
    const organizationFile = path.join(root, "organization-inventory.json");
    const output = path.join(root, "site");
    const organization = (repositories) => ({
      kind: "github-organization-inventory",
      organization: { login: "acme" },
      coverage: { complete: true },
      summary: {},
      repositories,
    });
    const entry = (name) => ({
      repository: { name, fullName: `acme/${name}` },
      status: "express",
      scanned: true,
      coverageComplete: true,
      express: { applicationCount: 1, routeCount: 2, documentation: {} },
      scan: repositoryScan({ repository: { source: `acme/${name}` } }),
    });

    writeJson(organizationFile, organization([entry("one"), entry("two")]));
    renderHtmlSite(root, output);
    const stale = path.join(output, "repositories", "two.html");
    assert.ok(fs.existsSync(stale));
    fs.writeFileSync(path.join(output, "keep.txt"), "not renderer-owned");

    writeJson(organizationFile, organization([entry("one")]));
    const result = renderHtmlSite(root, output);
    assert.equal(result.pages.length, 2);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.readFileSync(path.join(output, "keep.txt"), "utf8"), "not renderer-owned");
  });
});

test("renderer refuses nonempty unowned output and unsafe prior manifests", () => {
  temporary("html-output-safety", (root) => {
    writeJson(path.join(root, "routes.json"), routeReport());
    const unowned = path.join(root, "unowned");
    fs.mkdirSync(unowned);
    fs.writeFileSync(path.join(unowned, "keep.txt"), "keep");
    assert.throws(() => renderHtmlSite(root, unowned), /not empty and has no render-manifest/);

    const outside = path.join(root, "outside.html");
    fs.writeFileSync(outside, "keep outside");
    const unsafe = path.join(root, "unsafe");
    fs.mkdirSync(unsafe);
    writeJson(path.join(unsafe, "render-manifest.json"), {
      kind: "express-recon-html-site",
      pages: ["../outside.html"],
      assets: [],
    });
    assert.throws(() => renderHtmlSite(root, unsafe), /unsafe path/);
    assert.equal(fs.readFileSync(outside, "utf8"), "keep outside");
    assert.ok(fs.existsSync(path.join(unsafe, "render-manifest.json")));
  });
});

test("render CLI requires explicit input/output and returns a bounded result", () => {
  temporary("html-cli", (root) => {
    writeJson(
      path.join(root, "routes.json"),
      routeReport({ command: "inventory", findings: undefined }),
    );
    const output = path.join(root, "site");
    const success = spawnSync(process.execPath, [CLI, "render", "--input", root, "--out", output], {
      encoding: "utf8",
    });
    assert.equal(success.status, 0, success.stderr);
    assert.deepEqual(JSON.parse(success.stdout), {
      kind: "html-render-result",
      sourceKind: "routes",
      output: path.join(output, "index.html"),
      pages: 1,
      warnings: 0,
    });

    for (const args of [
      ["render", "--input", root],
      ["render", "--out", output],
      ["render", "--input", root, "--out", output, "--src", "."],
    ]) {
      const failure = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
      assert.equal(failure.status, 1);
      assert.ok(failure.stderr.trim());
    }
  });
});
