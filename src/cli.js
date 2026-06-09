#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  inventory,
  audit,
  suggestAuth,
  buildReport,
  instrument,
  REPORT_SCHEMA,
  formatters,
} = require("./index");

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
                        EXPRESS_RECON_DRY=1 is set before requiring it.
  --config <path>       JS file exporting { authMiddleware: { name: tag } } (audit)
  --format json,md,pretty   default: pretty (json for suggest-auth/schema)
  --out <dir>           write routes.json/routes.md into <dir> (else stdout)
  --fail-on <statuses>  audit only: exit 2 if any route matches, e.g. public or
                        public,unknown. For CI gates and agent assertions.
  --help                show this message
`;

const STATUSES = new Set(["public", "unknown", "proven"]);

function parseArgs(argv) {
  const out = { command: argv[0], mode: "static", format: "pretty" };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--mode") out.mode = argv[++i];
    else if (arg === "--src") out.src = argv[++i];
    else if (arg === "--app") out.app = argv[++i];
    else if (arg === "--config") out.config = argv[++i];
    else if (arg === "--format") out.format = argv[++i];
    else if (arg === "--out") out.out = argv[++i];
    else if (arg === "--fail-on") out.failOn = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function die(message, code) {
  process.stderr.write(`${message}\n`);
  process.exit(code || 1);
}

function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

/** Instrument the app's own express instance so mount paths survive (Express 5). */
function instrumentApp(resolved) {
  try {
    instrument(require(require.resolve("express", { paths: [path.dirname(resolved)] })));
  } catch {
    /* app may not use a resolvable express; mount paths fall back to regexp recovery */
  }
}

function loadApp(appPath) {
  if (!appPath) die("runtime/hybrid mode requires --app");
  process.env.EXPRESS_RECON_DRY = "1";
  const resolved = resolvePath(appPath);
  instrumentApp(resolved);
  let mod;
  try {
    mod = require(resolved);
  } catch (err) {
    die(`Failed to require ${resolved}:\n  ${err.message}`);
  }
  const app = mod && mod.app ? mod.app : mod;
  if (!app || (typeof app !== "function" && !app.use)) {
    die(`Module at ${resolved} did not export an Express app (got ${typeof app}).`);
  }
  return app;
}

function loadConfig(configPath) {
  return configPath ? require(resolvePath(configPath)) : {};
}

function harnessOpts(args) {
  const needsApp = args.mode === "runtime" || args.mode === "hybrid";
  return {
    mode: args.mode,
    src: resolvePath(args.src || process.cwd()),
    app: needsApp ? loadApp(args.app) : undefined,
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
  if (formats.has("pretty") && (!outDir || formats.size === 1)) {
    process.stdout.write(formatters.pretty.format(report) + "\n");
  }
}

function failOnExit(report, failOn) {
  if (!failOn) return 0;
  const statuses = failOn.split(",").map((s) => s.trim());
  for (const s of statuses) if (!STATUSES.has(s)) die(`--fail-on: unknown status "${s}"`);
  const hit = report.routes.filter((r) => statuses.includes(r.authStatus));
  if (hit.length === 0) return 0;
  process.stderr.write(`express-recon: ${hit.length} route(s) matched --fail-on ${failOn}\n`);
  return 2;
}

function runReportCommand(command, args) {
  const config = command === "audit" ? loadConfig(args.config) : {};
  const opts = harnessOpts(args);
  const registry = command === "audit" ? audit(opts, config) : inventory(opts);
  const report = buildReport(registry, { command, mode: args.mode });
  writeReport(report, args);
  return command === "audit" ? failOnExit(report, args.failOn) : 0;
}

function runSuggestAuth(args) {
  const result = suggestAuth(inventory(harnessOpts(args)));
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return 0;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || !args.command || args.command === "help") {
    process.stdout.write(USAGE);
    return args.command ? 0 : 1;
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

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  die(err.message);
}
