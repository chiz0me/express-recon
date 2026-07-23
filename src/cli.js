#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  inventory,
  audit,
  suggestAuth,
  buildReport,
  REPORT_SCHEMA,
  formatters,
  compareReports,
} = require("./index");
const { executeRuntime } = require("./runtime/execute");
const { loadPackageInfo } = require("./static/resolve");
const { loadConfig } = require("./config");

const USAGE = `
express-recon — inventory & audit Express 4/5 route surfaces

Usage: express-recon <command> [options]

Commands:
  inventory     List every route, method, middleware chain, and source location.
  audit         Inventory + classify each route as proven/public/review against
                an auth allowlist, and emit findings (public routes, per-verb gaps).
  suggest-auth  Propose auth-middleware allowlist candidates (JSON) for --config.
  schema        Print the JSON Schema of the report contract and exit.

Options:
  --mode static|runtime|hybrid   default: static
  --src <dir>           repo root to statically scan (static/hybrid; default cwd)
  --app <path>          JS file exporting the Express app (runtime/hybrid).
                        Executes trusted target code in a bounded worker process.
                        This contains crashes/exits/timers but is not an OS sandbox.
                        EXPRESS_RECON_DRY=1 is set before requiring it.
  --config <path>       JSON/YAML data or JS exporting auth, policies, scan
                        scope, and runtime/hybrid boot options.
  --format json,md,pretty,openapi   default: pretty (json for suggest-auth/schema).
                        openapi emits an OpenAPI 3.1 document (openapi.json); run it
                        over the audit command to populate the security section.
  --out <dir>           write routes.json/routes.md into <dir> (else stdout)
  --baseline <path>     compare with a prior JSON report; adds delta/new findings
  --fail-on <statuses>  audit only: exit 2 if any route matches, e.g. public or
                        public,unknown, policy / policy:<id>, new, regression,
                        or incomplete (static/hybrid files failed to parse/read;
                        rejected in pure runtime mode).
                        For CI gates and agent assertions.
  --include <glob>      scan only matching root-relative source paths (repeatable)
  --exclude <glob>      exclude matching root-relative source paths (repeatable)
  --ignore-file <path>  root-relative scope file (default: .express-reconignore)
  --include-tests       also scan test files/dirs (excluded by default)
  --help                show this message
`;

const STATUSES = new Set([
  "public",
  "unknown",
  "proven",
  "policy",
  "new",
  "regression",
  "incomplete",
]);
const COMMANDS = new Set(["audit", "help", "inventory", "schema", "suggest-auth"]);
const MODES = new Set(["static", "runtime", "hybrid"]);
const FORMATS = new Set(["json", "md", "pretty", "openapi"]);
const REPEATABLE_OPTIONS = new Set(["--exclude", "--include"]);

function parseArgs(argv) {
  if (argv[0] === "--help" || argv[0] === "-h") return { help: true };
  const out = { command: argv[0], mode: "static", format: "pretty" };
  const provided = new Set();
  const takeValue = (option, index) => {
    const value = argv[index + 1];
    if (value === undefined || !value.trim() || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    if (provided.has(option) && !REPEATABLE_OPTIONS.has(option)) {
      throw new Error(`${option} may only be specified once`);
    }
    provided.add(option);
    return value;
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--mode") out.mode = takeValue(arg, i++);
    else if (arg === "--src") out.src = takeValue(arg, i++);
    else if (arg === "--app") out.app = takeValue(arg, i++);
    else if (arg === "--config") out.config = takeValue(arg, i++);
    else if (arg === "--format") out.format = takeValue(arg, i++);
    else if (arg === "--out") out.out = takeValue(arg, i++);
    else if (arg === "--baseline") out.baseline = takeValue(arg, i++);
    else if (arg === "--fail-on") out.failOn = takeValue(arg, i++);
    else if (arg === "--include") (out.include ||= []).push(takeValue(arg, i++));
    else if (arg === "--exclude") (out.exclude ||= []).push(takeValue(arg, i++));
    else if (arg === "--ignore-file") out.ignoreFile = takeValue(arg, i++);
    else if (arg === "--include-tests") {
      if (provided.has(arg)) throw new Error(`${arg} may only be specified once`);
      provided.add(arg);
      out.includeTests = true;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  out.provided = provided;
  return out;
}

function validateArgs(args) {
  if (!args.command || args.help) return;
  if (!COMMANDS.has(args.command)) throw new Error(`Unknown command: ${args.command}`);
  if (!MODES.has(args.mode)) throw new Error("--mode must be static, runtime, or hybrid");

  const formats = args.format.split(",");
  if (
    formats.length === 0 ||
    formats.some((format) => !format.trim() || !FORMATS.has(format.trim()))
  ) {
    throw new Error("--format must contain one or more of: json, md, pretty, openapi");
  }
  if (new Set(formats.map((format) => format.trim())).size !== formats.length) {
    throw new Error("--format must not contain duplicates");
  }

  if ((args.command === "schema" || args.command === "help") && args.provided.size) {
    throw new Error(`${args.command} does not accept scan or output options`);
  }
  if (args.command === "suggest-auth") {
    const supported = new Set([
      "--app",
      "--config",
      "--exclude",
      "--format",
      "--ignore-file",
      "--include",
      "--include-tests",
      "--mode",
      "--src",
    ]);
    const unsupported = [...args.provided].filter((option) => !supported.has(option));
    if (unsupported.length) {
      throw new Error(`suggest-auth does not accept ${unsupported.join(", ")}`);
    }
    if (args.provided.has("--format") && args.format !== "json") {
      throw new Error("suggest-auth supports only --format json");
    }
  }
  if (args.failOn && args.command !== "audit") {
    throw new Error("--fail-on is supported only by the audit command");
  }
  if (args.failOn) {
    const statuses = args.failOn.split(",").map((status) => status.trim());
    const invalid = statuses.find(
      (status) =>
        !status ||
        (!STATUSES.has(status) &&
          !(status.startsWith("policy:") && status.length > "policy:".length)),
    );
    if (invalid !== undefined) {
      throw new Error(`--fail-on: unknown or empty status "${invalid}"`);
    }
    if ((statuses.includes("new") || statuses.includes("regression")) && !args.baseline) {
      throw new Error("--fail-on new/regression requires --baseline <report.json>");
    }
    if (statuses.includes("incomplete") && args.mode === "runtime") {
      throw new Error("--fail-on incomplete requires static or hybrid mode");
    }
  }
  if ((args.mode === "runtime" || args.mode === "hybrid") && !args.app) {
    throw new Error("runtime/hybrid mode requires --app");
  }
}

function die(message, code) {
  process.stderr.write(`${message}\n`);
  process.exit(code || 1);
}

function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

async function loadRuntime(appPath, boot) {
  if (!appPath) die("runtime/hybrid mode requires --app");
  const resolved = resolvePath(appPath);
  return executeRuntime(resolved, boot);
}

async function harnessOpts(args, config) {
  const needsApp = args.mode === "runtime" || args.mode === "hybrid";
  const runtimeRegistry = needsApp ? await loadRuntime(args.app, config.boot || {}) : null;
  const scan = config.scan || {};
  return {
    opts: {
      mode: args.mode,
      src: resolvePath(args.src || process.cwd()),
      runtimeRegistry: runtimeRegistry || undefined,
      includeTests: args.includeTests,
      include: [...(scan.include || []), ...(args.include || [])],
      exclude: [...(scan.exclude || []), ...(args.exclude || [])],
      ignoreFile: args.ignoreFile === undefined ? scan.ignoreFile : args.ignoreFile,
    },
  };
}

function emit(text, format, outDir, file) {
  if (!outDir) return process.stdout.write(text + "\n");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, file), text + "\n");
}

function writeReport(report, args) {
  const formats = new Set(
    args.format
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const outDir = args.out ? resolvePath(args.out) : null;
  if (formats.has("json")) emit(formatters.json.format(report), "json", outDir, "routes.json");
  if (formats.has("md")) emit(formatters.markdown.format(report), "md", outDir, "routes.md");
  if (formats.has("openapi"))
    emit(formatters.openapi.format(report), "openapi", outDir, "openapi.json");
  if (formats.has("pretty") && (!outDir || formats.size === 1)) {
    process.stdout.write(formatters.pretty.format(report) + "\n");
  }
}

function failOnExit(report, failOn) {
  if (!failOn) return 0;
  const statuses = failOn.split(",").map((s) => s.trim());
  for (const status of statuses) {
    if (
      !STATUSES.has(status) &&
      !(status.startsWith("policy:") && status.length > "policy:".length)
    ) {
      die(`--fail-on: unknown status "${status}"`);
    }
  }
  if ((statuses.includes("new") || statuses.includes("regression")) && !report.delta) {
    die("--fail-on new/regression requires --baseline <report.json>");
  }
  const routeHits = report.routes.filter(
    (route) => statuses.includes(route.authStatus) && !route.accepted,
  );
  const policyIds = statuses
    .filter((status) => status.startsWith("policy:"))
    .map((status) => status.slice("policy:".length));
  const policyHits = report.findings.filter(
    (finding) =>
      finding.id === "policy-violation" &&
      (statuses.includes("policy") || policyIds.includes(finding.ruleId)),
  );
  const count = routeHits.length + policyHits.length;
  const newHits = statuses.includes("new") ? (report.delta?.newFindings.length ?? 0) : 0;
  const regressionHits = statuses.includes("regression")
    ? (report.delta?.authRegressions.length ?? 0)
    : 0;
  const incompleteHits =
    statuses.includes("incomplete") && report.scanCoverage?.complete === false ? 1 : 0;
  const total = count + newHits + regressionHits + incompleteHits;
  if (total === 0) return 0;
  process.stderr.write(`express-recon: ${total} result(s) matched --fail-on ${failOn}\n`);
  return 2;
}

function attachBaseline(report, baselinePath) {
  if (!baselinePath) return report;
  const resolved = resolvePath(baselinePath);
  let baseline;
  try {
    baseline = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (err) {
    throw new Error(`Could not read baseline report ${resolved}: ${err.message}`);
  }
  report.delta = compareReports(baseline, report);
  report.delta.baseline.file = resolved;
  return report;
}

async function runReportCommand(command, args) {
  const config = loadConfig(args.config); // inventory reads it too, for `boot`
  const { opts } = await harnessOpts(args, config);
  const registry = command === "audit" ? audit(opts, config) : inventory(opts);
  const target = loadPackageInfo(opts.src);
  const report = attachBaseline(
    buildReport(registry, { command, mode: args.mode, target }),
    args.baseline,
  );
  writeReport(report, args);
  warnDiagnostics(report);
  return command === "audit" ? failOnExit(report, args.failOn) : 0;
}

function warnDiagnostics(report) {
  for (const message of report.diagnostics || [])
    process.stderr.write(`express-recon [warn]: ${message}\n`);
}

async function runSuggestAuth(args) {
  const { opts } = await harnessOpts(args, loadConfig(args.config));
  const result = suggestAuth(inventory(opts));
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return 0;
}

async function main(argv) {
  const args = parseArgs(argv);
  validateArgs(args);
  if (args.help || !args.command || args.command === "help") {
    process.stdout.write(USAGE);
    return args.help || args.command ? 0 : 1;
  }
  if (args.command === "schema") {
    process.stdout.write(JSON.stringify(REPORT_SCHEMA, null, 2) + "\n");
    return 0;
  }
  if (args.command === "suggest-auth") return runSuggestAuth(args);
  if (args.command === "inventory" || args.command === "audit")
    return runReportCommand(args.command, args);
  die(`Unknown command: ${args.command}\n${USAGE}`);
}

// Set the exit code and let the process end on its own rather than calling
// process.exit(), which would truncate a large report still buffered in the
// stdout pipe (~64KB) — e.g. `express-recon audit --format json | jq`. Static
// scanning is synchronous. Runtime execution happens in a child that exits
// after returning its serialized registry, so target timers cannot hold this
// process open.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => die(err.message),
);
