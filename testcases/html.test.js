"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

const {
  MAX_JSON_BYTES,
  MAX_OPENAPI_BYTES,
  defaultRenderOutput,
  detectRenderInput,
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

function openApiDocument(overrides = {}) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Payments API",
      version: "1.2.0",
      summary: "Payment operations",
      description: "A standalone contract.",
    },
    servers: [{ url: "https://api.example.test/{region}", description: "Production template" }],
    tags: [{ name: "accounts", description: "Account operations" }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/accounts/{id}": {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            description: "Account identifier",
            schema: { type: "string" },
          },
        ],
        get: {
          operationId: "getAccount",
          summary: "Get an account",
          description: "Returns one account.",
          tags: ["accounts"],
          responses: {
            200: {
              description: "Found",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Account" } } },
            },
            default: { $ref: "https://schemas.example.test/errors.yaml#/Error" },
          },
        },
        post: {
          operationId: "updateAccount",
          summary: "Update an account",
          tags: ["accounts"],
          security: [],
          requestBody: {
            required: true,
            description: "Replacement fields",
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: { 204: { description: "Updated" } },
        },
      },
    },
    webhooks: {
      "payment.completed": {
        post: {
          summary: "Payment completed",
          tags: ["events"],
          responses: { 200: { description: "Accepted" } },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Bearer token" },
      },
      schemas: { Account: { type: "object" } },
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
          io: {
            schemas: {
              request: {
                body: {
                  schema: { type: "object" },
                  evidence: [{ kind: "zod", confidence: "high" }],
                },
              },
              responses: [],
              conflicts: [
                {
                  location: "request.body.value",
                  kind: "type-mismatch",
                  message: payload,
                  evidence: [],
                },
              ],
            },
          },
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
    assert.match(html, /I\/O schema evidence/);
    assert.match(html, /high · zod · 1 conflict/);
    assert.match(html, /Typed I\/O routes/);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.ok(fs.existsSync(path.join(root, "site", "assets", "report.js")));
    assert.ok(fs.existsSync(path.join(root, "site", "assets", "report.css")));
  });
});

test("OpenAPI JSON renders with packaged Swagger UI and offline-safe defaults", () => {
  temporary("html-openapi-json", (root) => {
    const injection = `</script><script>alert("rendered")</script>`;
    const document = openApiDocument({
      info: {
        ...openApiDocument().info,
        title: `Payments ${injection}`,
        description: `Untrusted ${injection}`,
      },
    });
    document["x-object"] = JSON.parse('{"__proto__":{"polluted":true}}');
    writeJson(path.join(root, "openapi.json"), document);

    const detected = resolveInput(root);
    assert.equal(detected.kind, "openapi");
    assert.equal(path.basename(detected.file), "openapi.json");

    const output = path.join(root, "site");
    const result = renderHtmlSite(root, output);
    const html = fs.readFileSync(result.output, "utf8");
    const config = fs.readFileSync(path.join(output, "assets", "openapi-config.js"), "utf8");
    const manifest = JSON.parse(fs.readFileSync(path.join(output, "render-manifest.json"), "utf8"));

    assert.equal(result.source.kind, "openapi");
    assert.equal(result.pages.length, 1);
    assert.deepEqual(manifest.assets, [
      "assets/swagger-ui.css",
      "assets/swagger-ui-bundle.js",
      "assets/swagger-ui-bundle.js.LICENSE.txt",
      "assets/swagger-ui-LICENSE.txt",
      "assets/swagger-ui-NOTICE.txt",
      "assets/openapi-config.js",
    ]);
    assert.match(html, /assets\/swagger-ui\.css/);
    assert.match(html, /assets\/swagger-ui-bundle\.js/);
    assert.match(html, /assets\/openapi-config\.js/);
    assert.match(html, /connect-src 'none'/);
    assert.match(html, /Payments &lt;\/script&gt;&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.doesNotMatch(html, /https?:\/\//);
    assert.match(config, /const spec = JSON\.parse\("\{\\"openapi\\":\\"3\.1\.0\\"/);
    assert.match(config, /\\u003c\/script\\u003e\\u003cscript\\u003e/);
    assert.doesNotMatch(config, /<\/script>/i);
    assert.match(config, /queryConfigEnabled: false/);
    assert.match(config, /supportedSubmitMethods: \[\]/);
    assert.match(config, /tryItOutEnabled: false/);
    assert.match(config, /validatorUrl: null/);
    assert.doesNotMatch(config, /^\s*(?:configUrl|url):/m);

    let swaggerConfiguration;
    const browserGlobal = {};
    vm.runInNewContext(config, {
      SwaggerUIBundle: (value) => {
        swaggerConfiguration = value;
        return { initialized: true };
      },
      window: browserGlobal,
    });
    assert.equal(swaggerConfiguration.spec.info.title, document.info.title);
    assert.equal(Object.hasOwn(swaggerConfiguration.spec["x-object"], "__proto__"), true);
    assert.equal(swaggerConfiguration.spec["x-object"].polluted, undefined);
    assert.equal(swaggerConfiguration.dom_id, "#swagger-ui");
    assert.deepEqual(Array.from(swaggerConfiguration.supportedSubmitMethods), []);
    assert.equal(swaggerConfiguration.validatorUrl, null);
    assert.equal(browserGlobal.ui.initialized, true);

    assert.equal(fs.existsSync(path.join(output, "assets", "report.css")), false);
    assert.equal(fs.existsSync(path.join(output, "assets", "report.js")), false);
    for (const asset of manifest.assets) {
      assert.ok(fs.statSync(path.join(output, ...asset.split("/"))).isFile(), asset);
    }
  });
});

test("OpenAPI and Swagger inputs render directly while malformed contracts fail clearly", () => {
  temporary("html-openapi-yaml", (root) => {
    const specification = path.join(root, "openapi.yaml");
    fs.writeFileSync(
      specification,
      [
        'openapi: "3.0.3"',
        "info:",
        "  title: YAML API",
        '  version: "1.0"',
        "paths:",
        "  /health:",
        "    get:",
        "      responses:",
        '        "200":',
        "          description: Healthy",
        "",
      ].join("\n"),
    );

    const result = renderHtmlSite(specification, path.join(root, "yaml-site"));
    assert.equal(result.source.kind, "openapi");
    assert.match(
      fs.readFileSync(path.join(root, "yaml-site", "assets", "openapi-config.js"), "utf8"),
      /YAML API/,
    );
    assert.equal(inputKind(openApiDocument()), "openapi");
    const swagger = {
      swagger: "2.0",
      info: { title: "Legacy", version: "1" },
      paths: {},
    };
    assert.equal(inputKind(swagger), "openapi");
    const swaggerFile = path.join(root, "swagger.json");
    writeJson(swaggerFile, swagger);
    const swaggerResult = renderHtmlSite(swaggerFile, path.join(root, "swagger-site"));
    assert.match(
      fs.readFileSync(path.join(root, "swagger-site", "assets", "openapi-config.js"), "utf8"),
      /Legacy/,
    );
    assert.equal(swaggerResult.source.kind, "openapi");
    assert.throws(
      () => inputKind({ swagger: "1.2", info: { title: "Legacy" }, paths: {} }),
      /Swagger version 1\.2/,
    );
    assert.throws(
      () => inputKind({ openapi: "2.0.0", info: { title: "Legacy" }, paths: {} }),
      /OpenAPI version 2\.0\.0/,
    );
    assert.throws(
      () => inputKind({ openapi: "3.1.0", info: { title: "Missing paths" } }),
      /requires an object paths field/,
    );
    assert.throws(
      () => renderHtmlSite(specification, path.join(root, "baseline-site"), { baseline: root }),
      /requires an organization inventory input/,
    );

    const cyclic = path.join(root, "cyclic.yaml");
    fs.writeFileSync(
      cyclic,
      [
        'openapi: "3.1.0"',
        "info:",
        "  title: Cyclic API",
        '  version: "1.0"',
        "paths: {}",
        "components:",
        "  schemas:",
        "    Loop: &loop",
        "      self: *loop",
        "",
      ].join("\n"),
    );
    assert.throws(
      () => renderHtmlSite(cyclic, path.join(root, "cyclic-site")),
      /cyclic YAML alias/,
    );

    const oversized = path.join(root, "oversized.yaml");
    fs.writeFileSync(oversized, "");
    fs.truncateSync(oversized, MAX_OPENAPI_BYTES + 1);
    assert.throws(() => renderHtmlSite(oversized, path.join(root, "oversized-site")), /exceed/);
  });
});

test("render input and output defaults are bounded and refuse ambiguity", () => {
  temporary("html-path-defaults", (root) => {
    const workspace = path.join(root, "workspace");
    const first = path.join(workspace, ".express-recon", "first");
    fs.mkdirSync(first, { recursive: true });
    writeJson(path.join(first, "routes.json"), routeReport());

    assert.equal(detectRenderInput(workspace), first);
    assert.equal(defaultRenderOutput(first), `${first}-html`);
    assert.equal(defaultRenderOutput(path.join(first, "routes.json")), `${first}-html`);

    const named = path.join(workspace, "contracts", "payments.yaml");
    fs.mkdirSync(path.dirname(named), { recursive: true });
    fs.writeFileSync(
      named,
      'openapi: "3.1.0"\ninfo: { title: Payments, version: "1" }\npaths: {}\n',
    );
    assert.equal(defaultRenderOutput(named), path.join(workspace, "contracts", "payments-html"));

    const second = path.join(workspace, ".express-recon", "second");
    fs.mkdirSync(second, { recursive: true });
    writeJson(path.join(second, "repo-scan.json"), repositoryScan());
    assert.throws(() => detectRenderInput(workspace), /multiple possible inputs.*first.*second/);

    const empty = path.join(root, "empty");
    fs.mkdirSync(empty);
    assert.throws(() => detectRenderInput(empty), /could not auto-detect an input/);

    const linked = path.join(root, "linked-workspace");
    fs.mkdirSync(linked);
    fs.symlinkSync(path.join(workspace, ".express-recon"), path.join(linked, ".express-recon"));
    assert.throws(() => detectRenderInput(linked), /cannot auto-detect through/);

    const linkedInput = path.join(root, "linked-input");
    fs.mkdirSync(linkedInput);
    fs.symlinkSync(path.join(first, "routes.json"), path.join(linkedInput, "routes.json"));
    assert.throws(() => detectRenderInput(linkedInput), /symbolic input candidate/);
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

test("repository reports without package target metadata use repository identity", () => {
  temporary("html-repository-without-target", (root) => {
    const scan = repositoryScan({
      repository: {
        ...repositoryScan().repository,
        source: "https://github.com/acme/no-package",
      },
      inventory: routeReport({
        target: null,
        applications: [],
        routes: [],
        findings: [],
        summary: { routes: 0 },
      }),
    });
    writeJson(path.join(root, "repo-scan.json"), scan);

    const result = renderHtmlSite(root, path.join(root, "site"));
    const html = fs.readFileSync(result.output, "utf8");
    assert.equal(result.pages.length, 1);
    assert.match(html, /https:\/\/github\.com\/acme\/no-package/);
    assert.match(html, /No routes were recorded/);
  });
});

test("repository folders render their retained specification catalog", () => {
  temporary("html-repository-spec-catalog", (root) => {
    const specification = openApiDocument({ info: { title: "Catalog API", version: "1" } });
    writeJson(path.join(root, "specifications", "catalog.json"), specification);
    writeJson(
      path.join(root, "repo-scan.json"),
      repositoryScan({
        documentation: {
          status: "cataloged",
          reason: "The source contract was cataloged.",
          summary: { available: 1, openapi: 1, swagger: 0, reconciled: 0 },
          specifications: [
            {
              path: "docs/catalog.yaml",
              format: "openapi",
              version: "3.1.0",
              title: "Catalog API",
              status: "retained",
              artifact: "specifications/catalog.json",
            },
          ],
        },
      }),
    );

    const output = path.join(root, "site");
    const result = renderHtmlSite(root, output);
    const overview = fs.readFileSync(result.output, "utf8");
    assert.equal(result.pages.length, 2);
    assert.match(overview, /Catalog API/);
    assert.match(overview, /openapi\/acme-payments--docs-catalog\.html/);
    assert.ok(fs.existsSync(path.join(output, "openapi", "acme-payments--docs-catalog.html")));
  });
});

test("repository reports render bounded embedded specification catalogs", () => {
  temporary("html-repository-embedded-spec-catalog", (root) => {
    const source = openApiDocument({ info: { title: "Source API", version: "1" } });
    const reconciled = openApiDocument({ info: { title: "Reconciled API", version: "2" } });
    const legacy = {
      swagger: "2.0",
      info: { title: "Legacy API", version: "1" },
      paths: {},
    };
    writeJson(
      path.join(root, "repo-scan.json"),
      repositoryScan({
        documentation: {
          status: "cataloged",
          specifications: [
            {
              path: "docs/source.yaml",
              format: "openapi",
              version: "3.1.0",
              title: "Source API",
              document: source,
              reconciliation: {
                status: "merged",
                document: reconciled,
              },
            },
            {
              path: "docs/legacy.yaml",
              format: "swagger",
              version: "2.0",
              title: "Legacy API",
              document: legacy,
            },
          ],
        },
      }),
    );

    const output = path.join(root, "site");
    const result = renderHtmlSite(root, output);
    const overview = fs.readFileSync(result.output, "utf8");
    assert.equal(result.pages.length, 4);
    assert.match(overview, /Source API/);
    assert.match(overview, /Source API \(reconciled\)/);
    assert.match(overview, /Legacy API/);
    assert.equal(result.warnings.length, 0);
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
          repositoriesDiscovered: 5,
          repositoriesScanned: 4,
          expressRepositories: 2,
          nonExpressRepositories: 1,
          applications: 2,
          routes: 4,
          failedRepositories: 0,
          inconclusiveRepositories: 2,
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
            repository: { name: "no-express", fullName: "acme/no-express" },
            status: "not-express",
            scanned: true,
            coverageComplete: true,
            express: { applicationCount: 0, routeCount: 0, documentation: {} },
            scan: repositoryScan({ repository: { source: "must-not-be-rendered" } }),
          },
          {
            repository: { name: "partial", fullName: "acme/partial" },
            status: "inconclusive",
            scanned: true,
            coverageComplete: false,
            express: { applicationCount: 0, routeCount: 0, documentation: {} },
            scan: repositoryScan({ repository: { source: "acme/partial" } }),
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
      assert.equal(manifest.pages.length, 4);
      assert.equal(manifest.warnings.length, 1);
      assert.match(manifest.warnings[0], /escapes the input folder/);
      assert.match(html, /GitHub organization inventory/);
      assert.match(html, /Incomplete organization inventory/);
      assert.match(html, /Some detailed reports or API references could not be rendered/);
      assert.match(html, /repositories\/payments\.html/);
      assert.match(html, /repositories\/payments-2\.html/);
      assert.match(html, /repositories\/partial\.html/);
      assert.match(html, /View diagnostics/);
      assert.match(html, /No supported framework report/);
      assert.doesNotMatch(html, /repositories\/no-express\.html/);
      assert.doesNotMatch(html, /must-not-be-rendered/);
      assert.match(html, /acme&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.doesNotMatch(html, /must-not-be-read/);
      assert.ok(fs.existsSync(path.join(root, "site", "repositories", "payments.html")));
      assert.ok(fs.existsSync(path.join(root, "site", "repositories", "payments-2.html")));
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

test("organization folders render supported-framework OpenAPI artifacts with one shared bundle", () => {
  temporary("html-organization-openapi", (root) => {
    const scanFile = path.join(root, "repositories", "api", "repo-scan.json");
    const specificationFile = path.join(root, "repositories", "api", "openapi.json");
    const organizationFile = path.join(root, "organization-inventory.json");
    const output = path.join(root, "site");
    const scan = repositoryScan({
      documentation: {
        status: "merged",
        document: openApiDocument({
          info: { title: "Embedded fallback", version: "1" },
        }),
        report: repositoryScan().documentation.report,
      },
    });
    writeJson(scanFile, scan);
    writeJson(
      specificationFile,
      openApiDocument({ info: { title: "Organization API", version: "2" } }),
    );
    writeJson(organizationFile, {
      kind: "github-organization-inventory",
      organization: { login: "acme" },
      coverage: { complete: true },
      summary: {
        repositoriesScanned: 2,
        supportedRepositories: 1,
        expressRepositories: 0,
        fastifyRepositories: 1,
      },
      repositories: [
        {
          repository: { name: "api", fullName: "acme/api" },
          status: "fastify",
          coverageComplete: true,
          frameworks: {
            detected: true,
            names: ["fastify"],
            items: [
              {
                name: "fastify",
                classification: { role: "application", confidence: "high" },
              },
            ],
            applicationCount: 1,
            routeCount: 2,
            documentation: { reconciliationStatus: "merged" },
          },
          express: {
            applicationCount: 1,
            routeCount: 2,
            documentation: { reconciliationStatus: "merged" },
          },
          artifacts: {
            repositoryScan: "repositories/api/repo-scan.json",
            openapi: "repositories/api/openapi.json",
          },
        },
        {
          repository: { name: "frontend", fullName: "acme/frontend" },
          status: "not-express",
          coverageComplete: true,
          express: { applicationCount: 0, routeCount: 0, documentation: {} },
          artifacts: { openapi: "../../must-not-be-read.json" },
        },
      ],
    });

    const result = renderHtmlSite(root, output);
    const overview = fs.readFileSync(result.output, "utf8");
    const detail = fs.readFileSync(path.join(output, "repositories", "api.html"), "utf8");
    const reference = fs.readFileSync(path.join(output, "openapi", "api.html"), "utf8");
    const config = fs.readFileSync(path.join(output, "openapi", "api.js"), "utf8");
    const manifest = JSON.parse(fs.readFileSync(path.join(output, "render-manifest.json"), "utf8"));

    assert.equal(result.warnings.length, 0);
    assert.match(overview, /openapi\/api\.html/);
    assert.match(overview, /API reference/);
    assert.match(overview, /fastify: application/);
    assert.match(detail, /\.\.\/openapi\/api\.html/);
    assert.match(reference, /\.\.\/assets\/swagger-ui\.css/);
    assert.match(reference, /src="api\.js"/);
    assert.match(config, /Organization API/);
    assert.doesNotMatch(config, /Embedded fallback/);
    assert.doesNotMatch(overview, /openapi\/frontend\.html/);
    assert.equal(
      manifest.assets.filter((asset) => asset === "assets/swagger-ui-bundle.js").length,
      1,
    );
    assert.deepEqual(
      manifest.pages.filter((page) => page.startsWith("openapi/")),
      ["openapi/api.html"],
    );

    fs.writeFileSync(path.join(output, "keep.txt"), "not renderer-owned");
    const aggregate = JSON.parse(fs.readFileSync(organizationFile, "utf8"));
    delete aggregate.repositories[0].artifacts.openapi;
    writeJson(organizationFile, aggregate);
    writeJson(scanFile, repositoryScan());
    renderHtmlSite(root, output);

    assert.equal(fs.existsSync(path.join(output, "openapi", "api.html")), false);
    assert.equal(fs.existsSync(path.join(output, "openapi", "api.js")), false);
    assert.equal(fs.existsSync(path.join(output, "assets", "swagger-ui.css")), false);
    assert.equal(fs.readFileSync(path.join(output, "keep.txt"), "utf8"), "not renderer-owned");
  });
});

test("organization rendering catalogs every retained OpenAPI and Swagger specification", () => {
  temporary("html-organization-spec-catalog", (root) => {
    const repositoryDirectory = path.join(root, "repositories", "api");
    const scanFile = path.join(repositoryDirectory, "repo-scan.json");
    const primaryArtifact = "repositories/api/specifications/docs-primary.json";
    const legacyArtifact = "repositories/api/specifications/docs-legacy.json";
    const documentation = {
      status: "cataloged",
      reason: "Two API specifications were retained independently.",
      summary: { available: 2, openapi: 1, swagger: 1, reconciled: 0 },
      specifications: [
        {
          path: "docs/primary.yaml",
          format: "openapi",
          version: "3.1.0",
          title: "Primary API",
          status: "retained",
          artifact: "specifications/docs-primary.json",
        },
        {
          path: "docs/legacy.json",
          format: "swagger",
          version: "2.0",
          title: "Legacy API",
          status: "retained",
          artifact: "specifications/docs-legacy.json",
        },
      ],
    };
    writeJson(scanFile, repositoryScan({ documentation }));
    writeJson(path.join(root, primaryArtifact), openApiDocument());
    writeJson(path.join(root, legacyArtifact), {
      swagger: "2.0",
      info: { title: "Legacy API", version: "1" },
      paths: { "/legacy": { get: { responses: { 200: { description: "ok" } } } } },
    });
    writeJson(path.join(root, "organization-inventory.json"), {
      kind: "github-organization-inventory",
      organization: { login: "acme" },
      coverage: { complete: true },
      summary: { repositoriesScanned: 1, supportedRepositories: 1, expressRepositories: 1 },
      repositories: [
        {
          repository: { name: "api", fullName: "acme/api" },
          status: "express",
          coverageComplete: true,
          routeGraphComplete: true,
          express: {
            applicationCount: 1,
            routeCount: 2,
            documentation: { reconciliationStatus: "cataloged", specifications: 2 },
          },
          artifacts: {
            repositoryScan: "repositories/api/repo-scan.json",
            specifications: [
              {
                path: "docs/primary.yaml",
                format: "openapi",
                version: "3.1.0",
                title: "Primary API",
                status: "retained",
                artifact: primaryArtifact,
              },
              {
                path: "docs/legacy.json",
                format: "swagger",
                version: "2.0",
                title: "Legacy API",
                status: "retained",
                artifact: legacyArtifact,
              },
            ],
          },
        },
      ],
    });

    const output = path.join(root, "site");
    const result = renderHtmlSite(root, output);
    const overview = fs.readFileSync(result.output, "utf8");
    const detail = fs.readFileSync(path.join(output, "repositories", "api.html"), "utf8");
    const manifest = JSON.parse(fs.readFileSync(path.join(output, "render-manifest.json"), "utf8"));

    assert.equal(result.warnings.length, 0);
    assert.match(overview, /2 API references/);
    assert.match(overview, /repositories\/api\.html#api-specifications/);
    assert.match(detail, /Primary API/);
    assert.match(detail, /Legacy API/);
    assert.match(detail, /\.\.\/openapi\/api--docs-primary\.html/);
    assert.match(detail, /\.\.\/openapi\/api--docs-legacy\.html/);
    assert.ok(fs.existsSync(path.join(output, "openapi", "api--docs-primary.html")));
    assert.ok(fs.existsSync(path.join(output, "openapi", "api--docs-legacy.html")));
    assert.match(
      fs.readFileSync(path.join(output, "openapi", "api--docs-legacy.js"), "utf8"),
      /swagger.*2\.0/,
    );
    assert.equal(
      manifest.assets.filter((asset) => asset === "assets/swagger-ui-bundle.js").length,
      1,
    );
    assert.deepEqual(manifest.pages.filter((page) => page.startsWith("openapi/")).sort(), [
      "openapi/api--docs-legacy.html",
      "openapi/api--docs-primary.html",
    ]);
  });
});

test("organization OpenAPI references fail closed without falling back or inspecting unsupported entries", () => {
  temporary("html-organization-openapi-safety", (root) => {
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.json`);
    const wrongKind = path.join(root, "repositories", "wrong", "routes.json");
    const linked = path.join(root, "repositories", "linked", "openapi.json");
    writeJson(outside, openApiDocument({ info: { title: "Outside secret", version: "1" } }));
    writeJson(wrongKind, routeReport());
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    fs.symlinkSync(outside, linked);

    const invalidReferences = [
      outside,
      "../outside.json",
      "repositories/missing/openapi.json",
      "repositories/wrong/routes.json",
      "repositories/linked/openapi.json",
    ];
    const embedded = repositoryScan({
      documentation: {
        status: "merged",
        document: openApiDocument({ info: { title: "Must not fallback", version: "1" } }),
        report: repositoryScan().documentation.report,
      },
    });
    try {
      writeJson(path.join(root, "organization-inventory.json"), {
        kind: "github-organization-inventory",
        organization: { login: "acme" },
        coverage: { complete: false },
        summary: {},
        repositories: [
          ...invalidReferences.map((reference, index) => ({
            repository: { name: `api-${index}`, fullName: `acme/api-${index}` },
            status: "express",
            scan: embedded,
            artifacts: { openapi: reference },
          })),
          {
            repository: { name: "frontend", fullName: "acme/frontend" },
            status: "not-express",
            artifacts: { openapi: outside },
          },
        ],
      });

      const output = path.join(root, "site");
      const result = renderHtmlSite(root, output);
      const overview = fs.readFileSync(result.output, "utf8");
      assert.equal(result.warnings.length, invalidReferences.length);
      assert.ok(
        result.warnings.some((warning) => /must be a non-empty relative path/.test(warning)),
      );
      assert.ok(result.warnings.some((warning) => /escapes the input folder/.test(warning)));
      assert.ok(result.warnings.some((warning) => /Could not read|ENOENT/.test(warning)));
      assert.ok(result.warnings.some((warning) => /wrong kind/.test(warning)));
      assert.ok(result.warnings.some((warning) => /symlink escapes/.test(warning)));
      assert.ok(result.warnings.every((warning) => !warning.includes(root)));
      assert.ok(result.warnings.every((warning) => !warning.includes("frontend")));
      assert.doesNotMatch(overview, /openapi\/api-/);
      assert.doesNotMatch(overview, /Outside secret|Must not fallback/);
      assert.equal(fs.existsSync(path.join(output, "openapi")), false);
      assert.equal(fs.existsSync(path.join(output, "assets", "swagger-ui.css")), false);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

test("organization rendering surfaces bounded baseline changes in overview and repository pages", () => {
  temporary("html-organization-delta", (root) => {
    const scan = repositoryScan({
      inventory: routeReport({
        routes: [
          {
            ...routeReport().routes[0],
            method: "POST",
            path: "/new-route",
          },
        ],
      }),
    });
    writeJson(path.join(root, "repositories", "payments", "repo-scan.json"), scan);
    writeJson(
      path.join(root, "repositories", "legacy", "repo-scan.json"),
      repositoryScan({
        repository: { ...repositoryScan().repository, source: "acme/legacy" },
        inventory: routeReport({ routes: [], findings: [], summary: { routes: 0 } }),
      }),
    );
    writeJson(path.join(root, "organization-inventory.json"), {
      kind: "github-organization-inventory",
      organization: { login: "acme" },
      scope: { fingerprint: "same-scope" },
      coverage: { complete: true },
      summary: { repositoriesDiscovered: 2, repositoriesScanned: 2, expressRepositories: 1 },
      repositories: [
        {
          repository: { name: "payments", fullName: "acme/payments" },
          status: "express",
          coverageComplete: true,
          express: { applicationCount: 1, routeCount: 1, documentation: {} },
          artifacts: { repositoryScan: "repositories/payments/repo-scan.json" },
        },
        {
          repository: { name: "legacy", fullName: "acme/legacy" },
          status: "not-express",
          coverageComplete: true,
          express: { applicationCount: 0, routeCount: 0, documentation: {} },
          artifacts: { repositoryScan: "repositories/legacy/repo-scan.json" },
        },
      ],
      delta: {
        kind: "github-organization-inventory-delta",
        artifact: "organization-delta.json",
        organization: { login: "acme" },
      },
    });
    writeJson(path.join(root, "organization-delta.json"), {
      schemaVersion: "1.0",
      kind: "github-organization-inventory-delta",
      organization: { login: "acme" },
      current: { scopeFingerprint: "same-scope" },
      coverage: { complete: true, exactComparisonFailures: 0 },
      summary: {
        repositoriesAdded: 0,
        repositoriesRemoved: 0,
        repositoriesChanged: 2,
        newlyExpressRepositories: 0,
        addedRoutes: 1,
        removedRoutes: 1,
        authRegressions: 0,
      },
      repositories: [
        {
          repository: { name: "payments", fullName: "acme/payments" },
          change: "changed",
          before: { status: "express", routes: 0 },
          after: { status: "express", routes: 1 },
          changes: {
            statusChanged: false,
            applicationsDelta: 0,
            routeCountDelta: 1,
            documentationChanged: false,
            routes: {
              summary: {
                addedRoutes: 1,
                removedRoutes: 0,
                authRegressions: 0,
                authImprovements: 0,
                newFindings: 0,
                resolvedFindings: 0,
              },
              details: {
                addedRoutes: [
                  {
                    applicationId: "app:src/app.js#app",
                    method: "POST",
                    path: "/new-route",
                    source: { file: "src/app.js", line: 9 },
                  },
                ],
              },
              detailsRetained: 1,
              detailsTruncated: false,
            },
          },
        },
        {
          repository: { name: "legacy", fullName: "acme/legacy" },
          change: "changed",
          before: { status: "express", routes: 1 },
          after: { status: "not-express", routes: 0 },
          changes: {
            statusChanged: true,
            applicationsDelta: -1,
            routeCountDelta: -1,
            documentationChanged: false,
            routes: {
              summary: {
                addedRoutes: 0,
                removedRoutes: 1,
                authRegressions: 0,
                authImprovements: 0,
                newFindings: 0,
                resolvedFindings: 0,
              },
              details: {
                removedRoutes: [
                  {
                    applicationId: "app:src/app.js#app",
                    method: "GET",
                    path: "/legacy",
                    source: { file: "src/legacy.js", line: 4 },
                  },
                ],
              },
              detailsRetained: 1,
              detailsTruncated: false,
            },
          },
        },
      ],
      diagnostics: [],
    });

    const result = renderHtmlSite(root, path.join(root, "site"));
    const overview = fs.readFileSync(result.output, "utf8");
    const detail = fs.readFileSync(
      path.join(root, "site", "repositories", "payments.html"),
      "utf8",
    );
    const legacy = fs.readFileSync(path.join(root, "site", "repositories", "legacy.html"), "utf8");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "site", "render-manifest.json"), "utf8"),
    );
    assert.match(overview, /Changes since baseline/);
    assert.match(overview, /Added paths/);
    assert.match(overview, /acme\/payments/);
    assert.match(detail, /\/new-route/);
    assert.match(detail, /auth regression|added/);
    assert.match(overview, /View changes/);
    assert.match(legacy, /\/legacy/);
    assert.deepEqual(manifest.data, ["organization-delta.json"]);
    assert.ok(fs.existsSync(path.join(root, "site", "organization-delta.json")));

    fs.rmSync(path.join(root, "organization-delta.json"));
    const aggregate = JSON.parse(
      fs.readFileSync(path.join(root, "organization-inventory.json"), "utf8"),
    );
    delete aggregate.delta;
    writeJson(path.join(root, "organization-inventory.json"), aggregate);
    renderHtmlSite(root, path.join(root, "site"));
    assert.equal(fs.existsSync(path.join(root, "site", "organization-delta.json")), false);
  });
});

test("HTML rendering can compare two saved organization folders without rescanning", () => {
  temporary("html-baseline-option", (root) => {
    const baseline = path.join(root, "baseline");
    const current = path.join(root, "current");
    const organization = (routes, commit) => ({
      schemaVersion: "1.0",
      tool: "express-recon",
      toolVersion: "0.8.0",
      kind: "github-organization-inventory",
      organization: { login: "acme" },
      scope: {
        fingerprint: "same-scope",
        includeArchived: false,
        includeForks: false,
        maxRepositories: 100,
      },
      coverage: { complete: true },
      summary: { routes: routes.length },
      repositories: [
        {
          repository: { name: "api", fullName: "acme/api" },
          status: routes.length ? "express" : "not-express",
          commit,
          coverageComplete: true,
          express: {
            applicationCount: routes.length ? 1 : 0,
            routeCount: routes.length,
            documentation: {},
          },
          scan: repositoryScan({
            repository: { ...repositoryScan().repository, commit },
            inventory: routeReport({ routes, findings: [], summary: { routes: routes.length } }),
          }),
        },
      ],
    });
    writeJson(path.join(baseline, "organization-inventory.json"), organization([], "a".repeat(40)));
    writeJson(
      path.join(current, "organization-inventory.json"),
      organization([{ ...routeReport().routes[0], method: "GET", path: "/new" }], "b".repeat(40)),
    );

    const result = renderHtmlSite(current, path.join(root, "site"), { baseline });
    const overview = fs.readFileSync(result.output, "utf8");
    const delta = JSON.parse(
      fs.readFileSync(path.join(root, "site", "organization-delta.json"), "utf8"),
    );
    assert.match(overview, /Changes since baseline/);
    assert.equal(delta.summary.addedRoutes, 1);
    assert.equal(delta.repositories[0].changes.routes.details.addedRoutes[0].path, "/new");
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
            status: "express",
            artifacts: { repositoryScan: outside },
          },
          {
            repository: { fullName: "acme/missing" },
            status: "express",
            artifacts: { repositoryScan: "repositories/missing/repo-scan.json" },
          },
          {
            repository: { fullName: "acme/wrong" },
            status: "express",
            artifacts: { repositoryScan: "repositories/wrong/routes.json" },
          },
          {
            repository: { fullName: "acme/linked" },
            status: "inconclusive",
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

    writeJson(
      organizationFile,
      organization([entry("one"), { ...entry("two"), status: "not-express" }]),
    );
    const result = renderHtmlSite(root, output);
    assert.equal(result.pages.length, 2);
    assert.equal(fs.existsSync(stale), false);
    assert.match(fs.readFileSync(result.output, "utf8"), /No supported framework report/);
    assert.equal(fs.readFileSync(path.join(output, "keep.txt"), "utf8"), "not renderer-owned");
  });
});

test("rerendering switches cleanly between report and OpenAPI asset sets", () => {
  temporary("html-rerender-kinds", (root) => {
    const reportFile = path.join(root, "routes.json");
    const specification = path.join(root, "contract.json");
    const output = path.join(root, "site");
    writeJson(reportFile, routeReport());
    writeJson(specification, openApiDocument());

    renderHtmlSite(reportFile, output);
    fs.writeFileSync(path.join(output, "keep.txt"), "unowned and preserved");
    assert.ok(fs.existsSync(path.join(output, "assets", "report.css")));

    renderHtmlSite(specification, output);
    assert.equal(fs.existsSync(path.join(output, "assets", "report.css")), false);
    assert.equal(fs.existsSync(path.join(output, "assets", "report.js")), false);
    assert.ok(fs.existsSync(path.join(output, "assets", "swagger-ui.css")));
    assert.ok(fs.existsSync(path.join(output, "assets", "openapi-config.js")));

    renderHtmlSite(reportFile, output);
    assert.ok(fs.existsSync(path.join(output, "assets", "report.css")));
    assert.equal(fs.existsSync(path.join(output, "assets", "swagger-ui.css")), false);
    assert.equal(fs.existsSync(path.join(output, "assets", "openapi-config.js")), false);
    assert.equal(fs.readFileSync(path.join(output, "keep.txt"), "utf8"), "unowned and preserved");
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

test("render CLI supports explicit paths and safe input/output defaults", () => {
  temporary("html-cli", (root) => {
    const explicitInput = path.join(root, "explicit");
    writeJson(
      path.join(explicitInput, "routes.json"),
      routeReport({ command: "inventory", findings: undefined }),
    );
    const output = path.join(root, "site");
    const success = spawnSync(
      process.execPath,
      [CLI, "render", "--input", explicitInput, "--out", output],
      { encoding: "utf8" },
    );
    assert.equal(success.status, 0, success.stderr);
    assert.deepEqual(JSON.parse(success.stdout), {
      kind: "html-render-result",
      sourceKind: "routes",
      output: path.join(output, "index.html"),
      pages: 1,
      warnings: 0,
    });

    const specification = path.join(root, "contract.json");
    const openApiOutput = path.join(root, "openapi-site");
    writeJson(specification, openApiDocument());
    const openApi = spawnSync(
      process.execPath,
      [CLI, "render", "--input", specification, "--out", openApiOutput],
      { encoding: "utf8" },
    );
    assert.equal(openApi.status, 0, openApi.stderr);
    assert.deepEqual(JSON.parse(openApi.stdout), {
      kind: "html-render-result",
      sourceKind: "openapi",
      output: path.join(openApiOutput, "index.html"),
      pages: 1,
      warnings: 0,
    });

    const inputOnly = path.join(root, "input-only");
    writeJson(path.join(inputOnly, "routes.json"), routeReport());
    const derived = spawnSync(process.execPath, [CLI, "render", "--input", inputOnly], {
      encoding: "utf8",
    });
    assert.equal(derived.status, 0, derived.stderr);
    assert.equal(JSON.parse(derived.stdout).output, `${inputOnly}-html/index.html`);

    const outputOnlyWorkspace = path.join(root, "output-only-workspace");
    const outputOnlyTarget = path.join(outputOnlyWorkspace, "rendered");
    writeJson(path.join(outputOnlyWorkspace, "routes.json"), routeReport());
    const outputOnly = spawnSync(process.execPath, [CLI, "render", "--out", outputOnlyTarget], {
      cwd: outputOnlyWorkspace,
      encoding: "utf8",
    });
    assert.equal(outputOnly.status, 0, outputOnly.stderr);
    assert.equal(JSON.parse(outputOnly.stdout).output, path.join(outputOnlyTarget, "index.html"));

    const automaticWorkspace = path.join(root, "automatic-workspace");
    const automaticInput = path.join(automaticWorkspace, ".express-recon", "result");
    writeJson(path.join(automaticInput, "routes.json"), routeReport());
    const automatic = spawnSync(process.execPath, [CLI, "render"], {
      cwd: automaticWorkspace,
      encoding: "utf8",
    });
    assert.equal(automatic.status, 0, automatic.stderr);
    assert.equal(
      JSON.parse(automatic.stdout).output,
      path.join(fs.realpathSync(automaticWorkspace), ".express-recon", "result-html", "index.html"),
    );

    const empty = path.join(root, "empty");
    fs.mkdirSync(empty);
    const ambiguous = path.join(root, "ambiguous");
    writeJson(path.join(ambiguous, ".express-recon", "one", "routes.json"), routeReport());
    writeJson(path.join(ambiguous, ".express-recon", "two", "routes.json"), routeReport());
    for (const args of [
      { cwd: empty, args: ["render"] },
      { cwd: ambiguous, args: ["render"] },
      {
        cwd: root,
        args: ["render", "--input", explicitInput, "--out", output, "--src", "."],
      },
      {
        cwd: root,
        args: [
          "render",
          "--input",
          explicitInput,
          "--out",
          path.join(root, "baseline-site"),
          "--baseline",
          explicitInput,
        ],
      },
    ]) {
      const failure = spawnSync(process.execPath, [CLI, ...args.args], {
        cwd: args.cwd,
        encoding: "utf8",
      });
      assert.equal(failure.status, 1);
      assert.ok(failure.stderr.trim());
    }
  });
});
