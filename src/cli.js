#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const pkg = require("../package.json");
const {
  inventory,
  audit,
  suggestAuth,
  buildReport,
  REPORT_SCHEMA,
  formatters,
  compareReports,
  compareOrganizationReports,
  discover,
  reconcileDocumentation,
  createMiddlewareReview,
  applyMiddlewareAssessments,
  scanRepository,
  scanOrganization,
  renderHtmlSite,
  buildNotificationEvents,
  deliverWebhook,
} = require("./index");
const { executeRuntime } = require("./runtime/execute");
const { loadPackageInfo } = require("./static/resolve");
const { loadConfig } = require("./config");
const { loadReviewFile } = require("./review");
const { defaultRenderOutput, detectRenderInput } = require("./html");
const { DEFAULT_MAX_REPOSITORIES, validateOrganization } = require("./organization");
const { COMPLETE_REPOSITORY_STATUSES } = require("./frameworks");
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
const {
  assertComparableOrganizations,
  loadOrganizationSnapshot,
  referencedRepositoryScan,
  snapshotFromReport,
} = require("./organization-compare");

const ORGANIZATION_DELTA_FILENAME = "organization-delta.json";
const ORGANIZATION_BASELINE_DIRECTORY = "comparison-baseline";
const MAX_ORGANIZATION_DELTA_BYTES = 32 * 1024 * 1024;
const MAX_ORGANIZATION_BASELINE_BYTES = 256 * 1024 * 1024;
const MAX_NOTIFICATION_REPORT_BYTES = 32 * 1024 * 1024;
const DEFAULT_WEBHOOK_URL_ENV = "EXPRESS_RECON_WEBHOOK_URL";
const DEFAULT_WEBHOOK_SECRET_ENV = "EXPRESS_RECON_WEBHOOK_SECRET";
const DEFAULT_WEBHOOK_PREVIOUS_SECRET_ENV = "EXPRESS_RECON_WEBHOOK_PREVIOUS_SECRET";

const USAGE = `
express-recon — offline HTTP route inventory and auth audit

Usage: express-recon <command> [options]

Quick start (offline; target code is not executed):
  express-recon discover --src . --out .express-recon
  express-recon inventory --src . --format json,md --out .express-recon
  express-recon suggest-auth --src .
  express-recon audit --src . --config recon.config.yaml --format json,md --out .express-recon

Commands:
  discover      Find Express, Fastify, and NestJS apps, entry candidates, and API docs
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
                scan them statically, and build a framework-aware HTTP inventory.
  render        Generate a browsable offline HTML site from an existing report,
                OpenAPI 3 or Swagger 2 JSON/YAML file, or output directory.
                Does not rescan.
  notify        Build bounded change events from routes.json or an organization
                inventory/delta and optionally deliver signed HTTPS webhooks.
  schema        Print the JSON Schema of the report contract and exit.
  help          Print this help text and exit.

Options:
  --mode static|runtime|hybrid   default: static
                        static supports Express, Fastify, and NestJS;
                        runtime/hybrid currently support Express only.
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
  --input <path>        OpenAPI 3 JSON/YAML or Swagger 2, routes.json, repo-scan.json,
                        organization-inventory.json, or a directory containing a
                        conventional filename for one of them (render); notify
                        accepts a routes or organization JSON report and requires it.
                        Optional when exactly one input is discoverable for render
                        in the current directory or an immediate .express-recon child.
  --repo <url|owner/repo|path>
                        repository for scan-repo (HTTPS/GitHub shorthand/local).
  --org <name>          GitHub organization for scan-org. GH_TOKEN or GITHUB_TOKEN
                        adds repositories visible to that token and private fetches.
  --ref <git-ref>       branch, tag, or commit to fetch (default: remote HEAD).
  --max-repos <n>       scan-org repository cap (default 100; maximum 10000).
  --concurrency <n>     scan-org snapshots processed at once (default 1; maximum 8).
  --resume              resume a scan-org run from the checkpoint in its output.
  --overwrite           start a fresh scan-org run in a nonempty output directory;
                        replace colliding organization artifacts, keep other files.
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
  --out <dir>           override the command's artifact directory (else stdout
                        for commands without a documented default).
                        render defaults to a sibling <input>-html directory;
                        scan-org defaults to .express-recon/<lowercase-org>.
  --baseline <path>     inventory/audit: compare with a prior routes.json report.
                        scan-org: compare with a prior organization output folder
                        and emit bounded repository/route change evidence.
                        render: build those change views from two saved folders.
  --fail-on <statuses>  audit: exit 2 if any route matches, e.g. public or
                        public,unknown, policy / policy:<id>, new, regression,
                        or incomplete (static/hybrid source or route-graph
                        evidence is unresolved;
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
  --include-hidden      also scan hidden directories such as .cursor (default: exclude;
                        .git and generated/vendor directories remain excluded)
  --provider webhook    notify delivery provider (default and currently only: webhook).
  --events <list>       notify on routes.added, routes.removed, auth.regressed,
                        and/or scan.incomplete (default: added, regressed, incomplete).
  --url-env <name>      environment variable containing the webhook URL
                        (default: EXPRESS_RECON_WEBHOOK_URL; never accepts the value).
  --secret-env <name>   environment variable containing the current signing secret
                        (default: EXPRESS_RECON_WEBHOOK_SECRET).
  --previous-secret-env <name>
                        optional previous signing-secret environment variable for rotation.
  --allow-host <host>   exact non-local webhook hostname allowlist (repeatable; required
                        when an event is delivered, not for dry-run or an empty delta).
  --max-items <n>       maximum event detail objects (default 20; maximum 100).
  --timeout-ms <n>      webhook request timeout (default 10000; 1000 to 30000).
  --attempts <n>        webhook delivery attempts (default 3; maximum 3).
  --include-source      include safe repository-relative source locations in events.
  --dry-run             print unsigned notification events without network or secrets.
  --version, -V         print the installed express-recon version and exit
  --help, -h            show this message

Environment:
  EXPRESS_RECON_CONTEXT=agent
                        scan-org uses its default output and progress mode none.
                        Existing output requires explicit --resume or --overwrite.
                        Explicit --progress/--no-progress always takes precedence.
  EXPRESS_RECON_CONTEXT=ci
                        scan-org defaults to stable plain progress and never prompts.
  EXPRESS_RECON_CONTEXT=interactive
                        scan-org retains automatic TTY/non-TTY progress selection.
  EXPRESS_RECON_WEBHOOK_URL / EXPRESS_RECON_WEBHOOK_SECRET
                        default notify endpoint and HMAC-SHA256 signing secret variables.
  EXPRESS_RECON_WEBHOOK_PREVIOUS_SECRET
                        optional previous signing secret used automatically for rotation.
  EXPRESS_RECON_REPOSITORY / EXPRESS_RECON_REVISION / EXPRESS_RECON_REF /
  EXPRESS_RECON_RUN_ID / EXPRESS_RECON_RUN_URL / EXPRESS_RECON_PULL_REQUEST
                        optional provider-neutral notify context; overrides GitHub values.
  GITHUB_REPOSITORY / GITHUB_SHA / GITHUB_REF_NAME / GITHUB_RUN_ID / GITHUB_SERVER_URL
                        notify adds available GitHub Actions context to bounded event metadata.

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
  "notify",
  "review-middleware",
  "render",
  "scan-org",
  "scan-repo",
  "schema",
  "suggest-auth",
]);
const MODES = new Set(["static", "runtime", "hybrid"]);
const FORMATS = new Set(["json", "md", "pretty", "openapi"]);
const REPEATABLE_OPTIONS = new Set(["--allow-host", "--exclude", "--include", "--jsdoc"]);
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
  if (argv[0] === "--version" || argv[0] === "-V") return { version: true };
  const out = {
    command: argv[0],
    mode: "static",
    format: "pretty",
    progress: "auto",
    provider: "webhook",
  };
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
    else if (arg === "--provider") out.provider = takeValue(arg, i++);
    else if (arg === "--events") out.events = takeValue(arg, i++);
    else if (arg === "--url-env") out.urlEnv = takeValue(arg, i++);
    else if (arg === "--secret-env") out.secretEnv = takeValue(arg, i++);
    else if (arg === "--previous-secret-env") out.previousSecretEnv = takeValue(arg, i++);
    else if (arg === "--allow-host") (out.allowHost ||= []).push(takeValue(arg, i++));
    else if (arg === "--max-items") out.maxItems = takeValue(arg, i++);
    else if (arg === "--timeout-ms") out.timeoutMs = takeValue(arg, i++);
    else if (arg === "--attempts") out.attempts = takeValue(arg, i++);
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
    } else if (arg === "--include-hidden") {
      if (provided.has(arg)) throw new Error(`${arg} may only be specified once`);
      provided.add(arg);
      out.includeHidden = true;
    } else if (arg === "--include-source") {
      if (provided.has(arg)) throw new Error(`${arg} may only be specified once`);
      provided.add(arg);
      out.includeSource = true;
    } else if (arg === "--dry-run") {
      if (provided.has(arg)) throw new Error(`${arg} may only be specified once`);
      provided.add(arg);
      out.dryRun = true;
    } else if (arg === "--include-archived" || arg === "--include-forks") {
      if (provided.has(arg)) throw new Error(`${arg} may only be specified once`);
      provided.add(arg);
      if (arg === "--include-archived") out.includeArchived = true;
      else out.includeForks = true;
    } else if (arg === "--resume") {
      if (provided.has(arg)) throw new Error(`${arg} may only be specified once`);
      provided.add(arg);
      out.resume = true;
    } else if (arg === "--overwrite") {
      if (provided.has(arg)) throw new Error(`${arg} may only be specified once`);
      provided.add(arg);
      out.overwrite = true;
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
      "--include-hidden",
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
      "--include-hidden",
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
      "--include-hidden",
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
      "--include-hidden",
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
      "--include-hidden",
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
    const supported = new Set(["--baseline", "--input", "--out"]);
    const unsupported = [...args.provided].filter((option) => !supported.has(option));
    if (unsupported.length) throw new Error(`render does not accept ${unsupported.join(", ")}`);
  }
  if (args.command === "notify") {
    const supported = new Set([
      "--allow-host",
      "--attempts",
      "--dry-run",
      "--events",
      "--include-source",
      "--input",
      "--max-items",
      "--previous-secret-env",
      "--provider",
      "--secret-env",
      "--timeout-ms",
      "--url-env",
    ]);
    const unsupported = [...args.provided].filter((option) => !supported.has(option));
    if (unsupported.length) throw new Error(`notify does not accept ${unsupported.join(", ")}`);
    if (!args.input) throw new Error("notify requires --input <routes-or-organization.json>");
    if (args.provider !== "webhook") throw new Error('notify --provider supports only "webhook"');
    for (const [option, value, minimum, maximum] of [
      ["--max-items", args.maxItems, 1, 100],
      ["--timeout-ms", args.timeoutMs, 1_000, 30_000],
      ["--attempts", args.attempts, 1, 3],
    ]) {
      if (
        value !== undefined &&
        (!/^\d+$/.test(value) || Number(value) < minimum || Number(value) > maximum)
      ) {
        throw new Error(`${option} must be an integer from ${minimum} to ${maximum}`);
      }
    }
    for (const [option, value] of [
      ["--url-env", args.urlEnv],
      ["--secret-env", args.secretEnv],
      ["--previous-secret-env", args.previousSecretEnv],
    ]) {
      if (value !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(value)) {
        throw new Error(`${option} must name an uppercase environment variable`);
      }
    }
    const hosts = args.allowHost || [];
    if (new Set(hosts.map((host) => host.toLowerCase())).size !== hosts.length) {
      throw new Error("--allow-host must not contain duplicates");
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
      "--include-hidden",
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
      "--baseline",
      "--config",
      "--exclude",
      "--fail-on",
      "--format",
      "--ignore-file",
      "--no-ignore-file",
      "--include",
      "--include-hidden",
      "--include-archived",
      "--include-forks",
      "--include-tests",
      "--max-repos",
      "--org",
      "--out",
      "--overwrite",
      "--progress",
      "--no-progress",
      "--resume",
    ]);
    const unsupported = [...args.provided].filter((option) => !supported.has(option));
    if (unsupported.length) throw new Error(`scan-org does not accept ${unsupported.join(", ")}`);
    if (!args.org) throw new Error("scan-org requires --org <name>");
    validateOrganization(args.org);
    if (args.resume && args.overwrite) {
      throw new Error("scan-org --resume and --overwrite cannot be used together");
    }
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

/** Derive the durable organization output without trusting the org as a path. */
function defaultOrganizationOutput(organization, cwd = process.cwd()) {
  validateOrganization(organization);
  let root;
  try {
    root = fs.realpathSync(path.resolve(cwd));
  } catch (value) {
    const err = value instanceof Error ? value : new Error(String(value));
    throw new Error(`Could not resolve the scan-org working directory: ${err.message}`);
  }
  if (!fs.lstatSync(root).isDirectory()) {
    throw new Error(`scan-org working directory is not a directory: ${root}`);
  }
  const reconRoot = path.join(root, ".express-recon");
  if (fs.existsSync(reconRoot)) {
    const stat = fs.lstatSync(reconRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        "scan-org cannot use the default output through a non-directory or symbolic .express-recon entry; pass --out explicitly",
      );
    }
  }
  return path.join(reconRoot, organization.toLowerCase());
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
    if (result.applications.length !== 1) {
      throw new Error(
        `--app auto requires exactly one detected application; found ${result.applications.length}`,
      );
    }
    if ((result.applications[0].framework || "express") !== "express") {
      throw new Error(
        `--app auto found a ${result.applications[0].framework} application, but runtime/hybrid observation currently supports Express only; use --mode static`,
      );
    }
    if (entries.length !== 1) {
      throw new Error(
        `--app auto requires one high-confidence entry for the detected Express application; ` +
          `found ${entries.length}: ${entries.join(", ") || "none"}`,
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
      includeHidden: args.includeHidden ?? scan.includeHidden,
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
  const output = path.join(outDir, file);
  try {
    const stat = fs.lstatSync(output);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Output artifact must be a regular file: ${output}`);
    }
  } catch (value) {
    const err = value instanceof Error ? value : new Error(String(value));
    if (err.code !== "ENOENT") throw err;
  }
  fs.writeFileSync(output, text + "\n");
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
  const input = args.input ? resolvePath(args.input) : detectRenderInput(process.cwd());
  const output = args.out ? resolvePath(args.out) : defaultRenderOutput(input);
  const result = renderHtmlSite(input, output, {
    baseline: args.baseline ? resolvePath(args.baseline) : undefined,
  });
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

function readNotificationReport(input) {
  const file = resolvePath(input);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    throw new Error(`Could not read notification input: ${error.code || "filesystem error"}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("notification input must be a regular JSON file");
  }
  if (stat.size <= 0 || stat.size > MAX_NOTIFICATION_REPORT_BYTES) {
    throw new Error(
      `notification input must be between 1 and ${MAX_NOTIFICATION_REPORT_BYTES} bytes`,
    );
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse notification input JSON: ${error.message}`);
  }
}

function notificationContextFromEnvironment(environment) {
  const context = {
    repository: environment.EXPRESS_RECON_REPOSITORY || environment.GITHUB_REPOSITORY,
    revision: environment.EXPRESS_RECON_REVISION || environment.GITHUB_SHA,
    ref: environment.EXPRESS_RECON_REF || environment.GITHUB_REF_NAME || environment.GITHUB_REF,
    runId: environment.EXPRESS_RECON_RUN_ID || environment.GITHUB_RUN_ID,
    pullRequest: environment.EXPRESS_RECON_PULL_REQUEST,
  };
  if (environment.EXPRESS_RECON_RUN_URL) {
    context.runUrl = environment.EXPRESS_RECON_RUN_URL;
    return context;
  }
  if (environment.GITHUB_SERVER_URL && environment.GITHUB_REPOSITORY && environment.GITHUB_RUN_ID) {
    let server;
    try {
      server = new URL(environment.GITHUB_SERVER_URL);
    } catch {
      throw new Error("GITHUB_SERVER_URL must be a valid HTTPS URL for notify context");
    }
    if (server.protocol !== "https:" || server.username || server.password || server.search) {
      throw new Error("GITHUB_SERVER_URL must be an HTTPS URL without credentials or query");
    }
    const repository = String(environment.GITHUB_REPOSITORY)
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    context.runUrl = `${server.href.replace(/\/$/, "")}/${repository}/actions/runs/${encodeURIComponent(environment.GITHUB_RUN_ID)}`;
  }
  return context;
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Environment variable ${name} is not configured`);
  }
  return value;
}

async function runNotify(args, environment = process.env) {
  const report = readNotificationReport(args.input);
  const events = buildNotificationEvents(report, {
    events: args.events?.split(",").map((value) => value.trim()),
    includeSource: args.includeSource,
    maxItems: args.maxItems === undefined ? undefined : Number(args.maxItems),
    context: notificationContextFromEnvironment(environment),
  });
  const result = {
    kind: args.dryRun ? "webhook-notification-preview" : "webhook-notification-result",
    provider: args.provider,
    eventsEmitted: events.length,
  };
  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify({ ...result, events }, null, 2)}\n`);
    return 0;
  }
  if (events.length === 0) {
    process.stdout.write(`${JSON.stringify({ ...result, eventsDelivered: 0 }, null, 2)}\n`);
    return 0;
  }
  const urlEnvironment = args.urlEnv || DEFAULT_WEBHOOK_URL_ENV;
  const secretEnvironment = args.secretEnv || DEFAULT_WEBHOOK_SECRET_ENV;
  const secrets = [requiredEnvironment(environment, secretEnvironment)];
  const previousEnvironment = args.previousSecretEnv || DEFAULT_WEBHOOK_PREVIOUS_SECRET_ENV;
  if (args.previousSecretEnv) {
    secrets.push(requiredEnvironment(environment, previousEnvironment));
  } else if (environment[previousEnvironment]) {
    secrets.push(environment[previousEnvironment]);
  }
  const deliveries = [];
  for (const event of events) {
    deliveries.push(
      await deliverWebhook(event, {
        url: requiredEnvironment(environment, urlEnvironment),
        secrets,
        allowHosts: args.allowHost,
        attempts: args.attempts === undefined ? undefined : Number(args.attempts),
        timeoutMs: args.timeoutMs === undefined ? undefined : Number(args.timeoutMs),
      }),
    );
  }
  process.stdout.write(
    `${JSON.stringify({ ...result, eventsDelivered: deliveries.length, deliveries }, null, 2)}\n`,
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
    statuses.includes("incomplete") &&
    (report.scanCoverage?.complete === false || report.routeGraph?.complete === false)
      ? 1
      : 0;
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
    includeHidden: args.includeHidden ?? scan.includeHidden,
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
  const discovery = discover(root, scan);
  const result = reconcileDocumentation(report, {
    root,
    scan,
    discovery,
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
  if (statuses.has("docs-drift")) {
    hits +=
      summary.codeOnlyOperations +
      (summary.verifiedDocsOnlyOperations ?? summary.docsOnlyOperations);
  }
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

function specificationArtifactBase(specification, index, used) {
  const source = String(specification.path || `specification-${index + 1}`);
  const extension = path.posix.extname(source);
  const stem = (extension ? source.slice(0, -extension.length) : source)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  const base = stem || `specification-${index + 1}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base}-${suffix++}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function persistSpecificationArtifacts(outDir, scan, options = {}) {
  const documentation = scan.documentation || {};
  const specifications = Array.isArray(documentation.specifications)
    ? documentation.specifications
    : [];
  if (!specifications.length) return { scan, specifications: [] };
  const directory = path.join(outDir, "specifications");
  if (options.organization) ensureOrganizationOutputDirectory(directory);
  else fs.mkdirSync(directory, { recursive: true });
  const used = new Set();
  const local = [];
  const aggregate = [];
  for (const [index, specification] of specifications.entries()) {
    const { document, reconciliation, ...metadata } = specification;
    const base = specificationArtifactBase(specification, index, used);
    const localMetadata = { ...metadata };
    const aggregateMetadata = { ...metadata };
    if (document) {
      const filename = `${base}.json`;
      emit(JSON.stringify(document, null, 2), "openapi", directory, filename);
      const localReference = path.posix.join("specifications", filename);
      const aggregateReference = options.relativeDir
        ? path.posix.join(options.relativeDir, localReference)
        : localReference;
      localMetadata.status = "retained";
      localMetadata.artifact = localReference;
      aggregateMetadata.status = "retained";
      aggregateMetadata.artifact = aggregateReference;
    }
    if (reconciliation) {
      const { document: reconciledDocument, report, ...reconciliationMetadata } = reconciliation;
      localMetadata.reconciliation = { ...reconciliationMetadata };
      aggregateMetadata.reconciliation = { ...reconciliationMetadata };
      if (reconciledDocument) {
        const filename = `${base}-reconciled.json`;
        emit(JSON.stringify(reconciledDocument, null, 2), "openapi", directory, filename);
        const localReference = path.posix.join("specifications", filename);
        const aggregateReference = options.relativeDir
          ? path.posix.join(options.relativeDir, localReference)
          : localReference;
        localMetadata.reconciliation.artifact = localReference;
        aggregateMetadata.reconciliation.artifact = aggregateReference;
      }
      if (report) {
        const filename = `${base}-docs-report.json`;
        emit(JSON.stringify(report, null, 2), "json", directory, filename);
        const localReference = path.posix.join("specifications", filename);
        const aggregateReference = options.relativeDir
          ? path.posix.join(options.relativeDir, localReference)
          : localReference;
        localMetadata.reconciliation.reportArtifact = localReference;
        aggregateMetadata.reconciliation.reportArtifact = aggregateReference;
      }
    }
    local.push(localMetadata);
    aggregate.push(aggregateMetadata);
  }
  const retained = local.filter((item) => item.status === "retained").length;
  return {
    scan: {
      ...scan,
      documentation: {
        ...documentation,
        specifications: local,
        summary: { ...documentation.summary, retained },
      },
    },
    specifications: aggregate.filter((item) => item.artifact),
  };
}

function writeRepositoryScanArtifacts(outDir, scan, options = {}) {
  const persisted = persistSpecificationArtifacts(outDir, scan, options);
  emit(JSON.stringify(persisted.scan, null, 2), "json", outDir, "repo-scan.json");
  emit(JSON.stringify(scan.discovery, null, 2), "json", outDir, "discovery.json");
  emit(JSON.stringify(scan.inventory, null, 2), "json", outDir, "routes.json");
  const artifacts = options.relativeDir
    ? {
        repositoryScan: `${options.relativeDir}/repo-scan.json`,
        discovery: `${options.relativeDir}/discovery.json`,
        routes: `${options.relativeDir}/routes.json`,
      }
    : {};
  if (Array.isArray(scan.documentation.specifications)) {
    artifacts.specifications = persisted.specifications;
  }
  if (scan.documentation.status === "merged") {
    emit(JSON.stringify(scan.documentation.document, null, 2), "openapi", outDir, "openapi.json");
    emit(JSON.stringify(scan.documentation.report, null, 2), "json", outDir, "docs-report.json");
    if (options.relativeDir) {
      artifacts.openapi = `${options.relativeDir}/openapi.json`;
      artifacts.documentationReport = `${options.relativeDir}/docs-report.json`;
    }
  }
  return artifacts;
}

async function runScanRepository(args) {
  const config = loadConfig(args.config);
  const githubToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || undefined;
  const outDir = args.out ? resolvePath(args.out) : null;
  const result = scanRepository(args.repo, {
    ref: args.ref,
    config,
    scan: discoveryOptions(args, config),
    githubToken,
    applicationId: args.appId,
    spec: args.spec,
    jsdoc: args.jsdoc,
    retainSpecificationDocuments: Boolean(outDir),
  });
  if (outDir) {
    writeRepositoryScanArtifacts(outDir, result);
  } else emit(JSON.stringify(result, null, 2), "json", null, "repo-scan.json");
  return 0;
}

function organizationArtifactName(repository) {
  if (!repository || typeof repository.name !== "string") {
    throw new Error("Organization repository artifact requires a repository name");
  }
  const name = repository.name.replace(/[^A-Za-z0-9._-]+/g, "_");
  if (!name || name === "." || name === "..") {
    throw new Error(`Organization repository has an unsafe artifact name: ${repository.name}`);
  }
  return name;
}

function organizationOutputEntry(output, name, expected) {
  const entry = path.join(output, name);
  let stat;
  try {
    stat = fs.lstatSync(entry);
  } catch (value) {
    const err = value instanceof Error ? value : new Error(String(value));
    throw new Error(`Could not inspect organization output artifact ${entry}: ${err.message}`);
  }
  const valid = expected === "directory" ? stat.isDirectory() : stat.isFile();
  if (stat.isSymbolicLink() || !valid) {
    throw new Error(
      `Organization output artifact must be a regular ${expected}: ${entry}. No files were changed.`,
    );
  }
}

function ensureOrganizationOutputDirectory(directory) {
  const resolved = path.resolve(directory);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (value) {
    const err = value instanceof Error ? value : new Error(String(value));
    if (err.code !== "ENOENT") {
      throw new Error(
        `Could not inspect organization output directory ${resolved}: ${err.message}`,
      );
    }
    const parent = path.dirname(resolved);
    if (parent === resolved) {
      throw new Error(`Could not create organization output directory: ${resolved}`);
    }
    ensureOrganizationOutputDirectory(parent);
    try {
      fs.mkdirSync(resolved, { mode: 0o700 });
    } catch (mkdirValue) {
      const mkdirError = mkdirValue instanceof Error ? mkdirValue : new Error(String(mkdirValue));
      if (mkdirError.code !== "EEXIST") {
        throw new Error(
          `Could not create organization output directory ${resolved}: ${mkdirError.message}`,
        );
      }
    }
    stat = fs.lstatSync(resolved);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Organization output path must be a regular directory: ${resolved}`);
  }
}

function inspectOrganizationOutput(outDir) {
  const output = resolvePath(outDir);
  if (!fs.existsSync(output)) {
    return {
      output,
      empty: true,
      entries: 0,
      hasCheckpoint: false,
      hasInventory: false,
      hasRepositories: false,
    };
  }
  let stat;
  let entries;
  try {
    stat = fs.lstatSync(output);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Organization scan output is not a directory: ${output}`);
    }
    entries = fs.readdirSync(output);
  } catch (value) {
    const err = value instanceof Error ? value : new Error(String(value));
    if (err.message.startsWith("Organization scan output is not a directory:")) throw err;
    throw new Error(`Could not inspect organization scan output ${output}: ${err.message}`);
  }
  const names = new Set(entries);
  for (const [name, expected] of [
    [CHECKPOINT_FILENAME, "file"],
    ["organization-inventory.json", "file"],
    [ORGANIZATION_DELTA_FILENAME, "file"],
    [ORGANIZATION_BASELINE_DIRECTORY, "directory"],
    ["repositories", "directory"],
  ]) {
    if (names.has(name)) organizationOutputEntry(output, name, expected);
  }
  return {
    output,
    empty: entries.length === 0,
    entries: entries.length,
    hasCheckpoint: names.has(CHECKPOINT_FILENAME),
    hasInventory: names.has("organization-inventory.json"),
    hasRepositories: names.has("repositories"),
  };
}

function pathContains(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function validateOrganizationBaselineLocation(snapshot, outDir) {
  const output = path.resolve(outDir);
  if (snapshot.directoryInput) {
    if (pathContains(output, snapshot.input) || pathContains(snapshot.input, output)) {
      throw new Error(
        "scan-org --baseline directory and --out must be separate, non-nested directories",
      );
    }
  } else if (pathContains(output, snapshot.file)) {
    throw new Error("scan-org --baseline report must not be inside --out");
  }
}

function removeOrganizationDelta(outDir) {
  const file = path.join(outDir, ORGANIZATION_DELTA_FILENAME);
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Organization delta artifact must be a regular file: ${file}`);
  }
  fs.rmSync(file);
}

function removeOrganizationBaseline(outDir) {
  const directory = path.join(outDir, ORGANIZATION_BASELINE_DIRECTORY);
  if (!fs.existsSync(directory)) return;
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Organization comparison baseline must be a regular directory: ${directory}`);
  }
  fs.rmSync(directory, { recursive: true });
}

/**
 * Copy only report artifacts needed for a future comparison into resumable
 * scan state. Source snapshots are deliberately excluded and remain subject to
 * per-repository cleanup.
 */
function persistOrganizationBaseline(snapshot, outDir) {
  const temporary = fs.mkdtempSync(path.join(outDir, ".comparison-baseline-"));
  let bytes = 0;
  try {
    const repositories = snapshot.report.repositories.map((value) => {
      const entry = structuredClone(value);
      delete entry.scan;
      delete entry.artifacts;
      if (entry.coverageComplete === true && COMPLETE_REPOSITORY_STATUSES.has(entry.status)) {
        const scan = referencedRepositoryScan(snapshot, value);
        const artifactName = organizationArtifactName(entry.repository);
        const relative = path.posix.join("repositories", artifactName, "repo-scan.json");
        const serialized = JSON.stringify(scan, null, 2) + "\n";
        bytes += Buffer.byteLength(serialized);
        if (bytes > MAX_ORGANIZATION_BASELINE_BYTES) {
          throw new Error(
            `Organization comparison baseline exceeds the ${MAX_ORGANIZATION_BASELINE_BYTES}-byte limit`,
          );
        }
        const file = path.join(temporary, ...relative.split("/"));
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, serialized, { mode: 0o600 });
        entry.artifacts = { repositoryScan: relative };
      }
      return entry;
    });
    const report = structuredClone(snapshot.report);
    report.repositories = repositories;
    delete report.delta;
    const aggregate = JSON.stringify(report, null, 2) + "\n";
    bytes += Buffer.byteLength(aggregate);
    if (bytes > MAX_ORGANIZATION_BASELINE_BYTES) {
      throw new Error(
        `Organization comparison baseline exceeds the ${MAX_ORGANIZATION_BASELINE_BYTES}-byte limit`,
      );
    }
    fs.writeFileSync(path.join(temporary, "organization-inventory.json"), aggregate, {
      mode: 0o600,
    });
    removeOrganizationBaseline(outDir);
    fs.renameSync(temporary, path.join(outDir, ORGANIZATION_BASELINE_DIRECTORY));
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function compactOrganizationDelta(delta) {
  const repositories = delta.repositories.slice(0, 20).map((entry) => ({
    repository: entry.repository,
    change: entry.change,
    before: entry.before ? { status: entry.before.status, routes: entry.before.routes } : null,
    after: entry.after ? { status: entry.after.status, routes: entry.after.routes } : null,
    ...(entry.changes?.routes ? { routeChanges: entry.changes.routes.summary } : {}),
  }));
  return {
    kind: delta.kind,
    artifact: ORGANIZATION_DELTA_FILENAME,
    organization: delta.organization,
    baseline: delta.baseline,
    current: delta.current,
    coverage: delta.coverage,
    summary: delta.summary,
    repositories,
    repositoriesTruncated: delta.repositories.length > repositories.length,
  };
}

/**
 * Enforce the on-disk delta limit by dropping retained route examples before
 * exact counts. Counts are the automation contract; details are a bounded
 * convenience for human review.
 */
function serializedOrganizationDelta(delta) {
  let serialized = JSON.stringify(delta, null, 2);
  if (Buffer.byteLength(serialized) <= MAX_ORGANIZATION_DELTA_BYTES) return serialized;
  for (const entry of delta.repositories) {
    const routes = entry.changes?.routes;
    if (!routes?.details) continue;
    delete routes.details;
    routes.detailsRetained = 0;
    routes.detailsTruncated = true;
  }
  delta.summary.detailsRetained = 0;
  delta.summary.detailsTruncated = true;
  serialized = JSON.stringify(delta, null, 2);
  if (Buffer.byteLength(serialized) > MAX_ORGANIZATION_DELTA_BYTES) {
    throw new Error(
      `Organization delta exceeds the ${MAX_ORGANIZATION_DELTA_BYTES}-byte limit even without route details`,
    );
  }
  return serialized;
}

function organizationOutputConflictError(state) {
  const choices = state.hasCheckpoint
    ? "rerun with --resume to continue it or --overwrite to start fresh"
    : "rerun with --overwrite to start fresh";
  return new Error(
    `Organization scan output is not empty: ${JSON.stringify(state.output)}; ${choices}. ` +
      "No files were changed.",
  );
}

function normalizeOrganizationOutputChoice(value) {
  const choice = String(value ?? "")
    .trim()
    .toLowerCase();
  if (choice === "r" || choice === "resume") return "resume";
  if (choice === "o" || choice === "overwrite") return "overwrite";
  if (["", "c", "cancel", "n", "no"].includes(choice)) return "cancel";
  return null;
}

async function promptForOrganizationOutput(state, dependencies) {
  const input = dependencies.stdin || process.stdin;
  const output = dependencies.stderr || process.stderr;
  const prompt = state.hasCheckpoint
    ? "Choose [r]esume, [o]verwrite, or [c]ancel (default): "
    : "Choose [o]verwrite or [c]ancel (default): ";
  output.write(
    `express-recon: ${state.entries} existing item${state.entries === 1 ? "" : "s"} found in ` +
      `${JSON.stringify(state.output)}.\n` +
      (state.hasCheckpoint
        ? "A checkpoint is available. Resume preserves completed repository evidence.\n"
        : "No checkpoint is available, so this run cannot be resumed.\n") +
      "Overwrite starts a fresh scan, replaces colliding organization artifacts, and keeps other files.\n",
  );
  const terminal = readline.createInterface({ input, output, terminal: true });
  try {
    while (true) {
      const choice = normalizeOrganizationOutputChoice(await terminal.question(prompt));
      if (choice === "resume" && !state.hasCheckpoint) {
        output.write("Resume is unavailable because no organization checkpoint was found.\n");
      } else if (choice) {
        return choice;
      } else {
        output.write(
          state.hasCheckpoint
            ? "Enter resume, overwrite, or cancel.\n"
            : "Enter overwrite or cancel.\n",
        );
      }
    }
  } catch (value) {
    const err = value instanceof Error ? value : new Error(String(value));
    throw new Error(
      `Could not read organization output choice; no files were changed: ${err.message}`,
    );
  } finally {
    terminal.close();
  }
}

async function resolveOrganizationOutputArgs(args, dependencies, executionContext) {
  if (!args.out) return args;
  if (args.resume && args.overwrite) {
    throw new Error("scan-org --resume and --overwrite cannot be used together");
  }
  const state = inspectOrganizationOutput(args.out);
  if (args.resume) {
    if (!state.hasCheckpoint) {
      throw new Error(
        `scan-org --resume could not find ${CHECKPOINT_FILENAME} in ${JSON.stringify(state.output)}`,
      );
    }
    return args;
  }
  if (args.overwrite || state.empty) return args;

  let choice;
  if (typeof dependencies.outputConflictPrompt === "function") {
    choice = normalizeOrganizationOutputChoice(await dependencies.outputConflictPrompt(state));
    if (!choice) throw new Error("Organization output prompt returned an unsupported choice");
  } else {
    const input = dependencies.stdin || process.stdin;
    const output = dependencies.stderr || process.stderr;
    const isTTY =
      dependencies.promptIsTTY === undefined
        ? input.isTTY === true && output.isTTY === true
        : dependencies.promptIsTTY === true;
    const progressMode = resolveOrganizationProgressMode(args, executionContext);
    if (
      executionContext === "agent" ||
      executionContext === "ci" ||
      progressMode === "json" ||
      !isTTY
    ) {
      throw organizationOutputConflictError(state);
    }
    choice = await promptForOrganizationOutput(state, dependencies);
  }

  if (choice === "cancel") {
    throw new Error("Organization scan cancelled; no files were changed");
  }
  if (choice === "resume" && !state.hasCheckpoint) {
    throw new Error(`Cannot resume: ${CHECKPOINT_FILENAME} was not found in ${state.output}`);
  }
  const provided = new Set(args.provided || []);
  provided.add(choice === "resume" ? "--resume" : "--overwrite");
  return {
    ...args,
    resume: choice === "resume",
    overwrite: choice === "overwrite",
    provided,
  };
}

function writeRepositoryArtifacts(outDir, repository, scan) {
  const artifactName = organizationArtifactName(repository);
  const relativeDir = path.posix.join("repositories", artifactName);
  const repositoriesDir = path.join(outDir, "repositories");
  ensureOrganizationOutputDirectory(repositoriesDir);
  const repoDir = path.join(repositoriesDir, artifactName);
  ensureOrganizationOutputDirectory(repoDir);
  return writeRepositoryScanArtifacts(repoDir, scan, {
    organization: true,
    relativeDir,
  });
}

async function executeScanOrganization(args, dependencies, reporter) {
  const config = loadConfig(args.config);
  if (!args.out) throw new Error("scan-org output directory was not resolved");
  const outDir = resolvePath(args.out);
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
  const internalBaseline = path.join(outDir, ORGANIZATION_BASELINE_DIRECTORY);
  const baselineInput = args.baseline
    ? resolvePath(args.baseline)
    : args.resume && fs.existsSync(internalBaseline)
      ? internalBaseline
      : null;
  let baselineSnapshot = baselineInput ? loadOrganizationSnapshot(baselineInput) : null;
  const baselineIsInternal =
    baselineSnapshot && path.resolve(baselineSnapshot.input) === path.resolve(internalBaseline);
  if (baselineSnapshot) {
    if (!baselineIsInternal) validateOrganizationBaselineLocation(baselineSnapshot, outDir);
    assertComparableOrganizations(baselineSnapshot.report, {
      kind: "github-organization-inventory",
      organization: { login: args.org },
      scope: {
        fingerprint: identity.fingerprint,
        includeArchived: args.includeArchived === true,
        includeForks: args.includeForks === true,
        maxRepositories,
        configHash: identity.scope.configHash,
        scanHash: identity.scope.scanHash,
      },
      coverage: { complete: false },
      summary: {},
      repositories: [],
    });
  }
  const checkpointFile = checkpointPath(outDir);
  let checkpoint = initialCheckpoint(args.org, identity);
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
  ensureOrganizationOutputDirectory(outDir);
  removeOrganizationDelta(outDir);
  if (baselineSnapshot && !baselineIsInternal) {
    persistOrganizationBaseline(baselineSnapshot, outDir);
    baselineSnapshot = loadOrganizationSnapshot(internalBaseline);
  } else if (!baselineSnapshot && !args.resume) {
    removeOrganizationBaseline(outDir);
  }
  if (args.resume) {
    const loaded = loadCheckpoint(checkpointFile, args.org, identity, outDir);
    checkpoint = loaded.checkpoint;
    resumeEntries = loaded.entries;
    resumeDiagnostics.push(...loaded.diagnostics);
    if (loaded.migratedFromToolVersion) atomicWriteJson(checkpointFile, checkpoint);
  } else {
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
    retainScans: false,
    onProgress: reportProgress,
    onRepository: (payload) => {
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
    },
  });
  result.resume = {
    requested: args.resume === true,
    repositoriesReused: result.summary?.repositoriesResumed || 0,
    checkpoint: result.coverage.complete ? null : CHECKPOINT_FILENAME,
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
      supportedRepositories: result.summary?.supportedRepositories || 0,
      fastifyRepositories: result.summary?.fastifyRepositories || 0,
      nestjsRepositories: result.summary?.nestjsRepositories || 0,
      failedRepositories: result.summary?.failedRepositories || 0,
      inconclusiveRepositories: result.summary?.inconclusiveRepositories || 0,
      incompleteRouteGraphs: result.summary?.incompleteRouteGraphs || 0,
      repositoriesResumed: result.summary?.repositoriesResumed || 0,
    });
  }
  if (baselineSnapshot) {
    // Compute and persist the full delta before embedding its compact projection
    // in the aggregate. A consumer never sees an aggregate that advertises a
    // delta artifact which has not yet been written durably.
    const currentSnapshot = snapshotFromReport(result, outDir);
    const delta = compareOrganizationReports(baselineSnapshot.report, result, {
      loadBaselineScan: (entry) => referencedRepositoryScan(baselineSnapshot, entry),
      loadCurrentScan: (entry) => referencedRepositoryScan(currentSnapshot, entry),
    });
    const serializedDelta = serializedOrganizationDelta(delta);
    result.delta = compactOrganizationDelta(delta);
    emit(serializedDelta, "json", outDir, ORGANIZATION_DELTA_FILENAME);
  }
  emit(JSON.stringify(result, null, 2), "json", outDir, "organization-inventory.json");
  if (result.coverage.complete) {
    // The internal baseline is resume state, not historical storage. Remove it
    // only after the completed aggregate (and optional delta) is durable.
    fs.rmSync(checkpointFile, { force: true });
    removeOrganizationBaseline(outDir);
  }
  const comparisonIncomplete = result.delta?.coverage?.complete === false;
  if (args.failOn === "incomplete" && (!result.coverage.complete || comparisonIncomplete)) {
    const message = result.coverage.complete
      ? "organization baseline comparison is incomplete"
      : "organization inventory is incomplete";
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
  validateOrganization(args.org);
  const environment = dependencies.environment || process.env;
  const executionContext = resolveExecutionContext(environment);
  const outputArgs = args.out
    ? args
    : {
        ...args,
        out: defaultOrganizationOutput(args.org, dependencies.cwd || process.cwd()),
      };
  const effectiveArgs = await resolveOrganizationOutputArgs(
    outputArgs,
    dependencies,
    executionContext,
  );
  const reporter =
    dependencies.progressReporter ||
    createOrganizationProgressReporter({
      mode: resolveOrganizationProgressMode(effectiveArgs, executionContext),
      stream: dependencies.progressStream || process.stderr,
      isTTY: dependencies.progressIsTTY,
      now: dependencies.progressNow,
    });
  try {
    return await executeScanOrganization(effectiveArgs, dependencies, reporter);
  } catch (value) {
    const err = value instanceof Error ? value : new Error(String(value));
    if (reporter.mode === "json") {
      const reported = reporter.emit({
        event: "scan-failed",
        organization: effectiveArgs.org,
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
  if (args.version) {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
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
  if (args.command === "notify") return runNotify(args);
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
  defaultOrganizationOutput,
  inspectOrganizationOutput,
  main,
  normalizeOrganizationOutputChoice,
  resolveExecutionContext,
  resolveOrganizationOutputArgs,
  resolveOrganizationProgressMode,
  runScanOrganization,
  writeRepositoryArtifacts,
};
