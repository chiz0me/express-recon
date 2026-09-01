"use strict";

const fs = require("node:fs");
const path = require("node:path");
const pkg = require("../package.json");
const { getAbsoluteFSPath: swaggerUiPath } = require("swagger-ui-dist");
const { describeRenderableSpecification, loadSpec } = require("./docs");
const { isFrameworkStatus } = require("./frameworks");
const { SCRIPT, STYLES } = require("./html-assets");
const {
  compareOrganizationReports,
  loadOrganizationSnapshot,
  referencedRepositoryScan: referencedComparisonScan,
  snapshotFromReport,
} = require("./organization-compare");

const MAX_JSON_BYTES = 128 * 1024 * 1024;
const MAX_OPENAPI_BYTES = 32 * 1024 * 1024;
const MAX_SPECIFICATIONS_PER_REPOSITORY = 500;
const INPUT_CANDIDATES = [
  "organization-inventory.json",
  "repo-scan.json",
  "routes.json",
  "openapi.json",
  "openapi.yaml",
  "openapi.yml",
  "swagger.json",
  "swagger.yaml",
  "swagger.yml",
];
const ORGANIZATION_DELTA_FILENAME = "organization-delta.json";
const REPORT_ASSETS = ["assets/report.css", "assets/report.js"];
const SWAGGER_UI_FILES = new Map([
  ["swagger-ui.css", "assets/swagger-ui.css"],
  ["swagger-ui-bundle.js", "assets/swagger-ui-bundle.js"],
  ["swagger-ui-bundle.js.LICENSE.txt", "assets/swagger-ui-bundle.js.LICENSE.txt"],
  ["LICENSE", "assets/swagger-ui-LICENSE.txt"],
  ["NOTICE", "assets/swagger-ui-NOTICE.txt"],
]);
const SWAGGER_UI_ASSETS = [...SWAGGER_UI_FILES.values()];
const OPENAPI_ASSETS = [...SWAGGER_UI_ASSETS, "assets/openapi-config.js"];

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function display(value, fallback = "—") {
  return value === undefined || value === null || value === "" ? fallback : String(value);
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function completeness(value) {
  if (value === true) return "complete";
  if (value === false) return "incomplete";
  return "not reported";
}

function yesNo(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "not reported";
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function tone(value) {
  if (
    [
      "express",
      "fastify",
      "nestjs",
      "multi-framework",
      "proven",
      "merged",
      "cataloged",
      "complete",
    ].includes(value)
  )
    return "good";
  if (["inconclusive", "unknown", "needs-input", "needs-application-selection"].includes(value)) {
    return "warn";
  }
  if (["failed", "public", "incomplete"].includes(value)) return "bad";
  if (["inventory", "audit", "resumed"].includes(value)) return "info";
  return "neutral";
}

function badge(value, forcedTone) {
  const label = display(value);
  return `<span class="badge badge--${forcedTone || tone(label)}">${escapeHtml(label)}</span>`;
}

function metric(label, value) {
  return `<div class="metric"><span class="metric__value">${escapeHtml(display(value, "0"))}</span><span class="metric__label">${escapeHtml(label)}</span></div>`;
}

function metrics(items) {
  return `<div class="metrics">${items.map(([label, value]) => metric(label, value)).join("")}</div>`;
}

function notice(title, message, kind = "info") {
  const modifier = kind === "info" ? "" : ` notice--${kind}`;
  return `<div class="notice${modifier}" role="status"><strong>${escapeHtml(title)}</strong>${escapeHtml(message)}</div>`;
}

function panel(title, body, description = "", options = {}) {
  const id = options.id ? ` id="${escapeHtml(options.id)}"` : "";
  return `<section class="panel"${id}><div class="panel__head"><div><h2>${escapeHtml(title)}</h2>${description ? `<p class="panel__description">${escapeHtml(description)}</p>` : ""}</div></div>${body}</section>`;
}

function sourceLabel(source) {
  const item = object(source);
  if (!item.file) return "—";
  return `${item.file}${item.line === undefined || item.line === null ? "" : `:${item.line}`}`;
}

function middlewareLabel(middlewares) {
  const names = list(middlewares).map((item) => {
    const middleware = object(item);
    const name = display(middleware.name, "<anonymous>");
    return middleware.stage ? `${middleware.stage}:${name}` : name;
  });
  return names.length ? names.join(" → ") : "—";
}

function schemaEvidenceLabel(ioValue) {
  const schemas = object(object(ioValue).schemas);
  const request = Object.values(object(schemas.request));
  const responses = list(schemas.responses).map((item) => object(item).contract);
  const contracts = [...request, ...responses].map(object);
  const provenance = contracts.flatMap((item) => list(item.evidence));
  if (!provenance.length) return "—";
  const ranks = { low: 1, medium: 2, high: 3 };
  const confidence = provenance.reduce(
    (best, item) => (ranks[item.confidence] > ranks[best] ? item.confidence : best),
    "low",
  );
  const kinds = [...new Set(provenance.map((item) => item.kind).filter(Boolean))].sort();
  const conflicts = list(schemas.conflicts).length;
  return [
    confidence,
    kinds.join(", "),
    conflicts ? `${conflicts} conflict${conflicts === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function statusOptions(values) {
  return [...new Set(values.filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
    .join("");
}

function filterControls(id, placeholder, statuses = []) {
  return `<div class="filters" data-filter-controls="${id}">
    <div class="field"><label for="${id}-search">Search</label><input id="${id}-search" type="search" placeholder="${escapeHtml(placeholder)}" data-filter-search></div>
    ${statuses.length ? `<div class="field field--compact"><label for="${id}-status">Status</label><select id="${id}-status" data-filter-status><option value="">All statuses</option>${statusOptions(statuses)}</select></div>` : ""}
    <span class="result-count" data-result-count aria-live="polite"></span>
  </div>`;
}

function routeRows(report) {
  const audit = report.command === "audit";
  return list(report.routes)
    .map((routeValue) => {
      const route = object(routeValue);
      const auth = audit ? display(route.authStatus, "unknown") : "";
      const search = [
        route.framework || "express",
        route.applicationId,
        route.method,
        route.path,
        auth,
        sourceLabel(route.source),
        middlewareLabel(route.middlewares),
        schemaEvidenceLabel(route.io),
        ...list(route.tags),
        ...list(route.roles),
        ...list(route.scopes),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const confidence = route.pathConfidence === "partial" ? badge("partial", "warn") : "";
      const accepted = route.accepted ? " " + badge("accepted", "info") : "";
      return `<tr data-search="${escapeHtml(search)}" data-status="${escapeHtml(auth)}">
        <td>${badge(route.framework || "express")}</td>
        <td><span class="method">${escapeHtml(display(route.method))}</span></td>
        <td class="route-path"><div class="stack"><code>${escapeHtml(display(route.path))}</code><span>${confidence}</span></div></td>
        <td>${audit ? badge(auth) + accepted : badge("inventory", "info")}</td>
        <td><code>${escapeHtml(display(route.applicationId))}</code></td>
        <td class="source"><code>${escapeHtml(sourceLabel(route.source))}</code></td>
        <td class="middleware">${escapeHtml(middlewareLabel(route.middlewares))}</td>
        <td>${escapeHtml(schemaEvidenceLabel(route.io))}</td>
      </tr>`;
    })
    .join("");
}

function routeTable(report) {
  const routes = list(report.routes);
  const statuses = report.command === "audit" ? routes.map((route) => route.authStatus) : [];
  const body = routes.length
    ? `<div class="table-wrap"><table id="routes-table"><thead><tr><th>Framework</th><th>Method</th><th>Path</th><th>Auth</th><th>Application</th><th>Source</th><th>Middleware chain</th><th>I/O schema evidence</th></tr></thead><tbody>${routeRows(report)}</tbody></table></div>`
    : `<div class="panel__body"><p class="empty">No routes were recorded.</p></div>`;
  return panel(
    "Routes",
    routes.length
      ? filterControls("routes-table", "Framework, path, middleware, application…", statuses) + body
      : body,
    `${routes.length} route${routes.length === 1 ? "" : "s"} in this report`,
  );
}

function coverageNotice(report) {
  const coverage = object(report.scanCoverage);
  if (coverage.complete !== false) return "";
  return notice(
    "Incomplete scan coverage",
    `Some source could not be analyzed. Discovered ${count(coverage.discovered)}, analyzed ${count(coverage.analyzed)}, failed ${count(coverage.failed)}, skipped ${count(coverage.skipped)}.`,
    "warn",
  );
}

function diagnosticPanel(diagnostics) {
  const items = list(diagnostics);
  if (!items.length) return "";
  return panel(
    "Diagnostics",
    `<div class="panel__body"><ul class="plain-list">${items.map((item) => `<li>${escapeHtml(display(item))}</li>`).join("")}</ul></div>`,
    "Warnings and limitations retained from the machine-readable report",
  );
}

function applicationsPanel(applications) {
  const items = list(applications);
  if (!items.length) return "";
  const cards = items
    .map((value) => {
      const app = object(value);
      const framework = app.framework || "express";
      const adapter = app.adapter ? ` · ${app.adapter} adapter` : "";
      return `<article class="card"><h3>${escapeHtml(display(app.name, app.id))}</h3><p>${badge(framework)}${escapeHtml(adapter)}</p><p><code>${escapeHtml(display(app.id))}</code></p><p>${escapeHtml(sourceLabel(app.source))} · ${count(app.routeCount)} routes</p></article>`;
    })
    .join("");
  return panel(
    "Applications",
    `<div class="panel__body"><div class="cards">${cards}</div></div>`,
    `${items.length} supported HTTP application${items.length === 1 ? "" : "s"} identified`,
  );
}

function findingsPanel(report) {
  const findings = list(report.findings);
  if (!findings.length) return "";
  const rows = findings
    .map((value) => {
      const finding = object(value);
      const identity = [finding.method, finding.path].filter(Boolean).join(" ");
      return `<article class="card"><div class="stack"><span>${badge(display(finding.severity, "finding"), finding.severity === "high" ? "bad" : "warn")}</span><h3>${escapeHtml(display(finding.ruleId, finding.id))}</h3><code>${escapeHtml(identity)}</code><p>${escapeHtml(display(finding.detail))}</p></div></article>`;
    })
    .join("");
  return panel(
    "Findings",
    `<div class="panel__body"><div class="cards">${rows}</div></div>`,
    `${findings.length} finding${findings.length === 1 ? "" : "s"}; classifications remain configuration-relative`,
  );
}

function discoveryPanel(discoveryValue) {
  const discovery = object(discoveryValue);
  const packages = list(discovery.packages);
  const docs = object(discovery.documentation);
  const specifications = list(docs.specifications);
  const openapiSpecifications = specifications.filter((item) =>
    ["openapi", "candidate", "openapi-module", "openapi-module-candidate"].includes(
      object(item).format,
    ),
  ).length;
  const swaggerSpecifications = specifications.filter((item) =>
    ["swagger", "swagger-module"].includes(object(item).format),
  ).length;
  const coverage = object(discovery.discoveryCoverage);
  if (!packages.length && !list(docs.specifications).length && !list(docs.jsdoc).length) return "";
  const cards = packages
    .map((value) => {
      const item = object(value);
      const frameworks = list(item.frameworks)
        .map((frameworkValue) => {
          const framework = object(frameworkValue);
          const classification = object(framework.classification);
          const scopes = list(classification.scopes).join("/");
          const detail = [scopes, classification.strength].filter(Boolean).join(", ");
          return framework.name ? `${framework.name}${detail ? ` (${detail})` : ""}` : "";
        })
        .filter(Boolean);
      const expressVersions = list(object(item.express).versions).join(", ");
      const frameworkText = frameworks.length
        ? `Frameworks: ${frameworks.join(", ")}`
        : expressVersions
          ? `Express ${expressVersions}`
          : "Package discovered";
      return `<article class="card"><h3>${escapeHtml(display(item.name, item.root))}</h3><p><code>${escapeHtml(display(item.root, "."))}</code></p><p>${escapeHtml(frameworkText)}</p></article>`;
    })
    .join("");
  return panel(
    "Discovery",
    `<div class="panel__body">
      ${packages.length ? `<div class="cards">${cards}</div>` : ""}
      ${metrics([
        ["Packages", packages.length],
        ["OpenAPI specifications", openapiSpecifications],
        ["Swagger specifications", swaggerSpecifications],
        ["JSDoc sources", list(docs.jsdoc).length],
        ["Orphan routes", count(discovery.orphanRoutes)],
        ["Discovery coverage", completeness(coverage.complete)],
      ])}
    </div>`,
    "Packages and documentation inputs found without executing target code",
  );
}

function documentationPanel(documentationValue, apiReferences = []) {
  const documentation = object(documentationValue);
  if (!documentation.status) return "";
  const report = object(documentation.report);
  const summary = object(report.summary);
  const catalogSummary = object(documentation.summary);
  const reason = documentation.reason
    ? `<p>${escapeHtml(documentation.reason)}</p>`
    : `<p class="empty">No additional documentation note.</p>`;
  const references = list(apiReferences);
  const referenceList = references.length
    ? `<h3>API references</h3><ul class="plain-list">${references
        .map((referenceValue) => {
          const reference = object(referenceValue);
          const detail = [reference.source, reference.format, reference.version]
            .filter(Boolean)
            .join(" · ");
          return `<li><a href="${escapeHtml(reference.href)}">${escapeHtml(display(reference.label, "API reference"))}</a>${detail ? ` <span class="subtle">${escapeHtml(detail)}</span>` : ""}</li>`;
        })
        .join("")}</ul>`
    : "";
  return panel(
    "Documentation reconciliation",
    `<div class="panel__body"><p>${badge(documentation.status)}</p>${reason}${
      documentation.status === "merged"
        ? metrics([
            ["Code operations", count(summary.codeOperations)],
            ["Documented", count(summary.documentedOperations)],
            ["Code only", count(summary.codeOnlyOperations)],
            ["Docs only", count(summary.docsOnlyOperations)],
            ["Conflicts", count(summary.conflicts)],
            ["Static schema conflicts", count(summary.schemaConflicts)],
          ])
        : ""
    }${
      documentation.status === "cataloged"
        ? metrics([
            ["Available specifications", count(catalogSummary.available)],
            ["OpenAPI", count(catalogSummary.openapi)],
            ["Swagger", count(catalogSummary.swagger)],
            ["Safely reconciled", count(catalogSummary.reconciled)],
          ])
        : ""
    }${referenceList}</div>`,
    "Existing OpenAPI, Swagger/JSDoc, and route evidence",
    { id: "api-specifications" },
  );
}

function keyValues(items) {
  return `<dl class="key-values">${items
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(display(value))}</dd>`)
    .join("")}</dl>`;
}

function repositoryOverview(scan) {
  const provenance = object(scan.repository);
  const acquisition = object(provenance.acquisition);
  if (!Object.keys(provenance).length) return "";
  return panel(
    "Repository snapshot",
    `<div class="panel__body">${keyValues([
      ["Source", provenance.source],
      ["Requested ref", provenance.requestedRef],
      ["Commit", provenance.commit],
      ["Materialized files", acquisition.materializedFiles],
      ["Materialized bytes", acquisition.materializedBytes],
      ["Executed target code", yesNo(provenance.executedTargetCode)],
      ["Installed dependencies", yesNo(provenance.installedDependencies)],
    ])}</div>`,
    "Immutable provenance and acquisition limits for this scan",
  );
}

function reportSummary(report) {
  const summary = object(report.summary);
  const routes = list(report.routes);
  const coverage = object(report.scanCoverage);
  const typedRoutes = routes.filter((route) => object(object(route).io).schemas).length;
  const schemaConflicts = routes.reduce(
    (total, route) => total + list(object(object(object(route).io).schemas).conflicts).length,
    0,
  );
  const base = [
    ["Routes", routes.length],
    ["Applications", list(report.applications).length],
    ["Mode", display(report.mode)],
    ["Coverage", completeness(coverage.complete)],
    ["Typed I/O routes", typedRoutes],
    ["Schema conflicts", schemaConflicts],
  ];
  if (report.command === "audit") {
    base.splice(
      1,
      0,
      ["Public", count(summary.public)],
      ["Needs review", count(summary.unknown)],
      ["Proven auth", count(summary.proven)],
    );
  }
  return metrics(base);
}

function scriptLiteral(value) {
  // The document is written to an external script so the page can retain a
  // restrictive script-src policy. A JSON string is parsed at load time instead
  // of emitted as an object literal so keys such as "__proto__" retain JSON
  // semantics. HTML-significant characters cannot terminate the script.
  return JSON.stringify(JSON.stringify(value)).replace(/[<>&\u2028\u2029]/g, (character) => {
    const code = character.codePointAt(0).toString(16).padStart(4, "0");
    return `\\u${code}`;
  });
}

function openApiConfigScript(document) {
  return `"use strict";

const spec = JSON.parse(${scriptLiteral(document)});

window.ui = SwaggerUIBundle({
  spec,
  dom_id: "#swagger-ui",
  deepLinking: true,
  displayOperationId: true,
  docExpansion: "list",
  filter: true,
  persistAuthorization: false,
  queryConfigEnabled: false,
  supportedSubmitMethods: [],
  tryItOutEnabled: false,
  validatorUrl: null,
  withCredentials: false,
});
`;
}

function openApiPage(document, options = {}) {
  const title = object(document.info).title.trim();
  const assetPrefix = options.assetPrefix || "";
  const configSource = options.configSource || `${assetPrefix}assets/openapi-config.js`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <meta name="color-scheme" content="light dark">
  <meta name="generator" content="express-recon ${escapeHtml(pkg.version)}">
  <title>${escapeHtml(title)} · express-recon</title>
  <link rel="stylesheet" href="${escapeHtml(assetPrefix)}assets/swagger-ui.css">
  <script src="${escapeHtml(assetPrefix)}assets/swagger-ui-bundle.js" defer></script>
  <script src="${escapeHtml(configSource)}" defer></script>
</head>
<body>
  <noscript>This offline OpenAPI reference requires JavaScript.</noscript>
  <div id="swagger-ui"></div>
</body>
</html>\n`;
}

function layout({ title, eyebrow, lede, body, assetPrefix = "", backHref = "" }) {
  const brand = backHref
    ? `<a class="brand" href="${escapeHtml(backHref)}"><span class="brand__mark" aria-hidden="true"></span><span>express-recon</span></a>`
    : `<span class="brand"><span class="brand__mark" aria-hidden="true"></span><span>express-recon</span></span>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(title)} · express-recon</title>
  <link rel="stylesheet" href="${assetPrefix}assets/report.css">
  <script src="${assetPrefix}assets/report.js" defer></script>
</head>
<body>
  <header class="site-header"><div class="shell site-header__inner">${brand}<div class="header-meta">Offline static report<br>express-recon ${escapeHtml(pkg.version)}</div></div></header>
  <main class="shell">
    <div class="hero"><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1>${lede ? `<p class="lede">${escapeHtml(lede)}</p>` : ""}</div>
    ${body}
  </main>
  <footer class="site-footer"><div class="shell">Generated from saved machine-readable artifacts. No target code, network requests, or model calls are used to view this site.</div></footer>
</body>
</html>\n`;
}

function routeReportPage(report, title, extras = {}) {
  const body = [
    coverageNotice(report),
    reportSummary(report),
    extras.beforeRoutes || "",
    applicationsPanel(report.applications),
    findingsPanel(report),
    routeTable(report),
    diagnosticPanel(report.diagnostics),
    extras.afterRoutes || "",
  ].join("");
  return layout({
    title,
    eyebrow: report.command === "audit" ? "Route audit" : "Route inventory",
    lede: `${display(report.command, "inventory")} evidence from ${display(report.mode, "static")} analysis.`,
    body,
    assetPrefix: extras.assetPrefix,
    backHref: extras.backHref,
  });
}

function repositoryTitle(scan, fallback) {
  const source = object(scan.repository).source;
  const target = object(object(scan.inventory).target);
  return display(source, display(target.name, fallback));
}

function repositoryPage(scan, fallback, navigation = {}) {
  const report = object(scan.inventory);
  if (!Array.isArray(report.routes)) {
    return layout({
      title: fallback,
      eyebrow: "Repository scan",
      lede: "The repository artifact did not contain a usable route inventory.",
      body: notice(
        "Inventory unavailable",
        "Open repo-scan.json for the original machine-readable evidence.",
        "warn",
      ),
      assetPrefix: navigation.assetPrefix,
      backHref: navigation.backHref,
    });
  }
  return routeReportPage(report, repositoryTitle(scan, fallback), {
    ...navigation,
    beforeRoutes:
      repositoryOverview(scan) + discoveryPanel(scan.discovery) + routeDeltaPanel(navigation.delta),
    afterRoutes: documentationPanel(scan.documentation, navigation.apiReferences),
  });
}

function within(base, target) {
  const relative = path.relative(base, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function readJson(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    throw new Error(`Could not read HTML report input ${file}: ${err.message}`);
  }
  if (!stat.isFile()) throw new Error(`HTML report input is not a file: ${file}`);
  if (stat.size > MAX_JSON_BYTES) {
    throw new Error(`HTML report input exceeds ${MAX_JSON_BYTES} bytes: ${file}`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Could not parse HTML report input ${file}: ${err.message}`);
  }
}

function inputKind(value) {
  if (value?.kind === "github-organization-inventory" && Array.isArray(value.repositories)) {
    return "organization";
  }
  if (value?.kind === "repository-scan" && value.inventory) return "repository";
  if (["inventory", "audit"].includes(value?.command) && Array.isArray(value.routes)) {
    return "routes";
  }
  if (value?.swagger !== undefined || value?.openapi !== undefined) {
    try {
      describeRenderableSpecification(value, "HTML API specification input");
    } catch (error) {
      throw new Error(`Unsupported HTML report input; ${error.message}`);
    }
    return "openapi";
  }
  throw new Error(
    "Unsupported HTML report input; expected an OpenAPI 3 document, organization-inventory.json, repo-scan.json, or routes.json",
  );
}

function readInputFile(file) {
  const extension = path.extname(file).toLowerCase();
  let value = [".yaml", ".yml"].includes(extension)
    ? loadSpec(file, { maxFileBytes: MAX_OPENAPI_BYTES, allowSwagger2: true })
    : readJson(file);
  let kind = inputKind(value);
  if (kind === "openapi") {
    if (fs.statSync(file).size > MAX_OPENAPI_BYTES) {
      throw new Error(`OpenAPI HTML input exceeds ${MAX_OPENAPI_BYTES} bytes: ${file}`);
    }
    // JSON reports use a larger limit, so validate a JSON OpenAPI document
    // through the same bounded, JSON-compatible tree checks as YAML input.
    if (extension === ".json") {
      value = loadSpec(file, { maxFileBytes: MAX_OPENAPI_BYTES, allowSwagger2: true });
      kind = inputKind(value);
    }
  }
  return { value, kind };
}

function resolveInput(input) {
  const resolved = path.resolve(input);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    throw new Error(`Could not read HTML report input ${resolved}: ${err.message}`);
  }
  let file = resolved;
  if (stat.isDirectory()) {
    file = INPUT_CANDIDATES.map((name) => path.join(resolved, name)).find((candidate) =>
      fs.existsSync(candidate),
    );
    if (!file) {
      throw new Error(
        `No supported report found in ${resolved}; expected ${INPUT_CANDIDATES.join(", ")}`,
      );
    }
  }
  const loaded = readInputFile(file);
  return { file, root: path.dirname(file), ...loaded };
}

function directoryHasRenderInput(directory) {
  for (const name of INPUT_CANDIDATES) {
    try {
      const candidate = path.join(directory, name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(
          `render cannot auto-detect a non-regular or symbolic input candidate: ${candidate}; pass --input explicitly`,
        );
      }
      return true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return false;
}

/**
 * Find one unambiguous render root without recursively walking source or the
 * per-repository organization artifacts. Explicit --input remains required
 * when multiple saved outputs are present.
 */
function detectRenderInput(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const candidates = [];
  if (directoryHasRenderInput(root)) candidates.push(root);

  const reconRoot = path.join(root, ".express-recon");
  if (fs.existsSync(reconRoot)) {
    const stat = fs.lstatSync(reconRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        "render cannot auto-detect through a non-directory or symbolic .express-recon entry; pass --input explicitly",
      );
    }
    if (directoryHasRenderInput(reconRoot)) candidates.push(reconRoot);
    for (const entry of fs
      .readdirSync(reconRoot, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = path.join(reconRoot, entry.name);
      if (directoryHasRenderInput(candidate)) candidates.push(candidate);
    }
  }

  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) {
    throw new Error(
      "render could not auto-detect an input in the current directory or immediate .express-recon children; pass --input <report-or-dir>",
    );
  }
  const shown = candidates.slice(0, 8).map((candidate) => {
    const relative = path.relative(root, candidate) || ".";
    return JSON.stringify(relative.split(path.sep).join("/"));
  });
  const remainder =
    candidates.length > shown.length ? ` and ${candidates.length - shown.length} more` : "";
  throw new Error(
    `render found multiple possible inputs (${shown.join(", ")}${remainder}); pass --input explicitly`,
  );
}

/** Derive a sibling output directory while keeping scan artifacts untouched. */
function defaultRenderOutput(inputPath) {
  const input = path.resolve(inputPath);
  let stat;
  try {
    stat = fs.statSync(input);
  } catch (error) {
    throw new Error(`Could not derive HTML output from ${input}: ${error.message}`);
  }
  if (stat.isDirectory()) return `${input}-html`;
  const parsed = path.parse(input);
  if (INPUT_CANDIDATES.includes(parsed.base)) return `${parsed.dir}-html`;
  return path.join(parsed.dir, `${parsed.name || "render"}-html`);
}

function referencedRepositoryScan(root, entry) {
  if (entry.scan && typeof entry.scan === "object") return entry.scan;
  const reference = entry.artifacts?.repositoryScan;
  if (!reference) return null;
  if (typeof reference !== "string" || path.isAbsolute(reference)) {
    throw new Error("repositoryScan artifact path must be relative to the organization report");
  }
  const candidate = path.resolve(root, reference);
  if (!within(root, candidate)) throw new Error("repositoryScan artifact escapes the input folder");
  const realRoot = fs.realpathSync(root);
  const realCandidate = fs.realpathSync(candidate);
  if (!within(realRoot, realCandidate))
    throw new Error("repositoryScan artifact symlink escapes the input folder");
  const scan = readJson(realCandidate);
  if (inputKind(scan) !== "repository")
    throw new Error("repositoryScan artifact has the wrong kind");
  return scan;
}

function referencedApiSpecification(root, reference) {
  if (typeof reference !== "string" || !reference || path.isAbsolute(reference)) {
    throw new Error("API specification artifact path must be a non-empty relative path");
  }
  const candidate = path.resolve(root, reference);
  if (!within(root, candidate))
    throw new Error("API specification artifact escapes the input folder");
  const realRoot = fs.realpathSync(root);
  const realCandidate = fs.realpathSync(candidate);
  if (!within(realRoot, realCandidate)) {
    throw new Error("API specification artifact symlink escapes the input folder");
  }
  const loaded = readInputFile(realCandidate);
  if (loaded.kind !== "openapi") throw new Error("API specification artifact has the wrong kind");
  return loaded.value;
}

function embeddedOpenApi(scan) {
  const documentation = object(object(scan).documentation);
  if (documentation.status !== "merged" || !documentation.document) return null;
  if (inputKind(documentation.document) !== "openapi") {
    throw new Error("embedded OpenAPI document has the wrong kind");
  }
  const serialized = JSON.stringify(documentation.document);
  if (Buffer.byteLength(serialized) > MAX_OPENAPI_BYTES) {
    throw new Error(`embedded OpenAPI document exceeds ${MAX_OPENAPI_BYTES} bytes`);
  }
  return documentation.document;
}

function embeddedSpecification(document) {
  if (inputKind(document) !== "openapi") {
    throw new Error("embedded API specification has the wrong kind");
  }
  if (Buffer.byteLength(JSON.stringify(document)) > MAX_OPENAPI_BYTES) {
    throw new Error(`embedded API specification exceeds ${MAX_OPENAPI_BYTES} bytes`);
  }
  return document;
}

function repositoryApiDescriptors(entry, scan) {
  const artifacts = object(entry.artifacts);
  const descriptors = [];
  if (Object.hasOwn(artifacts, "openapi")) {
    descriptors.push({
      reference: artifacts.openapi,
      label: "Reconciled API",
      format: "openapi",
    });
  } else {
    const document = embeddedOpenApi(scan);
    if (document) descriptors.push({ document, label: "Reconciled API", format: "openapi" });
  }
  if (Object.hasOwn(artifacts, "specifications")) {
    if (!Array.isArray(artifacts.specifications)) {
      throw new Error("specification artifacts must be an array");
    }
    if (artifacts.specifications.length > MAX_SPECIFICATIONS_PER_REPOSITORY) {
      throw new Error(`specification artifact count exceeds ${MAX_SPECIFICATIONS_PER_REPOSITORY}`);
    }
    for (const specificationValue of artifacts.specifications) {
      const specification = object(specificationValue);
      if (!specification.artifact) {
        descriptors.push({
          error: "specification artifact is missing its source path",
          label: display(specification.title, specification.path),
          source: specification.path,
        });
        continue;
      }
      descriptors.push({
        reference: specification.artifact,
        label: display(specification.title, specification.path),
        source: specification.path,
        format: specification.format,
        version: specification.version,
      });
      const reconciliation = object(specification.reconciliation);
      if (reconciliation.artifact) {
        descriptors.push({
          reference: reconciliation.artifact,
          label: `${display(specification.title, specification.path)} (reconciled)`,
          source: specification.path,
          format: "openapi",
          version: specification.version,
        });
      }
    }
  } else {
    const specifications = list(object(scan?.documentation).specifications);
    if (specifications.length > MAX_SPECIFICATIONS_PER_REPOSITORY) {
      throw new Error(`embedded specification count exceeds ${MAX_SPECIFICATIONS_PER_REPOSITORY}`);
    }
    for (const specificationValue of specifications) {
      const specification = object(specificationValue);
      if (specification.artifact || specification.document) {
        descriptors.push({
          ...(specification.artifact
            ? { reference: specification.artifact }
            : { document: specification.document }),
          label: display(specification.title, specification.path),
          source: specification.path,
          format: specification.format,
          version: specification.version,
        });
      }
      const reconciliation = object(specification.reconciliation);
      if (reconciliation.artifact || reconciliation.document) {
        descriptors.push({
          ...(reconciliation.artifact
            ? { reference: reconciliation.artifact }
            : { document: reconciliation.document }),
          label: `${display(specification.title, specification.path)} (reconciled)`,
          source: specification.path,
          format: "openapi",
          version: specification.version,
        });
      }
    }
  }
  return descriptors;
}

function descriptorDocument(root, descriptor) {
  if (descriptor.error) throw new Error(descriptor.error);
  return descriptor.reference
    ? referencedApiSpecification(root, descriptor.reference)
    : embeddedSpecification(descriptor.document);
}

function organizationDelta(input, warnings) {
  const advertised = object(input.value.delta);
  const file = path.join(input.root, ORGANIZATION_DELTA_FILENAME);
  let delta = null;
  if (fs.existsSync(file)) {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("organization-delta.json must be a regular file");
      }
      delta = readJson(file);
    } catch (error) {
      warnings.push(
        `Organization delta unavailable: ${String(error.message).split(input.root).join(".")}`,
      );
    }
  } else if (advertised.kind) {
    delta = advertised;
    if (advertised.artifact === ORGANIZATION_DELTA_FILENAME) {
      warnings.push(
        "Organization delta details are unavailable; rendering the compact aggregate summary.",
      );
    }
  }
  if (!delta) return null;
  if (
    delta.kind !== "github-organization-inventory-delta" ||
    delta.organization?.login?.toLowerCase() !== input.value.organization?.login?.toLowerCase() ||
    !delta.summary ||
    !Array.isArray(delta.repositories)
  ) {
    warnings.push("Organization delta has an unexpected contract or organization and was ignored.");
    return null;
  }
  const expectedScope = input.value.scope?.fingerprint;
  if (
    expectedScope &&
    delta.current?.scopeFingerprint &&
    expectedScope !== delta.current.scopeFingerprint
  ) {
    warnings.push("Organization delta does not match the current inventory scope and was ignored.");
    return null;
  }
  return delta;
}

function slug(value, fallback) {
  const normalized = String(value || "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return normalized || fallback;
}

function apiDescriptorSlug(descriptor, fallback) {
  const value = descriptor.source || descriptor.label;
  const extension = path.posix.extname(String(value || ""));
  const stem = extension ? String(value).slice(0, -extension.length) : value;
  return slug(stem, fallback);
}

function organizationDetailLabel(status, evidenceValue) {
  if (isFrameworkStatus(status)) {
    const evidence = object(evidenceValue);
    return count(evidence.applicationCount) > 0 || count(evidence.routeCount) > 0
      ? "View report"
      : "View evidence";
  }
  if (status === "inconclusive") return "View diagnostics";
  return "";
}

function organizationNoDetailLabel(status) {
  if (status === "not-express") return "No supported framework report";
  if (status === "inconclusive") return "No diagnostic artifact";
  return "No detailed report";
}

function organizationRows(report, detailPages, apiReferencePages) {
  return list(report.repositories)
    .map((value, index) => {
      const entry = object(value);
      const repository = object(entry.repository);
      const evidence = Object.keys(object(entry.frameworks)).length
        ? object(entry.frameworks)
        : object(entry.express);
      const documentation = object(evidence.documentation);
      const name = display(repository.fullName, repository.name);
      const status = display(entry.status, "unknown");
      const roles = list(evidence.items)
        .map((itemValue) => {
          const item = object(itemValue);
          const role = object(item.classification).role;
          return item.name && role ? `${item.name}: ${role}` : "";
        })
        .filter(Boolean);
      const docsStatus = display(documentation.reconciliationStatus, "—");
      const search = [name, status, ...roles, docsStatus, entry.error]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const detailLabel =
        organizationDetailLabel(entry.status, evidence) ||
        (detailPages[index] ? "View changes" : "");
      const references = list(apiReferencePages[index]);
      const referenceLink = references.length
        ? references.length === 1
          ? `<a href="${escapeHtml(references[0].href)}">API reference</a>`
          : detailPages[index]
            ? `<a href="${escapeHtml(`${detailPages[index]}#api-specifications`)}">${references.length} API references</a>`
            : `<a href="${escapeHtml(references[0].href)}">${references.length} API references</a>`
        : "";
      const links = [
        detailPages[index] ? `<a href="${escapeHtml(detailPages[index])}">${detailLabel}</a>` : "",
        referenceLink,
      ].filter(Boolean);
      const detail = links.length
        ? `<div class="stack">${links.join("")}</div>`
        : `<span class="subtle">${organizationNoDetailLabel(entry.status)}</span>`;
      return `<tr data-search="${escapeHtml(search)}" data-status="${escapeHtml(status)}">
        <td><div class="stack"><strong>${escapeHtml(name)}</strong>${entry.resumed ? `<span>${badge("resumed", "info")}</span>` : ""}${entry.error ? `<span class="subtle">${escapeHtml(entry.error)}</span>` : ""}</div></td>
        <td><div class="stack">${badge(status)}${roles.length ? `<span class="subtle">${escapeHtml(roles.join(", "))}</span>` : ""}</div></td>
        <td>${count(evidence.applicationCount)}</td>
        <td>${count(evidence.routeCount)}</td>
        <td>${escapeHtml(docsStatus)}</td>
        <td>${badge(completeness(entry.coverageComplete === true && entry.routeGraphComplete !== false))}</td>
        <td>${detail}</td>
      </tr>`;
    })
    .join("");
}

function signed(value) {
  if (!Number.isSafeInteger(value) || value === 0) return "0";
  return value > 0 ? `+${value}` : String(value);
}

function deltaRouteSummary(entry) {
  return object(entry.changes).routes?.summary || object(entry.routeChanges);
}

function deltaRouteCount(entry) {
  const changes = object(entry.changes);
  if (Number.isSafeInteger(changes.routeCountDelta)) return changes.routeCountDelta;
  const before = entry.before ? count(entry.before.routes) : 0;
  const after = entry.after ? count(entry.after.routes) : 0;
  return after - before;
}

function deltaRepositoryRows(delta) {
  return list(delta.repositories)
    .map((value) => {
      const entry = object(value);
      const repository = object(entry.repository);
      const before = object(entry.before);
      const after = object(entry.after);
      const routes = object(deltaRouteSummary(entry));
      const name = display(repository.fullName, repository.name);
      const transition = `${display(before.status, "not present")} → ${display(after.status, "not present")}`;
      const search = [name, entry.change, transition].join(" ").toLowerCase();
      return `<tr data-search="${escapeHtml(search)}" data-status="${escapeHtml(display(entry.change, "changed"))}">
        <td><strong>${escapeHtml(name)}</strong></td>
        <td>${badge(display(entry.change, "changed"), entry.change === "added" ? "good" : entry.change === "removed" ? "warn" : "info")}</td>
        <td>${escapeHtml(transition)}</td>
        <td><span class="mono">${escapeHtml(signed(deltaRouteCount(entry)))}</span></td>
        <td>${count(routes.addedRoutes)}</td>
        <td>${count(routes.removedRoutes)}</td>
        <td>${count(routes.authRegressions)}</td>
      </tr>`;
    })
    .join("");
}

function organizationDeltaPanel(delta) {
  if (!delta) return "";
  const summary = object(delta.summary);
  const entries = list(delta.repositories);
  const coverage = object(delta.coverage);
  const incomplete =
    coverage.complete === false
      ? notice(
          "Incomplete change comparison",
          `${count(coverage.exactComparisonFailures)} repository comparisons could not be completed. Treat missing changes as unknown, not unchanged.`,
          "warn",
        )
      : "";
  const compact =
    delta.repositoriesTruncated === true || count(summary.repositoriesChanged) > entries.length
      ? notice(
          "Compact change summary",
          `Showing ${entries.length} of ${count(summary.repositoriesChanged)} changed repositories. Open organization-delta.json for the bounded complete list.`,
        )
      : "";
  const table = entries.length
    ? `${filterControls(
        "organization-delta-table",
        "Repository or change…",
        entries.map((entry) => entry.change),
      )}<div class="table-wrap"><table id="organization-delta-table"><thead><tr><th>Repository</th><th>Change</th><th>Status</th><th>Route count</th><th>Added paths</th><th>Removed paths</th><th>Auth regressions</th></tr></thead><tbody>${deltaRepositoryRows(delta)}</tbody></table></div>`
    : `<div class="panel__body"><p class="empty">No inventory changes were detected.</p></div>`;
  return [
    incomplete,
    compact,
    metrics([
      ["Repositories added", count(summary.repositoriesAdded)],
      ["Repositories removed", count(summary.repositoriesRemoved)],
      ["Repositories changed", count(summary.repositoriesChanged)],
      [
        "Newly supported repositories",
        count(summary.newlySupportedRepositories ?? summary.newlyExpressRepositories),
      ],
      [
        "No longer supported",
        count(summary.noLongerSupportedRepositories ?? summary.noLongerExpressRepositories),
      ],
      ["Added paths", count(summary.addedRoutes)],
      ["Removed paths", count(summary.removedRoutes)],
      ["Auth regressions", count(summary.authRegressions)],
      ["Comparison coverage", completeness(coverage.complete)],
    ]),
    panel(
      "Changes since baseline",
      table,
      `${entries.length} changed repository entr${entries.length === 1 ? "y" : "ies"}; exact path details are bounded in organization-delta.json`,
    ),
  ].join("");
}

function routeDeltaRows(routeComparison) {
  const rows = [];
  for (const [name, label, forcedTone] of [
    ["authRegressions", "auth regression", "bad"],
    ["addedRoutes", "added", "good"],
    ["removedRoutes", "removed", "warn"],
    ["authImprovements", "auth improvement", "good"],
  ]) {
    for (const value of list(object(routeComparison.details)[name])) {
      const route = object(value);
      const search = [
        label,
        route.method,
        route.path,
        route.applicationId,
        sourceLabel(route.source),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      rows.push(`<tr data-search="${escapeHtml(search)}" data-status="${escapeHtml(label)}">
        <td>${badge(label, forcedTone)}</td>
        <td><span class="method">${escapeHtml(display(route.method))}</span></td>
        <td class="route-path"><code>${escapeHtml(display(route.path))}</code></td>
        <td><code>${escapeHtml(display(route.applicationId))}</code></td>
        <td class="source"><code>${escapeHtml(sourceLabel(route.source))}</code></td>
      </tr>`);
    }
  }
  return rows.join("");
}

function routeDeltaPanel(entry) {
  const comparison =
    object(object(entry).changes).routes ||
    (entry?.routeChanges ? { summary: entry.routeChanges } : null);
  if (!comparison) return "";
  const summary = object(comparison.summary);
  const rows = routeDeltaRows(comparison);
  const statuses = ["auth regression", "added", "removed", "auth improvement"];
  const truncation = comparison.detailsTruncated
    ? notice(
        "Change details truncated",
        "Counts are exact, but the machine-readable report retained only a bounded subset of route details.",
        "warn",
      )
    : "";
  return panel(
    "Changes since baseline",
    `<div class="panel__body">${metrics([
      ["Added paths", count(summary.addedRoutes)],
      ["Removed paths", count(summary.removedRoutes)],
      ["Auth regressions", count(summary.authRegressions)],
      ["Auth improvements", count(summary.authImprovements)],
      ["New findings", count(summary.newFindings)],
      ["Resolved findings", count(summary.resolvedFindings)],
    ])}${truncation}</div>${
      rows
        ? `${filterControls("route-delta-table", "Changed path or application…", statuses)}<div class="table-wrap"><table id="route-delta-table"><thead><tr><th>Change</th><th>Method</th><th>Path</th><th>Application</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : ""
    }`,
    "Exact route and configuration-relative auth changes for this repository",
  );
}

function organizationScopePanel(report) {
  const organization = object(report.organization);
  const scope = object(report.scope);
  const coverage = object(report.coverage);
  const enumeration = object(coverage.enumeration);
  return panel(
    "Inventory scope",
    `<div class="panel__body">${keyValues([
      ["Repository visibility", organization.repositoryVisibility],
      ["Authenticated", yesNo(organization.authenticated)],
      ["Include archived", yesNo(scope.includeArchived)],
      ["Include forks", yesNo(scope.includeForks)],
      ["Repository cap", scope.maxRepositories],
      ["Concurrency", scope.concurrency],
      ["Execution mode", scope.executionMode],
      ["Executed target code", yesNo(scope.executedTargetCode)],
      ["Enumeration coverage", completeness(enumeration.complete)],
      ["API pages fetched", enumeration.pagesFetched],
    ])}</div>`,
    "Scope and trust boundaries retained from the aggregate",
  );
}

function organizationPage(report, detailPages, apiReferencePages, warnings, delta) {
  const summary = object(report.summary);
  const coverage = object(report.coverage);
  const organization = object(report.organization);
  const entries = list(report.repositories);
  const supportedEntries = entries.filter((entry) => isFrameworkStatus(entry.status));
  const derivedApplicationRepositories = supportedEntries.filter((entry) => {
    const evidence = Object.keys(object(entry.frameworks)).length
      ? object(entry.frameworks)
      : object(entry.express);
    return count(evidence.applicationCount) > 0 || count(evidence.routeCount) > 0;
  }).length;
  const applicationRepositories =
    summary.applicationRepositories === undefined
      ? derivedApplicationRepositories
      : count(summary.applicationRepositories);
  const dependencyOnlyRepositories =
    summary.dependencyOnlyRepositories === undefined
      ? supportedEntries.length - applicationRepositories
      : count(summary.dependencyOnlyRepositories);
  const incomplete =
    coverage.complete === false
      ? notice(
          "Incomplete organization inventory",
          `${list(coverage.incompleteRepositories).length} repositories were failed, inconclusive, limited, or otherwise incomplete.`,
          "warn",
        )
      : "";
  const warningNotice = warnings.length
    ? notice(
        "Some detailed reports or API references could not be rendered",
        `${warnings.length} referenced artifact${warnings.length === 1 ? " was" : "s were"} unavailable or unsafe. The aggregate evidence remains visible.`,
        "warn",
      )
    : "";
  const statuses = entries.map((entry) => entry.status);
  const table = entries.length
    ? `${filterControls("repositories-table", "Repository, status, error…", statuses)}<div class="table-wrap"><table id="repositories-table"><thead><tr><th>Repository</th><th>Status</th><th>Apps</th><th>Routes</th><th>Docs</th><th>Coverage</th><th>Details</th></tr></thead><tbody>${organizationRows(report, detailPages, apiReferencePages)}</tbody></table></div>`
    : `<div class="panel__body"><p class="empty">No repositories were recorded.</p></div>`;
  const body = [
    incomplete,
    warningNotice,
    metrics([
      ["Repositories discovered", count(summary.repositoriesDiscovered) || entries.length],
      ["Repositories scanned", count(summary.repositoriesScanned)],
      [
        "Supported repositories",
        count(summary.supportedRepositories ?? summary.expressRepositories),
      ],
      ["Application repositories", applicationRepositories],
      ["Dependency-only repositories", dependencyOnlyRepositories],
      ["Express", count(summary.expressRepositories)],
      ["Fastify", count(summary.fastifyRepositories)],
      ["NestJS", count(summary.nestjsRepositories)],
      ["Applications", count(summary.applications)],
      ["Routes", count(summary.routes)],
      ["API specifications", count(summary.apiSpecifications)],
      ["Specification repositories", count(summary.specificationRepositories)],
      ["Cataloged repositories", count(summary.catalogedRepositories)],
      ["Failed", count(summary.failedRepositories)],
      ["Inconclusive", count(summary.inconclusiveRepositories)],
      ["Incomplete route graphs", count(summary.incompleteRouteGraphs)],
      ["Coverage", completeness(coverage.complete)],
    ]),
    organizationDeltaPanel(delta),
    organizationScopePanel(report),
    panel(
      "Repositories",
      table,
      `${entries.length} API-visible repository entr${entries.length === 1 ? "y" : "ies"}`,
    ),
  ].join("");
  return layout({
    title: display(organization.login, "Organization inventory"),
    eyebrow: "GitHub organization inventory",
    lede: "Automatically discovered supported HTTP frameworks and their static route evidence.",
    body,
  });
}

function writeFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, "utf8");
}

function ownedOutputReference(reference) {
  return (
    reference === "index.html" ||
    reference === "render-manifest.json" ||
    reference === ORGANIZATION_DELTA_FILENAME ||
    REPORT_ASSETS.includes(reference) ||
    OPENAPI_ASSETS.includes(reference) ||
    /^repositories\/[A-Za-z0-9._-]+\.html$/.test(reference) ||
    /^openapi\/[A-Za-z0-9._-]+\.(?:html|js)$/.test(reference)
  );
}

function ownedOutputFile(output, reference) {
  if (!ownedOutputReference(reference)) {
    throw new Error(`Existing HTML render manifest contains an unsafe path: ${reference}`);
  }
  const parts = reference.split("/");
  let parent = output;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    if (!fs.existsSync(parent)) return null;
    const stat = fs.lstatSync(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Existing HTML report output has an unsafe generated directory: ${part}`);
    }
  }
  const target = path.join(output, ...parts);
  if (!fs.existsSync(target)) return null;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Existing HTML report output has an unsafe generated file: ${reference}`);
  }
  return target;
}

function cleanPreviousOutput(output) {
  if (!fs.readdirSync(output).length) return;
  const manifestFile = path.join(output, "render-manifest.json");
  if (!fs.existsSync(manifestFile)) {
    throw new Error(`HTML report output is not empty and has no render-manifest.json: ${output}`);
  }
  const manifestStat = fs.lstatSync(manifestFile);
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    throw new Error(`HTML report output has an unsafe render-manifest.json: ${output}`);
  }
  let manifest;
  try {
    manifest = readJson(manifestFile);
  } catch (err) {
    throw new Error(`Could not validate existing HTML report output: ${err.message}`);
  }
  if (
    manifest.kind !== "express-recon-html-site" ||
    !Array.isArray(manifest.pages) ||
    !Array.isArray(manifest.assets) ||
    (manifest.data !== undefined && !Array.isArray(manifest.data))
  ) {
    throw new Error(`HTML report output has an incompatible render-manifest.json: ${output}`);
  }
  const owned = new Set([
    "index.html",
    "render-manifest.json",
    ...REPORT_ASSETS,
    ...manifest.pages,
    ...manifest.assets,
    ...list(manifest.data),
  ]);
  const generatedDirectories = [];
  for (const directory of ["repositories", "openapi", "assets"]) {
    const candidate = path.join(output, directory);
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `Existing HTML report output has an unsafe generated directory: ${directory}`,
      );
    }
    generatedDirectories.push(candidate);
  }
  const generatedFiles = [...owned]
    .map((reference) => ownedOutputFile(output, reference))
    .filter(Boolean);
  for (const file of generatedFiles) fs.rmSync(file, { force: true });
  for (const directory of generatedDirectories) {
    if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
  }
}

function copySwaggerUiAssets(output) {
  const distribution = swaggerUiPath();
  for (const [sourceName, outputReference] of SWAGGER_UI_FILES) {
    const source = path.join(distribution, sourceName);
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Swagger UI distribution asset is not a regular file: ${sourceName}`);
    }
    const target = path.join(output, ...outputReference.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

function prepareOutput(output, kind) {
  const resolved = path.resolve(output);
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
    throw new Error(`HTML report output is not a directory: ${resolved}`);
  }
  fs.mkdirSync(resolved, { recursive: true });
  cleanPreviousOutput(resolved);
  if (kind === "openapi") {
    copySwaggerUiAssets(resolved);
  } else {
    writeFile(path.join(resolved, "assets", "report.css"), STYLES.trimStart());
    writeFile(path.join(resolved, "assets", "report.js"), SCRIPT.trimStart());
  }
  return resolved;
}

function renderRepository(input, output, warnings, pages, assets) {
  const references = [];
  let descriptors = [];
  try {
    descriptors = repositoryApiDescriptors(input.value, input.value);
  } catch (error) {
    warnings.push(`API specifications: ${String(error.message).split(input.root).join(".")}`);
  }
  let swaggerUiWritten = false;
  const title = repositoryTitle(input.value, "repository");
  const used = new Set();
  for (const [index, descriptor] of descriptors.entries()) {
    try {
      const document = descriptorDocument(input.root, descriptor);
      const description = describeRenderableSpecification(document);
      if (!swaggerUiWritten) {
        copySwaggerUiAssets(output);
        assets.push(...SWAGGER_UI_ASSETS);
        swaggerUiWritten = true;
      }
      const base = `${slug(title, "repository")}--${apiDescriptorSlug(
        descriptor,
        `specification-${index + 1}`,
      )}`;
      let filename = `${base}.html`;
      let suffix = 2;
      while (used.has(filename.toLowerCase())) filename = `${base}-${suffix++}.html`;
      used.add(filename.toLowerCase());
      const configFilename = filename.replace(/\.html$/, ".js");
      const pageReference = path.posix.join("openapi", filename);
      const configReference = path.posix.join("openapi", configFilename);
      references.push({
        href: pageReference,
        label: descriptor.label || description.title,
        source: descriptor.source,
        format: descriptor.format || description.format,
        version: descriptor.version || description.version,
      });
      pages.push(pageReference);
      assets.push(configReference);
      writeFile(path.join(output, "openapi", configFilename), openApiConfigScript(document));
      writeFile(
        path.join(output, "openapi", filename),
        openApiPage(document, { assetPrefix: "../", configSource: configFilename }),
      );
    } catch (error) {
      const source = descriptor.source ? ` ${descriptor.source}` : "";
      warnings.push(
        `API specification${source}: ${String(error.message).split(input.root).join(".")}`,
      );
    }
  }
  writeFile(
    path.join(output, "index.html"),
    repositoryPage(input.value, "Repository report", { apiReferences: references }),
  );
}

function renderOrganization(input, output, warnings, pages, assets, suppliedDelta = null) {
  const delta = suppliedDelta || organizationDelta(input, warnings);
  const changes = new Map(
    list(delta?.repositories).map((entry) => [
      String(entry?.repository?.fullName || "").toLowerCase(),
      entry,
    ]),
  );
  const detailPages = [];
  const apiReferencePages = [];
  const usedDetails = new Set();
  const usedOpenApi = new Set();
  let swaggerUiWritten = false;
  const safeError = (error) => {
    const realRoot = fs.realpathSync(input.root);
    return String(error.message).split(input.root).join(".").split(realRoot).join(".");
  };
  for (const [index, value] of list(input.value.repositories).entries()) {
    const entry = object(value);
    const repository = object(entry.repository);
    const evidence = Object.keys(object(entry.frameworks)).length
      ? object(entry.frameworks)
      : object(entry.express);
    const change = changes.get(String(repository.fullName || "").toLowerCase());
    const name = display(repository.fullName, `repository ${index + 1}`);
    const wantsDetail = Boolean(
      organizationDetailLabel(entry.status, evidence) ||
      change?.changes?.routes ||
      change?.routeChanges,
    );
    let scan = null;
    if (wantsDetail) {
      try {
        scan = referencedRepositoryScan(input.root, entry);
      } catch (error) {
        warnings.push(`${name}: ${safeError(error)}`);
      }
    }

    if (isFrameworkStatus(entry.status)) {
      let descriptors = [];
      try {
        descriptors = repositoryApiDescriptors(entry, scan);
      } catch (error) {
        warnings.push(`${name} API specifications: ${safeError(error)}`);
      }
      for (const [descriptorIndex, descriptor] of descriptors.entries()) {
        try {
          const document = descriptorDocument(input.root, descriptor);
          if (!swaggerUiWritten) {
            copySwaggerUiAssets(output);
            assets.push(...SWAGGER_UI_ASSETS);
            swaggerUiWritten = true;
          }
          const base = slug(repository.name || repository.fullName, `repository-${index + 1}`);
          const descriptorBase =
            descriptorIndex === 0 && descriptor.label === "Reconciled API"
              ? base
              : `${base}--${apiDescriptorSlug(descriptor, `specification-${descriptorIndex + 1}`)}`;
          let filename = `${descriptorBase}.html`;
          let suffix = 2;
          while (usedOpenApi.has(filename.toLowerCase())) {
            filename = `${descriptorBase}-${suffix++}.html`;
          }
          usedOpenApi.add(filename.toLowerCase());
          const configFilename = filename.replace(/\.html$/, ".js");
          const pageReference = path.posix.join("openapi", filename);
          const configReference = path.posix.join("openapi", configFilename);
          const description = describeRenderableSpecification(document);
          (apiReferencePages[index] ||= []).push({
            href: pageReference,
            label: descriptor.label || description.title,
            source: descriptor.source,
            format: descriptor.format || description.format,
            version: descriptor.version || description.version,
          });
          pages.push(pageReference);
          assets.push(configReference);
          writeFile(path.join(output, "openapi", configFilename), openApiConfigScript(document));
          writeFile(
            path.join(output, "openapi", filename),
            openApiPage(document, { assetPrefix: "../", configSource: configFilename }),
          );
        } catch (error) {
          const source = descriptor.source ? ` ${descriptor.source}` : "";
          warnings.push(`${name} API specification${source}: ${safeError(error)}`);
        }
      }
    }

    if (!scan) continue;
    const base = slug(repository.name || repository.fullName, `repository-${index + 1}`);
    let filename = `${base}.html`;
    let suffix = 2;
    while (usedDetails.has(filename.toLowerCase())) filename = `${base}-${suffix++}.html`;
    usedDetails.add(filename.toLowerCase());
    const relative = path.posix.join("repositories", filename);
    detailPages[index] = relative;
    pages.push(relative);
    writeFile(
      path.join(output, "repositories", filename),
      repositoryPage(scan, display(repository.fullName, repository.name), {
        assetPrefix: "../",
        backHref: "../index.html",
        delta: change,
        apiReferences: list(apiReferencePages[index]).map((reference) => ({
          ...reference,
          href: `../${reference.href}`,
        })),
      }),
    );
  }
  writeFile(
    path.join(output, "index.html"),
    organizationPage(input.value, detailPages, apiReferencePages, warnings, delta),
  );
  if (delta) {
    writeFile(
      path.join(output, ORGANIZATION_DELTA_FILENAME),
      JSON.stringify(delta, null, 2) + "\n",
    );
  }
  return delta;
}

/**
 * Render an existing route, repository, organization, or OpenAPI artifact as a
 * fully offline HTML site. Owned files from a prior render may be replaced,
 * while a non-empty unowned output directory is rejected.
 */
function renderHtmlSite(inputPath, outputPath, options = {}) {
  if (!inputPath) throw new Error("HTML report rendering requires an input path");
  if (!outputPath) throw new Error("HTML report rendering requires an output directory");
  const input = resolveInput(inputPath);
  let suppliedDelta = null;
  if (options.baseline) {
    if (input.kind !== "organization") {
      throw new Error("HTML --baseline comparison requires an organization inventory input");
    }
    const baseline = loadOrganizationSnapshot(options.baseline);
    const current = snapshotFromReport(input.value, input.root);
    suppliedDelta = compareOrganizationReports(baseline.report, input.value, {
      loadBaselineScan: (entry) => referencedComparisonScan(baseline, entry),
      loadCurrentScan: (entry) => referencedComparisonScan(current, entry),
    });
  }
  const output = prepareOutput(outputPath, input.kind);
  const warnings = [];
  const pages = ["index.html"];
  const assets = input.kind === "openapi" ? [...OPENAPI_ASSETS] : [...REPORT_ASSETS];
  let delta = null;
  if (input.kind === "organization") {
    delta = renderOrganization(input, output, warnings, pages, assets, suppliedDelta);
  } else if (input.kind === "repository") {
    renderRepository(input, output, warnings, pages, assets);
  } else if (input.kind === "openapi") {
    writeFile(path.join(output, "assets", "openapi-config.js"), openApiConfigScript(input.value));
    writeFile(path.join(output, "index.html"), openApiPage(input.value));
  } else {
    const target = object(input.value.target);
    writeFile(
      path.join(output, "index.html"),
      routeReportPage(input.value, display(target.name, "HTTP route report")),
    );
  }
  const manifest = {
    schemaVersion: "1.0",
    kind: "express-recon-html-site",
    tool: "express-recon",
    toolVersion: pkg.version,
    source: { kind: input.kind, file: path.basename(input.file) },
    entry: "index.html",
    pages,
    assets,
    data: delta ? [ORGANIZATION_DELTA_FILENAME] : [],
    warnings,
  };
  writeFile(path.join(output, "render-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { ...manifest, output: path.join(output, "index.html") };
}

module.exports = {
  MAX_JSON_BYTES,
  MAX_OPENAPI_BYTES,
  defaultRenderOutput,
  detectRenderInput,
  escapeHtml,
  inputKind,
  renderHtmlSite,
  resolveInput,
};
