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
  discover,
  reconcileDocumentation,
  createMiddlewareReview,
  applyMiddlewareAssessments,
  scanRepository,
  scanOrganization,
  renderHtmlSite,
} = require("./index");
const { executeRuntime } = require("./runtime/execute");
const { loadPackageInfo } = require("./static/resolve");
const { loadConfig } = require("./config");
const { loadReviewFile } = require("./review");
const { DEFAULT_MAX_REPOSITORIES } = require("./organization");
const { PROGRESS_MODES, createOrganizationProgressReporter } = require("./organization-progress");
const {
  CHECKPOINT_FILENAME,
  atomicWriteJson,
  checkpointEntry,
  checkpointPath,
  initialCheckpoint,
  loadCheckpoint,
  organizationCheckpointIdentity,
  withCompleted,
} = require("./organization-checkpoint");

const USAGE = `
express-recon — inventory & audit Express 4/5 route surfaces

Usage: express-recon <command> [options]

Quick start (offline; target code is not executed):
  express-recon discover --src . --out .express-recon
  express-recon inventory --src . --format json,md --out .express-recon
  express-recon suggest-auth --src .
  express-recon audit --src . --config recon.config.yaml --format json,md --out .express-recon

Commands:
  discover      Find packages, Express apps, entry candidates, and API docs
                without executing target code.
  inventory     List every route, method, middleware chain, and source location.
  audit         Inventory + classify each route as proven/public/unknown against
                an auth allowlist, and emit findings (public routes, per-verb gaps).
  suggest-auth  Propose auth-middleware allowlist candidates (JSON) for --config.
  docs          Reconcile an existing OpenAPI document, swagger-jsdoc blocks,
                and the offline route inventory into OpenAPI + drift evidence.
  review-middleware
                Export bounded source evidence + a provider-neutral assessment
                schema for human or AI middleware classification.
  import-review Validate a middleware assessment against its exact evidence
                bundle and emit advisory config suggestions without applying them.
  scan-repo     Fetch a GitHub/HTTPS/local Git ref without checkout, materialize
                bounded source/docs files, then discover, inventory/audit, and
                reconcile documentation when possible. Never executes target code.
  scan-org      Enumerate API-visible repositories in one GitHub organization,
                scan them statically, and build an aggregate Express inventory.
  render        Generate a browsable offline HTML site from an existing report
                JSON file or express-recon output directory. Does not rescan.
  schema        Print the JSON Schema of the report contract and exit.

Options:
  --mode static|runtime|hybrid   default: static
  --src <dir>           repo root to statically scan (static/hybrid; default cwd)
  --app <path|auto>     JS file exporting the Express app (runtime/hybrid).
                        Executes trusted target code in a bounded worker process.
                        This contains crashes/exits/timers but is not an OS sandbox.
                        EXPRESS_RECON_DRY=1 is set before requiring it.
                        Use "auto" only for trusted local code with --allow-exec.
  --allow-exec          permit trusted local --app auto entry selection.
  --app-id <id|all>     application to document, or the booted app identity for
                        a hybrid scan of a multi-app repository.
  --spec <path>         existing OpenAPI 3 JSON/YAML (auto-detected if unique).
  --jsdoc <path>        swagger-jsdoc/OpenAPI annotation source (repeatable;
                        auto-detected when omitted).
  --review <path>       middleware-review.json input for import-review.
  --assessment <path>   JSON/YAML assessment input for import-review.
  --input <path>        routes.json, repo-scan.json, organization-inventory.json,
                        or a directory containing one of those files (render only).
  --repo <url|owner/repo|path>
                        repository for scan-repo (HTTPS/GitHub shorthand/local).
  --org <name>          GitHub organization for scan-org. GH_TOKEN or GITHUB_TOKEN
                        adds repositories visible to that token and private fetches.
  --ref <git-ref>       branch, tag, or commit to fetch (default: remote HEAD).
  --max-repos <n>       scan-org repository cap (default 100; maximum 10000).
  --concurrency <n>     scan-org snapshots processed at once (default 1; maximum 8).
  --resume              resume a scan-org run from the checkpoint in --out.
  --progress <mode>     scan-org progress on stderr: auto, plain, json, or none
                        (default: auto; TTY status locally, plain lines in CI).
  --no-progress         alias for --progress none.
  --include-archived   scan archived organization repositories (default: skip).
  --include-forks      scan organization forks (default: skip).
  --config <path>       JSON/YAML data or JS exporting auth, policies, scan
                        scope, and runtime/hybrid boot options.
  --format json,md,pretty,openapi   default: pretty for inventory/audit; JSON for
                        discovery/review/repository commands.
                        openapi emits an OpenAPI 3.1 document (openapi.json); use
                        audit plus an explicit security mapping to add security.
  --out <dir>           write command-specific artifacts into <dir> (else stdout).
                        Required by render and agent-initiated organization scans.
  --baseline <path>     compare with a prior JSON report; adds delta/new findings
  --fail-on <statuses>  audit: exit 2 if any route matches, e.g. public or
                        public,unknown, policy / policy:<id>, new, regression,
                        or incomplete (static/hybrid files failed to parse/read;
                        rejected in pure runtime mode).
                        For CI gates and agent assertions.
                        docs accepts docs-drift, docs-conflict, docs-incomplete.
                        scan-org accepts incomplete.
  --include <glob>      scan only matching root-relative source paths (repeatable)
  --exclude <glob>      exclude matching root-relative source paths (repeatable)
  --ignore-file <path>  scope file; relative paths use scan root
                        (default: .express-reconignore)
  --no-ignore-file      disable the default/configured scan ignore file
  --include-tests       also scan test files/dirs (excluded by default)
  --help                show this message

Environment:
  EXPRESS_RECON_CONTEXT=agent
                        scan-org requires --out and defaults progress to none.
                        Explicit --progress/--no-progress always takes precedence.
  EXPRESS_RECON_CONTEXT=ci
                        scan-org defaults to stable plain progress.
  EXPRESS_RECON_CONTEXT=interactive
                        scan-org retains automatic TTY/non-TTY progress selection.

Terminology:
  public   no configured authentication guard matched; not a reachability claim
  unknown  opaque middleware may contain a guard and requires review
  proven   a configured guard was observed; its implementation is not verified

Exit codes:
  0  command completed and no requested gate matched
  1  invalid input or operational failure
  2  command completed and a --fail-on gate matched
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
const DOC_STATUSES = new Set(["docs-conflict", "docs-drift", "docs-incomplete"]);
const COMMANDS = new Set([
  "audit",
  "docs",
  "discover",
  "help",
  "import-review",
  "inventory",
  "review-middleware",
  "render",
  "scan-org",
  "scan-repo",
  "schema",
  "suggest-auth",
]);
const MODES = new Set(["static", "runtime", "hybrid"]);
const FORMATS = new Set(["json", "md", "pretty", "openapi"]);
const REPEATABLE_OPTIONS = new Set(["--exclude", "--include", "--jsdoc"]);
const JSON_PROGRESS_ERRORS = new WeakSet();
const EXECUTION_CONTEXTS = new Set(["agent", "auto", "ci", "interactive"]);

function resolveExecutionContext(environment = process.env) {
  const raw = environment.EXPRESS_RECON_CONTEXT;
  if (raw === undefined || raw === null || String(raw).trim() === "") return "auto";
  const context = String(raw).trim().toLowerCase();
  if (!EXECUTION_CONTEXTS.has(context)) {
    throw new Error("EXPRESS_RECON_CONTEXT must be agent, auto, ci, or interactive");
  }
  return context;
}

function resolveOrganizationProgressMode(args, context) {
  const explicit =
    args.provided instanceof Set
      ? args.provided.has("--progress") || args.provided.has("--no-progress")
      : args.progress !== undefined;
  if (explicit) return args.progress;
  if (context === "agent") return "none";
  if (context === "ci") return "plain";
  if (context === "interactive") return "auto";
  return args.progress || "none";
}

function parseArgs(argv) {
  if (argv[0] === "--help" || argv[0] === "-h") return { help: true };
  const out = { command: argv[0], mode: "static", format: "pretty", progress: "auto" };
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
    else if (arg === "--app-id") out.appId = takeValue(arg, i++);
    else if (arg === "--spec") out.spec = takeValue(arg, i++);
    else if (arg === "--jsdoc") (out.jsdoc ||= []).push(takeValue(arg, i++));
    else if (arg === "--review") out.review = takeValue(arg, i++);
    else if (arg === "--assessment") out.assessment = takeValue(arg, i++);
    else if (arg === "--input") out.input = takeValue(arg, i++);
    else if (arg === "--repo") out.repo = takeValue(arg, i++);
    else if (arg === "--org") out.org = takeValue(arg, i++);
    else if (arg === "--ref") out.ref = takeValue(arg, i++);
    else if (arg === "--max-repos") out.maxRepos = takeValue(arg, i++);
    else if (arg === "--concurrency") out.concurrency = takeValue(arg, i++);
    else if (arg === "--progress") out.progress = takeValue(arg, i++);
    else if (arg === "--config") out.config = takeValue(arg, i++);
    else if (arg === "--format") out.format = takeValue(arg, i++);
    else if (arg === "--out") out.out = takeValue(arg, i++);
    else if (arg === "--baseline") out.baseline = takeValue(arg, i++);
    else if (arg === "--fail-on") out.failOn = takeValue(arg, i++);
    else if (arg === "--include") (out.include ||= []).push(takeValue(arg, i++));
    else if (arg === "--exclude") (out.exclude ||= []).push(takeValue(arg, i++));
    else if (arg === "--ignore-file") out.ignoreFile = takeValue(arg, i++);
    else if (arg === "--no-ignore-file") {
      if (provided.has(arg)) throw new Error(`${arg} may only be specified once`);
      provided.add(arg);
      out.ignoreFile = false;
    } else if (arg === "--include-tests") {
      if (provided.has(arg)) throw new Error(`${arg} may only be specified once`);
      provided.add(arg);
      out.includeTests = true;
    } else if (arg === "--include-archived" || arg === "--include-forks") {
      if (provided.has(arg)) throw new Error(`${arg} may only be specified once`);
      provided.add(arg);
      if (arg === "--include-archived") out.includeArchived = true;
      else out.includeForks = true;
    } else if (arg === "--resume") {
      if (provided.has(arg)) throw new Error(`${arg} may only be specified once`);
      provided.add(arg);
      out.resume = true;
    } else if (arg === "--no-progress") {
      if (provided.has(arg)) throw new Error(`${arg} may only be specified once`);
      provided.add(arg);
      out.progress = "none";
    } else if (arg === "--allow-exec") {
      if (provided.has(arg)) throw new Error(`${arg} may only be specified once`);
      provided.add(arg);
      out.allowExec = true;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  out.provided = provided;
  return out;
}

function validateArgs(args) {
  if (!args.command || args.help) return;
  if (!COMMANDS.has(args.command)) throw new Error(`Unknown command: ${args.command}`);
  if (!MODES.has(args.mode)) throw new Error("--mode must be static, runtime, or hybrid");
  if (args.provided.has("--ignore-file") && args.provided.has("--no-ignore-file")) {
    throw new Error("--ignore-file and --no-ignore-file cannot be used together");
  }
  if (args.provided.has("--progress") && args.provided.has("--no-progress")) {
    throw new Error("--progress and --no-progress cannot be used together");
  }
  if (!PROGRESS_MODES.has(args.progress)) {
    throw new Error("--progress must be auto, plain, json, or none");
  }

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
  if (args.command === "inventory" || args.command === "audit") {
    const supported = new Set([
      "--allow-exec",
      "--app",
      "--app-id",
      "--baseline",
      "--config",
      "--exclude",
      "--format",
      "--ignore-file",
      "--no-ignore-file",
      "--include",
      "--include-tests",
      "--mode",
      "--out",
      "--src",
      ...(args.command === "audit" ? ["--fail-on"] : []),
    ]);
    const unsupported = [...args.provided].filter((option) => !supported.has(option));
    if (unsupported.length) {
      throw new Error(`${args.command} does not accept ${unsupported.join(", ")}`);
    }
    if (args.appId && args.mode !== "hybrid") {
      throw new Error("inventory/audit --app-id is supported only in hybrid mode");
    }
    if (args.appId === "all") {
      throw new Error('hybrid --app-id must select one application, not "all"');
    }
  }
  if (args.command === "suggest-auth") {
    const supported = new Set([
      "--app",
      "--allow-exec",
      "--config",
      "--exclude",
      "--format",
      "--ignore-file",
      "--no-ignore-file",
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
  if (args.command === "discover") {
    const supported = new Set([
      "--config",
      "--exclude",
      "--format",
      "--ignore-file",
      "--no-ignore-file",
      "--include",
      "--include-tests",
      "--out",
      "--src",
    ]);
    const unsupported = [...args.provided].filter((option) => !supported.has(option));
    if (unsupported.length) throw new Error(`discover does not accept ${unsupported.join(", ")}`);
    if (args.provided.has("--format") && args.format !== "json") {
      throw new Error("discover supports only --format json");
    }
  }
  if (args.command === "docs") {
    const supported = new Set([
      "--app-id",
      "--config",
      "--exclude",
      "--fail-on",
      "--format",
      "--ignore-file",
      "--no-ignore-file",
      "--include",
      "--include-tests",
      "--jsdoc",
      "--out",
      "--spec",
      "--src",
    ]);
    const unsupported = [...args.provided].filter((option) => !supported.has(option));
    if (unsupported.length) throw new Error(`docs does not accept ${unsupported.join(", ")}`);
    if (args.provided.has("--format") && !["json", "openapi"].includes(args.format)) {
      throw new Error("docs supports only --format json or openapi");
    }
  }
  if (args.command === "review-middleware") {
    const supported = new Set([
      "--app",
      "--allow-exec",
      "--config",
      "--exclude",
      "--format",
      "--ignore-file",
      "--no-ignore-file",
      "--include",
      "--include-tests",
      "--mode",
      "--out",
      "--src",
    ]);
    const unsupported = [...args.provided].filter((option) => !supported.has(option));
    if (unsupported.length) {
      throw new Error(`review-middleware does not accept ${unsupported.join(", ")}`);
    }
    if (args.provided.has("--format") && args.format !== "json") {
      throw new Error("review-middleware supports only --format json");
    }
  }
  if (args.command === "import-review") {
    const supported = new Set(["--assessment", "--format", "--out", "--review"]);
    const unsupported = [...args.provided].filter((option) => !supported.has(option));
    if (unsupported.length)
      throw new Error(`import-review does not accept ${unsupported.join(", ")}`);
    if (!args.review || !args.assessment) {
      throw new Error("import-review requires --review <bundle> and --assessment <file>");
    }
    if (args.provided.has("--format") && args.format !== "json") {
      throw new Error("import-review supports only --format json");
    }
  }
  if (args.command === "render") {
    const supported = new Set(["--input", "--out"]);
    const unsupported = [...args.provided].filter((option) => !supported.has(option));
    if (unsupported.length) throw new Error(`render does not accept ${unsupported.join(", ")}`);
    if (!args.input || !args.out) {
      throw new Error("render requires --input <report-or-dir> and --out <dir>");
    }
  }
  if (args.command === "scan-repo") {
    const supported = new Set([
      "--app-id",
      "--config",
      "--exclude",
      "--format",
      "--ignore-file",
      "--no-ignore-file",
      "--include",
      "--include-tests",
      "--jsdoc",
      "--out",
      "--ref",
      "--repo",
      "--spec",
    ]);
    const unsupported = [...args.provided].filter((option) => !supported.has(option));
    if (unsupported.length) throw new Error(`scan-repo does not accept ${unsupported.join(", ")}`);
    if (!args.repo) throw new Error("scan-repo requires --repo <url|owner/repo|path>");
    if (args.provided.has("--format") && args.format !== "json") {
      throw new Error("scan-repo supports only --format json");
    }
  }
  if (args.command === "scan-org") {
    const supported = new Set([
      "--concurrency",
      "--config",
      "--exclude",
      "--fail-on",
      "--format",
      "--ignore-file",
      "--no-ignore-file",
      "--include",
      "--include-archived",
      "--include-forks",
      "--include-tests",
      "--max-repos",
      "--org",
      "--out",
      "--progress",
      "--no-progress",
      "--resume",
    ]);
    const unsupported = [...args.provided].filter((option) => !supported.has(option));
    if (unsupported.length) throw new Error(`scan-org does not accept ${unsupported.join(", ")}`);
    if (!args.org) throw new Error("scan-org requires --org <name>");
    if (args.resume && !args.out) throw new Error("scan-org --resume requires --out <dir>");
    for (const [option, value, maximum] of [
      ["--max-repos", args.maxRepos, 10_000],
      ["--concurrency", args.concurrency, 8],
    ]) {
      if (
        value !== undefined &&
        (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum)
      ) {
        throw new Error(`${option} must be an integer from 1 to ${maximum}`);
      }
    }
    if (args.provided.has("--format") && args.format !== "json") {
      throw new Error("scan-org supports only --format json");
    }
  }
  if (
    args.failOn &&
    args.command !== "audit" &&
    args.command !== "docs" &&
    args.command !== "scan-org"
  ) {
    throw new Error("--fail-on is supported only by audit, docs, and scan-org");
  }
  if (args.failOn && args.command === "docs") {
    const statuses = args.failOn.split(",").map((status) => status.trim());
    const invalid = statuses.find((status) => !DOC_STATUSES.has(status));
    if (invalid !== undefined) {
      throw new Error(`--fail-on: unknown or empty docs status "${invalid}"`);
    }
  }
  if (args.failOn && args.command === "audit") {
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
  if (args.failOn && args.command === "scan-org" && args.failOn !== "incomplete") {
    throw new Error('scan-org --fail-on supports only "incomplete"');
  }
  if ((args.mode === "runtime" || args.mode === "hybrid") && !args.app) {
    throw new Error("runtime/hybrid mode requires --app");
  }
  if (args.mode === "static" && args.app) {
    throw new Error("--app is supported only in runtime or hybrid mode");
  }
  if (args.app === "auto" && !args.allowExec) {
    throw new Error("--app auto requires --allow-exec because it executes trusted local code");
  }
  if (args.allowExec && args.app !== "auto") {
    throw new Error("--allow-exec is only valid with --app auto");
  }
}

function die(message, code) {
  process.stderr.write(`${message}\n`);
  process.exit(code || 1);
}

function safeOrganizationProgressError(err, environment) {
  let message = err instanceof Error ? err.message : String(err);
  for (const token of [environment.GH_TOKEN, environment.GITHUB_TOKEN].filter(Boolean)) {
    for (const secret of [token, Buffer.from(`x-access-token:${token}`).toString("base64")]) {
      message = message.split(secret).join("[REDACTED]");
    }
  }
  return message.slice(0, 2_000);
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
  const scan = config.scan || {};
  let appPath = args.app;
  let runtimeApplicationId = args.appId;
  if (needsApp && appPath === "auto") {
    const root = resolvePath(args.src || process.cwd());
    const result = discover(root, discoveryOptions(args, config));
    const entries = [
      ...new Set(
        result.applications.map((application) => application.recommendedEntry).filter(Boolean),
      ),
    ];
    if (result.applications.length !== 1 || entries.length !== 1) {
      throw new Error(
        `--app auto requires exactly one detected application and one high-confidence entry; ` +
          `found ${result.applications.length} application(s) and ${entries.length} entry candidate(s): ` +
          `${entries.join(", ") || "none"}`,
      );
    }
    if (args.appId && args.appId !== result.applications[0].id) {
      throw new Error(
        `--app-id ${JSON.stringify(args.appId)} does not match the application selected by --app auto (${result.applications[0].id})`,
      );
    }
    appPath = path.resolve(root, entries[0]);
    runtimeApplicationId = result.applications[0].id;
  }
  const runtimeEntry = needsApp ? resolvePath(appPath) : null;
  const runtimeRegistry = needsApp ? await loadRuntime(runtimeEntry, config.boot || {}) : null;
  return {
    opts: {
      mode: args.mode,
      src: resolvePath(args.src || process.cwd()),
      runtimeRegistry: runtimeRegistry || undefined,
      runtimeEntry: runtimeEntry || undefined,
      applicationId: runtimeApplicationId || undefined,
      includeTests: args.includeTests,
      include: [...(scan.include || []), ...(args.include || [])],
      exclude: [...(scan.exclude || []), ...(args.exclude || [])],
      ignoreFile: args.ignoreFile === undefined ? scan.ignoreFile : args.ignoreFile,
      maxFiles: scan.maxFiles,
      maxFileBytes: scan.maxFileBytes,
      maxTotalBytes: scan.maxTotalBytes,
      timeoutMs: scan.timeoutMs,
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

function runRender(args) {
  const result = renderHtmlSite(resolvePath(args.input), resolvePath(args.out));
  process.stdout.write(
    JSON.stringify(
      {
        kind: "html-render-result",
        sourceKind: result.source.kind,
        output: result.output,
        pages: result.pages.length,
        warnings: result.warnings.length,
      },
      null,
      2,
    ) + "\n",
  );
  return 0;
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
    buildReport(registry, {
      command,
      mode: args.mode,
      target,
      sourceRoot: opts.src,
      config,
    }),
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

function discoveryOptions(args, config) {
  const scan = config.scan || {};
  return {
    includeTests: args.includeTests,
    include: [...(scan.include || []), ...(args.include || [])],
    exclude: [...(scan.exclude || []), ...(args.exclude || [])],
    ignoreFile: args.ignoreFile === undefined ? scan.ignoreFile : args.ignoreFile,
    maxFiles: scan.maxFiles,
    maxFileBytes: scan.maxFileBytes,
    maxTotalBytes: scan.maxTotalBytes,
    timeoutMs: scan.timeoutMs,
  };
}

async function runDiscover(args) {
  const config = loadConfig(args.config);
  const result = discover(resolvePath(args.src || process.cwd()), discoveryOptions(args, config));
  const text = JSON.stringify(result, null, 2);
  const outDir = args.out ? resolvePath(args.out) : null;
  emit(text, "json", outDir, "discovery.json");
  return 0;
}

async function runDocs(args) {
  const root = resolvePath(args.src || process.cwd());
  const config = loadConfig(args.config);
  const scan = discoveryOptions(args, config);
  const command = Object.keys(config.openapi?.securityByTag || {}).length ? "audit" : "inventory";
  const registry =
    command === "audit"
      ? audit({ mode: "static", src: root, ...scan }, config)
      : inventory({ mode: "static", src: root, ...scan });
  const report = buildReport(registry, {
    command,
    mode: "static",
    target: loadPackageInfo(root),
    sourceRoot: root,
    config,
  });
  const result = reconcileDocumentation(report, {
    root,
    scan,
    applicationId: args.appId,
    spec: args.spec,
    jsdoc: args.jsdoc,
  });
  const documentText = JSON.stringify(result.document, null, 2);
  if (args.out) {
    const outDir = resolvePath(args.out);
    emit(documentText, "openapi", outDir, "openapi.json");
    emit(JSON.stringify(result.report, null, 2), "json", outDir, "docs-report.json");
  } else {
    process.stdout.write(documentText + "\n");
  }
  if (!args.failOn) return 0;
  const statuses = new Set(args.failOn.split(",").map((status) => status.trim()));
  const summary = result.report.summary;
  let hits = 0;
  if (statuses.has("docs-drift")) hits += summary.codeOnlyOperations + summary.docsOnlyOperations;
  if (statuses.has("docs-conflict")) hits += summary.conflicts;
  if (statuses.has("docs-incomplete")) {
    hits += summary.dynamicOperations + summary.duplicateOperations;
    if (summary.incompleteInventory) hits++;
    if (summary.incompleteDocumentationDiscovery) hits++;
  }
  if (hits) {
    process.stderr.write(`express-recon: ${hits} result(s) matched --fail-on ${args.failOn}\n`);
    return 2;
  }
  return 0;
}

async function runMiddlewareReview(args) {
  const config = loadConfig(args.config);
  const { opts } = await harnessOpts(args, config);
  const registry = inventory(opts);
  const report = buildReport(registry, {
    command: "inventory",
    mode: args.mode,
    target: loadPackageInfo(opts.src),
    sourceRoot: opts.src,
    config,
  });
  const result = createMiddlewareReview(report, {
    root: opts.src,
    scan: discoveryOptions(args, config),
  });
  const outDir = args.out ? resolvePath(args.out) : null;
  emit(JSON.stringify(result, null, 2), "json", outDir, "middleware-review.json");
  return 0;
}

async function runImportReview(args) {
  const bundle = loadReviewFile(resolvePath(args.review));
  const assessment = loadReviewFile(resolvePath(args.assessment));
  const result = applyMiddlewareAssessments(bundle, assessment);
  const outDir = args.out ? resolvePath(args.out) : null;
  emit(JSON.stringify(result, null, 2), "json", outDir, "middleware-suggestions.json");
  return 0;
}

async function runScanRepository(args) {
  const config = loadConfig(args.config);
  const result = scanRepository(args.repo, {
    ref: args.ref,
    config,
    scan: discoveryOptions(args, config),
    applicationId: args.appId,
    spec: args.spec,
    jsdoc: args.jsdoc,
  });
  const outDir = args.out ? resolvePath(args.out) : null;
  emit(JSON.stringify(result, null, 2), "json", outDir, "repo-scan.json");
  if (outDir) {
    emit(JSON.stringify(result.discovery, null, 2), "json", outDir, "discovery.json");
    emit(JSON.stringify(result.inventory, null, 2), "json", outDir, "routes.json");
    if (result.documentation.status === "merged") {
      emit(
        JSON.stringify(result.documentation.document, null, 2),
        "openapi",
        outDir,
        "openapi.json",
      );
      emit(
        JSON.stringify(result.documentation.report, null, 2),
        "json",
        outDir,
        "docs-report.json",
      );
    }
  }
  return 0;
}

function organizationArtifactName(repository) {
  return repository.name.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function writeRepositoryArtifacts(outDir, repository, scan) {
  const relativeDir = path.posix.join("repositories", organizationArtifactName(repository));
  const repoDir = path.join(outDir, ...relativeDir.split("/"));
  emit(JSON.stringify(scan, null, 2), "json", repoDir, "repo-scan.json");
  emit(JSON.stringify(scan.discovery, null, 2), "json", repoDir, "discovery.json");
  emit(JSON.stringify(scan.inventory, null, 2), "json", repoDir, "routes.json");
  const artifacts = {
    repositoryScan: `${relativeDir}/repo-scan.json`,
    discovery: `${relativeDir}/discovery.json`,
    routes: `${relativeDir}/routes.json`,
  };
  if (scan.documentation.status === "merged") {
    emit(JSON.stringify(scan.documentation.document, null, 2), "openapi", repoDir, "openapi.json");
    emit(JSON.stringify(scan.documentation.report, null, 2), "json", repoDir, "docs-report.json");
    artifacts.openapi = `${relativeDir}/openapi.json`;
    artifacts.documentationReport = `${relativeDir}/docs-report.json`;
  }
  return artifacts;
}

async function executeScanOrganization(args, dependencies, reporter) {
  const config = loadConfig(args.config);
  const outDir = args.out ? resolvePath(args.out) : null;
  const environment = dependencies.environment || process.env;
  const token = environment.GH_TOKEN || environment.GITHUB_TOKEN || undefined;
  const scan = dependencies.scanOrganization || scanOrganization;
  const scanOptions = discoveryOptions(args, config);
  const maxRepositories =
    args.maxRepos === undefined ? DEFAULT_MAX_REPOSITORIES : Number(args.maxRepos);
  const identity = organizationCheckpointIdentity(args.org, {
    config,
    scan: scanOptions,
    maxRepositories,
    includeArchived: args.includeArchived,
    includeForks: args.includeForks,
  });
  const checkpointFile = outDir ? checkpointPath(outDir) : null;
  let checkpoint = outDir ? initialCheckpoint(args.org, identity) : null;
  let resumeEntries = [];
  const resumeDiagnostics = [];
  const progressRepositories = new Set();
  let lastProgress = {};
  let finishedProgress = false;
  const reportProgress = (event) => {
    lastProgress = event;
    if (event.event === "repository-failed" && event.repository) {
      progressRepositories.add(event.repository.toLowerCase());
    }
    if (event.event === "scan-finished") finishedProgress = true;
    reporter.emit(event);
  };
  if (args.resume) {
    const loaded = loadCheckpoint(checkpointFile, args.org, identity, outDir);
    checkpoint = loaded.checkpoint;
    resumeEntries = loaded.entries;
    resumeDiagnostics.push(...loaded.diagnostics);
  } else if (checkpointFile) {
    atomicWriteJson(checkpointFile, checkpoint);
  }
  for (const diagnostic of resumeDiagnostics) {
    if (reporter.mode === "none") {
      (dependencies.stderr || process.stderr).write(
        `express-recon [warn]: resume: ${diagnostic}\n`,
      );
    } else {
      reportProgress({
        event: "resume-warning",
        organization: args.org,
        message: diagnostic,
      });
    }
  }
  const result = await scan(args.org, {
    token,
    config,
    scan: scanOptions,
    maxRepositories,
    concurrency: args.concurrency === undefined ? undefined : Number(args.concurrency),
    includeArchived: args.includeArchived,
    includeForks: args.includeForks,
    resumeEntries,
    retainScans: !outDir,
    onProgress: reportProgress,
    onRepository: outDir
      ? (payload) => {
          const artifacts = writeRepositoryArtifacts(outDir, payload.repository, payload.scan);
          const completed = checkpointEntry(payload, artifacts, outDir);
          if (completed) {
            const next = withCompleted(checkpoint, completed);
            atomicWriteJson(checkpointFile, next);
            checkpoint = next;
            reportProgress({
              event: "checkpoint-written",
              organization: args.org,
              repository: payload.repository.fullName,
              completedRepositories: checkpoint.completed.length,
              total: lastProgress.total,
            });
          }
          return artifacts;
        }
      : undefined,
  });
  result.resume = {
    requested: args.resume === true,
    repositoriesReused: result.summary?.repositoriesResumed || 0,
    checkpoint: result.coverage.complete || !outDir ? null : CHECKPOINT_FILENAME,
  };
  for (const entry of result.repositories) {
    if (
      entry.status === "failed" &&
      !progressRepositories.has(entry.repository.fullName.toLowerCase())
    ) {
      if (reporter.mode === "none") {
        (dependencies.stderr || process.stderr).write(
          `express-recon [warn]: ${entry.repository.fullName}: ${entry.error}\n`,
        );
      } else {
        reportProgress({
          event: "repository-failed",
          organization: args.org,
          repository: entry.repository.fullName,
          error: entry.error,
        });
      }
    }
  }
  if (!finishedProgress) {
    const selectedResults = result.repositories.filter(
      (entry) => !String(entry.status).startsWith("skipped-") && entry.status !== "empty",
    );
    reportProgress({
      event: "scan-finished",
      organization: args.org,
      complete: result.coverage.complete,
      completed: selectedResults.length,
      processed: selectedResults.length,
      total: selectedResults.length,
      failed: result.summary?.failedRepositories || 0,
      expressRepositories: result.summary?.expressRepositories || 0,
      failedRepositories: result.summary?.failedRepositories || 0,
      inconclusiveRepositories: result.summary?.inconclusiveRepositories || 0,
      repositoriesResumed: result.summary?.repositoriesResumed || 0,
    });
  }
  emit(JSON.stringify(result, null, 2), "json", outDir, "organization-inventory.json");
  if (result.coverage.complete && checkpointFile) fs.rmSync(checkpointFile, { force: true });
  if (args.failOn === "incomplete" && !result.coverage.complete) {
    const message = "organization inventory is incomplete";
    if (reporter.mode === "none") {
      (dependencies.stderr || process.stderr).write(`express-recon: ${message}\n`);
    } else {
      reportProgress({
        event: "gate-triggered",
        organization: args.org,
        gate: "incomplete",
        message,
      });
    }
    return 2;
  }
  return 0;
}

async function runScanOrganization(args, dependencies = {}) {
  const environment = dependencies.environment || process.env;
  const executionContext = resolveExecutionContext(environment);
  if (executionContext === "agent" && !args.out) {
    throw new Error(
      "EXPRESS_RECON_CONTEXT=agent requires scan-org --out <dir> to keep detailed reports out of model context",
    );
  }
  const reporter =
    dependencies.progressReporter ||
    createOrganizationProgressReporter({
      mode: resolveOrganizationProgressMode(args, executionContext),
      stream: dependencies.progressStream || process.stderr,
      isTTY: dependencies.progressIsTTY,
      now: dependencies.progressNow,
    });
  try {
    return await executeScanOrganization(args, dependencies, reporter);
  } catch (value) {
    const err = value instanceof Error ? value : new Error(String(value));
    if (reporter.mode === "json") {
      const reported = reporter.emit({
        event: "scan-failed",
        organization: args.org,
        error: safeOrganizationProgressError(err, dependencies.environment || process.env),
      });
      if (reported) JSON_PROGRESS_ERRORS.add(err);
    }
    throw err;
  } finally {
    reporter.close?.();
  }
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
  if (args.command === "discover") return runDiscover(args);
  if (args.command === "docs") return runDocs(args);
  if (args.command === "review-middleware") return runMiddlewareReview(args);
  if (args.command === "import-review") return runImportReview(args);
  if (args.command === "render") return runRender(args);
  if (args.command === "scan-org") return runScanOrganization(args);
  if (args.command === "scan-repo") return runScanRepository(args);
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
if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      if (JSON_PROGRESS_ERRORS.has(err)) process.exitCode = 1;
      else die(err.message);
    },
  );
}

module.exports = {
  main,
  resolveExecutionContext,
  resolveOrganizationProgressMode,
  runScanOrganization,
  writeRepositoryArtifacts,
};
