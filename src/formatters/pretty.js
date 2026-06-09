"use strict";

const path = require("node:path");

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

const METHOD_COLOR = {
  GET: COLORS.green,
  POST: COLORS.yellow,
  PUT: COLORS.cyan,
  PATCH: COLORS.cyan,
  DELETE: COLORS.red,
  HEAD: COLORS.dim,
  OPTIONS: COLORS.dim,
  ALL: COLORS.bold,
};

const STATUS_COLOR = { public: COLORS.red, unknown: COLORS.yellow, proven: COLORS.green };

function paint(text, color) {
  return process.stdout.isTTY ? `${color}${text}${COLORS.reset}` : text;
}

function padRight(text, width) {
  // oxlint-disable-next-line no-control-regex -- strip ANSI colour codes for width math
  const visible = text.replace(/\x1b\[[0-9;]*m/g, "");
  return text + " ".repeat(Math.max(width - visible.length, 0));
}

function compareRoutes(a, b) {
  if (a.path === b.path) return a.method.localeCompare(b.method);
  return a.path.localeCompare(b.path);
}

function mwNames(middlewares) {
  return middlewares.map((m) => m.name).join(" → ") || "—";
}

function sourceLabel(s) {
  return s && s.file ? `${path.basename(s.file)}:${s.line}` : "";
}

function header(report) {
  const lines = [
    paint(`${report.command} · ${report.mode} · ${report.routes.length} routes`, COLORS.bold),
  ];
  if (report.summary) {
    const s = report.summary;
    lines.push(
      paint(`public: ${s.public}   review: ${s.unknown}   proven-auth: ${s.proven}`, COLORS.dim),
    );
  }
  lines.push(paint(`Global middleware: ${mwNames(report.globalMiddleware)}`, COLORS.dim), "");
  return lines;
}

function renderRoute(route, audit) {
  const method = paint(route.method.padEnd(7), METHOD_COLOR[route.method] || COLORS.dim);
  const routePath = padRight(route.path + (route.pathConfidence === "partial" ? " ?" : ""), 34);
  const src = paint(sourceLabel(route.source).padEnd(22), COLORS.dim);
  const mw = paint(mwNames(route.middlewares), COLORS.dim);
  if (!audit) return `  ${method} ${routePath} ${src} ${mw}`;
  const status = paint(`[${route.authStatus}]`, STATUS_COLOR[route.authStatus] || COLORS.dim);
  return `  ${method} ${routePath} ${padRight(status, 11)} ${src} ${mw}`;
}

function format(report) {
  const audit = report.command === "audit";
  const sorted = report.routes.slice().sort(compareRoutes);
  const lines = header(report);
  for (const route of sorted) lines.push(renderRoute(route, audit));
  return lines.join("\n");
}

module.exports = { format };
