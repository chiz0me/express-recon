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
const { resetCapture, getCapturedRoots, harvestApp } = require("./runtime/instrument");
const { installSandbox } = require("./runtime/sandbox");

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
                        Booted in a sandbox: infra clients (pg, redis, mongoose,
                        …) are stubbed, listen()/process.exit are neutralized.
                        EXPRESS_RECON_DRY=1 is set before requiring it.
  --config <path>       JS file exporting { authMiddleware: { name: tag } } (audit)
                        and boot options for runtime/hybrid:
                        { boot: { sandbox: false, stubModules: [...], env: {...} } }
  --format json,md,pretty   default: pretty (json for suggest-auth/schema)
  --out <dir>           write routes.json/routes.md into <dir> (else stdout)
  --fail-on <statuses>  audit only: exit 2 if any route matches, e.g. public or
                        public,unknown. For CI gates and agent assertions.
  --include-tests       also scan test files/dirs (excluded by default)
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
    else if (arg === "--include-tests") out.includeTests = true;
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

async function loadApp(appPath, boot) {
  if (!appPath) die("runtime/hybrid mode requires --app");
  process.env.EXPRESS_RECON_DRY = "1";
  for (const [key, value] of Object.entries(boot.env || {})) process.env[key] = String(value);
  const resolved = resolvePath(appPath);
  instrumentApp(resolved);
  resetCapture();
  const sandbox = boot.sandbox === false ? null : installSandbox({ stubModules: boot.stubModules });
  let mod;
  let bootError = null;
  try {
    mod = require(resolved);
  } catch (err) {
    bootError = err;
  }
  // Drain the microtask queue once, so routes registered after an awaited
  // (stubbed) connect — `await client.connect(); wireRoutes(app)` — exist
  // before the stack is walked. Stubs never do IO, so one tick suffices.
  await new Promise((resolve) => setImmediate(resolve));
  const bootDiagnostics = sandbox ? sandbox.diagnostics() : [];
  if (sandbox) sandbox.uninstall(); // die() below needs the real process.exit
  const exported = mod && mod.app ? mod.app : mod;
  const usable = exported && (typeof exported === "function" || exported.use);
  if (!bootError && usable) return { app: exported, bootDiagnostics };
  const reason = bootError
    ? `threw during require: ${bootError.message}`
    : `did not export an Express app (got ${typeof exported})`;
  const roots = getCapturedRoots();
  if (roots.length === 0) die(`Failed to load ${resolved}:\n  ${reason}`);
  bootDiagnostics.push(
    `boot: ${resolved} ${reason}; harvested routes from ${roots.length} captured ` +
      `app/router(s) registered before the failure — results may be partial`,
  );
  return { app: harvestApp(roots), bootDiagnostics };
}

function loadConfig(configPath) {
  return configPath ? require(resolvePath(configPath)) : {};
}

async function harnessOpts(args, config) {
  const needsApp = args.mode === "runtime" || args.mode === "hybrid";
  const loaded = needsApp ? await loadApp(args.app, config.boot || {}) : null;
  return {
    opts: {
      mode: args.mode,
      src: resolvePath(args.src || process.cwd()),
      app: loaded ? loaded.app : undefined,
      includeTests: args.includeTests,
    },
    bootDiagnostics: loaded ? loaded.bootDiagnostics : [],
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
  const hit = report.routes.filter((r) => statuses.includes(r.authStatus) && !r.accepted);
  if (hit.length === 0) return 0;
  process.stderr.write(`express-recon: ${hit.length} route(s) matched --fail-on ${failOn}\n`);
  return 2;
}

async function runReportCommand(command, args) {
  const config = loadConfig(args.config); // inventory reads it too, for `boot`
  const { opts, bootDiagnostics } = await harnessOpts(args, config);
  const registry = command === "audit" ? audit(opts, config) : inventory(opts);
  if (bootDiagnostics.length > 0)
    registry.diagnostics = [...(registry.diagnostics || []), ...bootDiagnostics];
  const report = buildReport(registry, { command, mode: args.mode });
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

// Set the exit code and let the process end on its own rather than calling
// process.exit(), which would truncate a large report still buffered in the
// stdout pipe (~64KB) — e.g. `express-recon audit --format json | jq`. Static
// scanning is synchronous, and under the boot sandbox listen() never binds a
// port, so a loaded app leaves no open handles and the event loop drains once
// output flushes. Caveat: an app that starts its own timers at boot
// (setInterval health pingers) still holds the loop open — the escape hatches
// are `boot: { sandbox: false }` plus an EXPRESS_RECON_DRY gate in the app.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => die(err.message),
);
