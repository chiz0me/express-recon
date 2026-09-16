"use strict";

const { operations } = require("./docs");
const { toOpenApiPaths } = require("./formatters/openapi");
const { OPENAPI_METHODS } = require("./http-methods");

const array = (value) => (Array.isArray(value) ? value : []);
const normalizedOperation = (value) => value.replace(/\{[^/{}]+\}/g, "{}");

// Keep this a render projection: matching never modifies saved scan evidence.
function documentationCoverage(scan, documents = []) {
  const inventory = scan?.inventory || {};
  const routes = array(inventory.routes);
  const applications = new Set([
    ...array(inventory.applications).map((item) => item.id),
    ...routes.map((route) => route.applicationId),
  ]);
  const documentation = scan?.documentation || {};
  const sources = [];
  const add = (applicationId, label, matched, checked) => {
    // A repository-wide contract cannot establish ownership across applications.
    if (!applicationId && applications.size > 1) return;
    sources.push({
      applicationId,
      label,
      matched: new Set(matched.map(normalizedOperation)),
      checked: checked && new Set(checked.map(normalizedOperation)),
    });
  };
  const reports = [
    documentation.report,
    ...array(documentation.specifications)
      .filter((item) => item.status !== "invalid" && item.status !== "unavailable")
      .map((item) => item.reconciliation?.report),
  ];
  for (const report of reports) {
    if (!Array.isArray(report?.documentedOperations)) continue;
    add(
      report.applicationId,
      [report.sources?.base, ...array(report.sources?.jsdoc)].filter(Boolean).join(", ") ||
        "OpenAPI / Swagger / JSDoc",
      report.documentedOperations,
      [...report.documentedOperations, ...array(report.codeOnlyOperations)],
    );
  }
  for (const { document, applicationId, source, label, reconciled } of documents) {
    const metadata = document["x-express-recon"];
    const reconciliation = metadata?.reconciliation;
    const generated = new Set(array(reconciliation?.generatedFields));
    if (metadata?.generated && !reconciliation) continue;
    if (reconciled && !reconciliation) continue;
    // Without generated-field provenance a merged contract cannot prove overlap.
    if (reconciliation && !Array.isArray(reconciliation.generatedFields)) continue;
    const authored = [...operations(document).keys()].filter((operation) => {
      const separator = operation.indexOf(" ");
      const method = operation.slice(0, separator).toLowerCase();
      const path = operation
        .slice(separator + 1)
        .replaceAll("~", "~0")
        .replaceAll("/", "~1");
      const pointer = `/paths/${path}/${method}`;
      return !["", "/paths", `/paths/${path}`, pointer].some((field) => generated.has(field));
    });
    // Swagger's basePath forms part of the request path. Also retain document-relative
    // keys, matching the existing reconciliation convention for mounted applications.
    const basePath =
      typeof document.basePath === "string" ? document.basePath.replace(/\/$/, "") : "";
    const prefixed = basePath
      ? authored.map((operation) => operation.replace(" /", ` ${basePath}/`))
      : [];
    add(applicationId || reconciliation?.applicationId, source || label || "API specification", [
      ...authored,
      ...prefixed,
    ]);
  }
  const rows = routes.map((route) => {
    const method = String(route.method || "").toLowerCase();
    if (
      !route.path ||
      ["partial", "unknown"].includes(route.pathConfidence) ||
      (method !== "all" && !OPENAPI_METHODS.includes(method))
    ) {
      return { status: "unchecked", sources: [] };
    }
    const methods = method === "all" ? OPENAPI_METHODS : [method];
    const routePath =
      inventory.mode === "imported" && !["express", "fastify", "nestjs"].includes(route.framework)
        ? route.path.replace(/\/\{([A-Za-z_][\w]*)\}/g, "/:$1")
        : route.path;
    const keys = toOpenApiPaths(routePath).flatMap(({ path }) =>
      methods.map((verb) => normalizedOperation(`${verb.toUpperCase()} ${path}`)),
    );
    const applicable = sources.filter(
      (item) =>
        !item.applicationId ||
        item.applicationId === "all" ||
        item.applicationId === route.applicationId,
    );
    const matching = applicable.filter((item) => keys.some((key) => item.matched.has(key)));
    const checked = applicable.some(
      (item) => !item.checked || keys.some((key) => item.checked.has(key)),
    );
    return {
      status: matching.length ? "matched" : checked ? "unmatched" : "unchecked",
      sources: [...new Set(matching.map((item) => item.label))],
    };
  });
  return {
    total: routes.length,
    matched: rows.filter((row) => row.status === "matched").length,
    checked: rows.filter((row) => row.status !== "unchecked").length,
    rows,
  };
}

module.exports = { documentationCoverage };
