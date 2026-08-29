"use strict";

const fs = require("node:fs");
const path = require("node:path");
const pkg = require("../package.json");
const { SCRIPT, STYLES } = require("./html-assets");

const MAX_JSON_BYTES = 128 * 1024 * 1024;
const INPUT_CANDIDATES = ["organization-inventory.json", "repo-scan.json", "routes.json"];

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
  if (["express", "proven", "merged", "complete"].includes(value)) return "good";
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

function panel(title, body, description = "") {
  return `<section class="panel"><div class="panel__head"><div><h2>${escapeHtml(title)}</h2>${description ? `<p class="panel__description">${escapeHtml(description)}</p>` : ""}</div></div>${body}</section>`;
}

function sourceLabel(source) {
  const item = object(source);
  if (!item.file) return "—";
  return `${item.file}${item.line === undefined || item.line === null ? "" : `:${item.line}`}`;
}

function middlewareLabel(middlewares) {
  const names = list(middlewares).map((item) => display(object(item).name, "<anonymous>"));
  return names.length ? names.join(" → ") : "—";
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
        route.applicationId,
        route.method,
        route.path,
        auth,
        sourceLabel(route.source),
        middlewareLabel(route.middlewares),
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
        <td><span class="method">${escapeHtml(display(route.method))}</span></td>
        <td class="route-path"><div class="stack"><code>${escapeHtml(display(route.path))}</code><span>${confidence}</span></div></td>
        <td>${audit ? badge(auth) + accepted : badge("inventory", "info")}</td>
        <td><code>${escapeHtml(display(route.applicationId))}</code></td>
        <td class="source"><code>${escapeHtml(sourceLabel(route.source))}</code></td>
        <td class="middleware">${escapeHtml(middlewareLabel(route.middlewares))}</td>
      </tr>`;
    })
    .join("");
}

function routeTable(report) {
  const routes = list(report.routes);
  const statuses = report.command === "audit" ? routes.map((route) => route.authStatus) : [];
  const body = routes.length
    ? `<div class="table-wrap"><table id="routes-table"><thead><tr><th>Method</th><th>Path</th><th>Auth</th><th>Application</th><th>Source</th><th>Middleware chain</th></tr></thead><tbody>${routeRows(report)}</tbody></table></div>`
    : `<div class="panel__body"><p class="empty">No routes were recorded.</p></div>`;
  return panel(
    "Routes",
    routes.length
      ? filterControls("routes-table", "Path, middleware, application…", statuses) + body
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
      return `<article class="card"><h3>${escapeHtml(display(app.name, app.id))}</h3><p><code>${escapeHtml(display(app.id))}</code></p><p>${escapeHtml(sourceLabel(app.source))} · ${count(app.routeCount)} routes</p></article>`;
    })
    .join("");
  return panel(
    "Applications",
    `<div class="panel__body"><div class="cards">${cards}</div></div>`,
    `${items.length} Express application${items.length === 1 ? "" : "s"} identified`,
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
  const coverage = object(discovery.discoveryCoverage);
  if (!packages.length && !list(docs.specifications).length && !list(docs.jsdoc).length) return "";
  const cards = packages
    .map((value) => {
      const item = object(value);
      const expressVersions = list(object(item.express).versions).join(", ");
      return `<article class="card"><h3>${escapeHtml(display(item.name, item.root))}</h3><p><code>${escapeHtml(display(item.root, "."))}</code></p><p>${escapeHtml(expressVersions ? `Express ${expressVersions}` : "Package discovered")}</p></article>`;
    })
    .join("");
  return panel(
    "Discovery",
    `<div class="panel__body">
      ${packages.length ? `<div class="cards">${cards}</div>` : ""}
      ${metrics([
        ["Packages", packages.length],
        ["OpenAPI specifications", list(docs.specifications).length],
        ["Swagger/JSDoc sources", list(docs.jsdoc).length],
        ["Orphan routes", count(discovery.orphanRoutes)],
        ["Discovery coverage", completeness(coverage.complete)],
      ])}
    </div>`,
    "Packages and documentation inputs found without executing target code",
  );
}

function documentationPanel(documentationValue) {
  const documentation = object(documentationValue);
  if (!documentation.status) return "";
  const report = object(documentation.report);
  const summary = object(report.summary);
  const reason = documentation.reason
    ? `<p>${escapeHtml(documentation.reason)}</p>`
    : `<p class="empty">No additional documentation note.</p>`;
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
          ])
        : ""
    }</div>`,
    "Existing OpenAPI, Swagger/JSDoc, and route evidence",
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
  const base = [
    ["Routes", routes.length],
    ["Applications", list(report.applications).length],
    ["Mode", display(report.mode)],
    ["Coverage", completeness(coverage.complete)],
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
  <footer class="site-footer"><div class="shell">Generated from deterministic scan artifacts. No target code, network requests, or model calls are used to view this site.</div></footer>
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
    beforeRoutes: repositoryOverview(scan) + discoveryPanel(scan.discovery),
    afterRoutes: documentationPanel(scan.documentation),
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
  throw new Error(
    "Unsupported HTML report input; expected organization-inventory.json, repo-scan.json, or routes.json",
  );
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
  const value = readJson(file);
  return { file, root: path.dirname(file), value, kind: inputKind(value) };
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

function slug(value, fallback) {
  const normalized = String(value || "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return normalized || fallback;
}

function organizationDetailLabel(status) {
  if (status === "express") return "View report";
  if (status === "inconclusive") return "View diagnostics";
  return "";
}

function organizationNoDetailLabel(status) {
  if (status === "not-express") return "No Express report";
  if (status === "inconclusive") return "No diagnostic artifact";
  return "No detailed report";
}

function organizationRows(report, detailPages) {
  return list(report.repositories)
    .map((value, index) => {
      const entry = object(value);
      const repository = object(entry.repository);
      const express = object(entry.express);
      const documentation = object(express.documentation);
      const name = display(repository.fullName, repository.name);
      const status = display(entry.status, "unknown");
      const docsStatus = display(documentation.reconciliationStatus, "—");
      const search = [name, status, docsStatus, entry.error]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const detailLabel = organizationDetailLabel(entry.status);
      const detail = detailPages[index]
        ? `<a href="${escapeHtml(detailPages[index])}">${detailLabel}</a>`
        : `<span class="subtle">${organizationNoDetailLabel(entry.status)}</span>`;
      return `<tr data-search="${escapeHtml(search)}" data-status="${escapeHtml(status)}">
        <td><div class="stack"><strong>${escapeHtml(name)}</strong>${entry.resumed ? `<span>${badge("resumed", "info")}</span>` : ""}${entry.error ? `<span class="subtle">${escapeHtml(entry.error)}</span>` : ""}</div></td>
        <td>${badge(status)}</td>
        <td>${count(express.applicationCount)}</td>
        <td>${count(express.routeCount)}</td>
        <td>${escapeHtml(docsStatus)}</td>
        <td>${badge(completeness(entry.coverageComplete))}</td>
        <td>${detail}</td>
      </tr>`;
    })
    .join("");
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

function organizationPage(report, detailPages, warnings) {
  const summary = object(report.summary);
  const coverage = object(report.coverage);
  const organization = object(report.organization);
  const entries = list(report.repositories);
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
        "Some detailed reports could not be rendered",
        `${warnings.length} referenced artifact${warnings.length === 1 ? " was" : "s were"} unavailable or unsafe. The aggregate evidence remains visible.`,
        "warn",
      )
    : "";
  const statuses = entries.map((entry) => entry.status);
  const table = entries.length
    ? `${filterControls("repositories-table", "Repository, status, error…", statuses)}<div class="table-wrap"><table id="repositories-table"><thead><tr><th>Repository</th><th>Status</th><th>Apps</th><th>Routes</th><th>Docs</th><th>Coverage</th><th>Details</th></tr></thead><tbody>${organizationRows(report, detailPages)}</tbody></table></div>`
    : `<div class="panel__body"><p class="empty">No repositories were recorded.</p></div>`;
  const body = [
    incomplete,
    warningNotice,
    metrics([
      ["Repositories discovered", count(summary.repositoriesDiscovered) || entries.length],
      ["Repositories scanned", count(summary.repositoriesScanned)],
      ["Express repositories", count(summary.expressRepositories)],
      ["Applications", count(summary.applications)],
      ["Routes", count(summary.routes)],
      ["Failed", count(summary.failedRepositories)],
      ["Inconclusive", count(summary.inconclusiveRepositories)],
      ["Coverage", completeness(coverage.complete)],
    ]),
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
    lede: "Automatically discovered Express repositories and their static route evidence.",
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
    reference === "assets/report.css" ||
    reference === "assets/report.js" ||
    /^repositories\/[A-Za-z0-9._-]+\.html$/.test(reference)
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
    !Array.isArray(manifest.assets)
  ) {
    throw new Error(`HTML report output has an incompatible render-manifest.json: ${output}`);
  }
  const owned = new Set([
    "index.html",
    "render-manifest.json",
    "assets/report.css",
    "assets/report.js",
    ...manifest.pages,
    ...manifest.assets,
  ]);
  const generatedDirectories = [];
  for (const directory of ["repositories", "assets"]) {
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

function prepareOutput(output) {
  const resolved = path.resolve(output);
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
    throw new Error(`HTML report output is not a directory: ${resolved}`);
  }
  fs.mkdirSync(resolved, { recursive: true });
  cleanPreviousOutput(resolved);
  writeFile(path.join(resolved, "assets", "report.css"), STYLES.trimStart());
  writeFile(path.join(resolved, "assets", "report.js"), SCRIPT.trimStart());
  return resolved;
}

function renderOrganization(input, output, warnings, pages) {
  const detailPages = [];
  const used = new Set();
  for (const [index, value] of list(input.value.repositories).entries()) {
    const entry = object(value);
    if (!organizationDetailLabel(entry.status)) continue;
    let scan;
    try {
      scan = referencedRepositoryScan(input.root, entry);
    } catch (err) {
      const realRoot = fs.realpathSync(input.root);
      const safeMessage = String(err.message).split(input.root).join(".").split(realRoot).join(".");
      warnings.push(
        `${display(object(entry.repository).fullName, `repository ${index + 1}`)}: ${safeMessage}`,
      );
      continue;
    }
    if (!scan) continue;
    const repository = object(entry.repository);
    const base = slug(repository.name || repository.fullName, `repository-${index + 1}`);
    let filename = `${base}.html`;
    let suffix = 2;
    while (used.has(filename.toLowerCase())) filename = `${base}-${suffix++}.html`;
    used.add(filename.toLowerCase());
    const relative = path.posix.join("repositories", filename);
    detailPages[index] = relative;
    pages.push(relative);
    writeFile(
      path.join(output, "repositories", filename),
      repositoryPage(scan, display(repository.fullName, repository.name), {
        assetPrefix: "../",
        backHref: "../index.html",
      }),
    );
  }
  writeFile(path.join(output, "index.html"), organizationPage(input.value, detailPages, warnings));
}

function renderHtmlSite(inputPath, outputPath) {
  if (!inputPath) throw new Error("HTML report rendering requires an input path");
  if (!outputPath) throw new Error("HTML report rendering requires an output directory");
  const input = resolveInput(inputPath);
  const output = prepareOutput(outputPath);
  const warnings = [];
  const pages = ["index.html"];
  if (input.kind === "organization") {
    renderOrganization(input, output, warnings, pages);
  } else if (input.kind === "repository") {
    writeFile(path.join(output, "index.html"), repositoryPage(input.value, "Repository report"));
  } else {
    const target = object(input.value.target);
    writeFile(
      path.join(output, "index.html"),
      routeReportPage(input.value, display(target.name, "Express route report")),
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
    assets: ["assets/report.css", "assets/report.js"],
    warnings,
  };
  writeFile(path.join(output, "render-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { ...manifest, output: path.join(output, "index.html") };
}

module.exports = {
  MAX_JSON_BYTES,
  escapeHtml,
  inputKind,
  renderHtmlSite,
  resolveInput,
};
