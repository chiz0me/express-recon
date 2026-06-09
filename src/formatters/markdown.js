"use strict";

const path = require("node:path");

function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|");
}

function renderRow(cells) {
  return "| " + cells.map(escapeCell).join(" | ") + " |";
}

function compareRoutes(a, b) {
  if (a.path === b.path) return a.method.localeCompare(b.method);
  return a.path.localeCompare(b.path);
}

function mwNames(middlewares) {
  return middlewares.map((m) => m.name).join(" → ") || "—";
}

function sourceLabel(s) {
  return s && s.file ? `${path.basename(s.file)}:${s.line}` : "—";
}

function pathCell(r) {
  return r.path + (r.pathConfidence === "partial" ? " _(partial)_" : "");
}

function renderTable(routes, audit) {
  const sorted = routes.slice().sort(compareRoutes);
  const cols = audit
    ? ["Method", "Path", "Auth", "Source", "Middlewares"]
    : ["Method", "Path", "Source", "Middlewares"];
  const body = sorted.map((r) => {
    const base = [r.method, pathCell(r)];
    if (audit) base.push(r.authStatus);
    base.push(sourceLabel(r.source), mwNames(r.middlewares));
    return renderRow(base);
  });
  return [renderRow(cols), renderRow(cols.map(() => "---")), ...body].join("\n");
}

function findingList(findings, id, emptyMsg) {
  const matches = findings.filter((f) => f.id === id);
  if (matches.length === 0) return emptyMsg;
  return matches
    .map((f) => {
      if (f.id === "per-verb-gap") {
        return `- \`${f.path}\` — ${f.methods.map((m) => `${m.method}=${m.authStatus}`).join(", ")}`;
      }
      return `- \`${f.method} ${f.path}\` — ${sourceLabel(f.source)}`;
    })
    .join("\n");
}

function auditSections(report) {
  const f = report.findings;
  const s = report.summary;
  return [
    `Total routes: **${s.routes}** — public: **${s.public}**, needs review: **${s.unknown}**, proven auth: **${s.proven}**`,
    "",
    "## Public — no recognised auth middleware",
    "",
    findingList(
      f,
      "public-route",
      "_None — every route matched an auth middleware or needs review._",
    ),
    "",
    "## Per-verb auth gaps — same path, different auth per method",
    "",
    findingList(f, "per-verb-gap", "_None — every path is consistent across its methods._"),
    "",
    "## Needs review — opaque (inline/anonymous) middleware",
    "",
    findingList(f, "opaque-middleware", "_None._"),
    "",
  ];
}

function format(report) {
  const audit = report.command === "audit";
  const sections = [`# Express route ${audit ? "audit" : "inventory"}`, ""];
  if (audit) sections.push(...auditSections(report));
  else sections.push(`Total routes: **${report.routes.length}**`, "");
  sections.push(
    "## Global middleware",
    "",
    report.globalMiddleware.length === 0
      ? "_None detected._"
      : report.globalMiddleware.map((m) => `- \`${m.name}\``).join("\n"),
    "",
    "## All routes",
    "",
    renderTable(report.routes, audit),
    "",
  );
  return sections.join("\n");
}

module.exports = { format };
