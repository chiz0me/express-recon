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
  if (!s?.file) return "—";
  const relative = path.relative(process.cwd(), s.file);
  const file = relative && !relative.startsWith("..") ? relative : s.file;
  return `${file.split(path.sep).join("/")}:${s.line ?? "?"}`;
}

function findingIdentity(finding) {
  return [
    `**${finding.severity}**`,
    finding.source ? sourceLabel(finding.source) : null,
    finding.fingerprint ? `\`${finding.fingerprint}\`` : null,
  ]
    .filter(Boolean)
    .join(" · ");
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
    if (audit) base.push(r.accepted ? "public (accepted)" : r.authStatus);
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
        return `- ${findingIdentity(f)} · \`${f.path}\` — ${f.methods.map((m) => `${m.method}=${m.authStatus}`).join(", ")}`;
      }
      return `- ${findingIdentity(f)} · \`${f.method} ${f.path}\``;
    })
    .join("\n");
}

function detailList(findings, id, emptyMsg) {
  const matches = findings.filter((f) => f.id === id);
  if (matches.length === 0) return emptyMsg;
  return matches.map((f) => `- ${f.detail}`).join("\n");
}

function auditSections(report) {
  const f = report.findings;
  const s = report.summary;
  const accepted = s.accepted ? `, accepted: **${s.accepted}**` : "";
  const policyViolations = s.policyViolations
    ? `, policy violations: **${s.policyViolations}**`
    : "";
  const policyExceptions = s.policyExceptions
    ? `, active exceptions: **${s.policyExceptions}**`
    : "";
  const sections = [
    `Total routes: **${s.routes}** — public: **${s.public}**, needs review: **${s.unknown}**, proven auth: **${s.proven}**${accepted}${policyViolations}${policyExceptions}`,
    "",
    "## Public — no recognised auth middleware",
    "",
    findingList(
      f,
      "public-route",
      "_None — every route matched an auth middleware, is accepted, or needs review._",
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
  if (f.some((x) => x.id === "policy-violation")) {
    sections.push(
      "## Configured policy violations",
      "",
      f
        .filter((finding) => finding.id === "policy-violation")
        .map(
          (finding) =>
            `- **${finding.ruleId}** · ${findingIdentity(finding)} · \`${finding.method} ${finding.path}\` — ${finding.detail}`,
        )
        .join("\n"),
      "",
    );
  }
  if (report.policyExceptions?.length) {
    sections.push(
      "## Active policy exceptions",
      "",
      report.policyExceptions
        .map(
          (exception) =>
            `- **${exception.policyId}/${exception.exceptionId}** · \`${exception.method} ${exception.path}\` — expires ${exception.expires}: ${exception.reason}`,
        )
        .join("\n"),
      "",
    );
  }
  if (f.some((x) => x.id === "stale-baseline")) {
    sections.push(
      "## Stale baseline entries — prune from acceptedPublic",
      "",
      detailList(f, "stale-baseline", "_None._"),
      "",
    );
  }
  return sections;
}

function deltaSections(delta) {
  const s = delta.summary;
  const sections = [
    "## Baseline delta",
    "",
    `Routes added: **${s.addedRoutes}**, removed: **${s.removedRoutes}**; auth regressions: **${s.authRegressions}**, improvements: **${s.authImprovements}**; new findings: **${s.newFindings}**, resolved: **${s.resolvedFindings}**`,
    "",
  ];
  if (delta.authRegressions.length) {
    sections.push(
      "### Authentication regressions",
      "",
      delta.authRegressions
        .map(
          (change) =>
            `- \`${change.method} ${change.path}\` · ${sourceLabel(change.source)} — ${change.from} → **${change.to}**. ${change.explanation}`,
        )
        .join("\n"),
      "",
    );
  }
  if (delta.newFindings.length) {
    sections.push(
      "### Net-new findings",
      "",
      delta.newFindings
        .map(
          (finding) =>
            `- **${finding.ruleId}** · ${findingIdentity(finding)}${finding.method ? ` · \`${finding.method} ${finding.path}\`` : ""} — ${finding.detail}`,
        )
        .join("\n"),
      "",
    );
  }
  return sections;
}

function format(report) {
  const audit = report.command === "audit";
  const sections = [`# Express route ${audit ? "audit" : "inventory"}`, ""];
  if (audit) sections.push(...auditSections(report));
  else sections.push(`Total routes: **${report.routes.length}**`, "");
  if (report.delta) sections.push(...deltaSections(report.delta));
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
