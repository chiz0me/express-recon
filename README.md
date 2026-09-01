<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/lockup-dark.svg">
    <img src="assets/logo/lockup-light.svg" alt="express-recon" width="300">
  </picture>
</p>

# express-recon

Offline-first route inventory, authentication audit, and OpenAPI reconciliation
for Express, Fastify, and NestJS. It parses JavaScript and TypeScript without
booting the target app, and gives developers, CI jobs, and AI agents the same
versioned evidence contract. Express additionally supports trusted runtime and
hybrid observation; Fastify and NestJS are static-first.

> `public` means “no authentication middleware recognized by the supplied
> configuration.” It does not prove that a route is internet-reachable.
> `proven` is also configuration-relative: it means a known guard is present,
> not that the guard's implementation is correct.

## Start here

Requirements: Node.js `^20.19.0` or `>=22.12.0`.

Install it in the target repository so CI and teammates use the locked version:

```bash
npm install --save-dev express-recon
npx --no-install express-recon --help
```

The package installs two binaries: `express-recon` for CLI workflows and
`express-recon-mcp` for the static local MCP server.

Local `discover`, static `inventory`/`audit`, `docs`, and middleware review do
not use the network, install target dependencies, or import target code. Package
installation is the only network step in this local workflow.

## Five-minute offline workflow

### 1. Discover the repository

```bash
npx --no-install express-recon discover --src . --out .express-recon
```

Inspect `.express-recon/discovery.json` for package roots, direct framework
dependency scopes and signal strength, distinct applications, stable application
IDs, likely entries, existing OpenAPI documents, swagger-jsdoc sources, and
`discoveryCoverage`. A dependency is evidence that a framework is present; it
is not by itself proof that the package owns a runnable application.

### 2. Build a judgment-free route inventory

```bash
npx --no-install express-recon inventory --src . --format json,md --out .express-recon
```

This writes `routes.json` and `routes.md`. Check `scanCoverage.complete`, its
`scope.fingerprint`, and diagnostics before treating the inventory as complete.
Routes with `pathConfidence: "partial"` are retained evidence, not fully
resolved paths.

Add a root-relative `.express-reconignore` to exclude generated, vendored, or
out-of-scope packages, source, and API documents. It supports `*`, `**`, `?`,
comments, and later `!pattern` re-inclusion rules. Use `--no-ignore-file` for an
explicit ignore-file-free run; built-in dependency/build/hidden/test exclusions
still apply.

Hidden directories stay excluded unless `--include-hidden` (or
`scan.includeHidden: true`) is set. Use that opt-in when contracts intentionally
live under a path such as `.cursor/`; `.git`, dependencies, and generated/build
directories remain excluded. Because hidden trees can contain private tooling
or configuration, do not enable it indiscriminately in organization scans.

`.express-reconignore` controls scan inputs; it is separate from `.gitignore`.
Add the output directory (for example `.express-recon/`) to `.gitignore` unless
you intentionally review and commit a baseline. Reports may contain sensitive
route and source metadata.

### 3. Identify real authentication guards

```bash
npx --no-install express-recon suggest-auth --src . > .express-recon/auth-candidates.json
```

Suggestions are candidates, not security decisions. Verify the middleware
implementation, then create a data-only configuration such as
`recon.config.yaml`:

```yaml
authMiddleware:
  requireAuth: authenticated
  requireSession:
    tags: [session]
    roles: [member]

acceptedPublic:
  - applicationId: app:src/app.js#app
    method: GET
    path: /health
```

Use the structured `acceptedPublic` form in multi-app repositories. The legacy
`"GET /health"` form applies to every app containing that method/path.

### 4. Audit and gate the result

```bash
npx --no-install express-recon audit --src . --config recon.config.yaml \
  --format json,md --out .express-recon \
  --fail-on public,unknown,incomplete
```

Exit code `2` means the requested quality gate matched; it is an expected
policy result, not a scanner crash. Exit code `1` means invalid input or an
operational failure.

## Choose the right workflow

| Goal                                  | Command                               | Target code runs? |                  Network? | Primary evidence                      |
| ------------------------------------- | ------------------------------------- | ----------------: | ------------------------: | ------------------------------------- |
| Understand an unfamiliar repo         | `discover`                            |                No |                        No | packages, apps, entries, docs         |
| List routes without security judgment | `inventory`                           | No in static mode |                        No | route registry                        |
| Classify auth and enforce policies    | `audit`                               | No in static mode |                        No | findings and summary                  |
| Merge OpenAPI, JSDoc, and code        | `docs`                                |                No |                        No | spec plus drift report                |
| Prepare human/AI middleware review    | `review-middleware`                   | No in static mode |                        No | bounded evidence bundle               |
| Validate a review response            | `import-review`                       |                No |                        No | advisory config suggestions           |
| Scan one Git ref                      | `scan-repo`                           |                No |        Yes, for Git fetch | provenance plus static results        |
| Inventory a GitHub organization       | `scan-org`                            |                No | Yes, API plus Git fetches | per-repo reports plus aggregate index |
| Browse saved reports                  | `render`                              |                No |                        No | offline HTML site                     |
| Recover dynamic wiring                | runtime/hybrid `inventory` or `audit` |           **Yes** |    Target code may use it | runtime observations                  |

The repository is the acquisition and discovery boundary. Each detected root is
a separate application with a stable ID: `app:<file>#<binding>` for Express,
`fastify:<file>#<binding>` for Fastify, and `nestjs:<file>#<binding>` for NestJS.
Identical paths in separate apps remain separate throughout findings, baselines,
policies, and OpenAPI trace metadata.

### Framework support

| Framework | Static inventory and audit                                                                         | Lifecycle evidence                                             | Runtime / hybrid                             |
| --------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------- |
| Express   | Apps, routers, mounts, direct registrars, aliased/inline factories, middleware ordering            | `use()` and route middleware                                   | Supported for trusted local Express 4/5 code |
| Fastify   | Roots, shorthand routes, `route()`, plugins, `register()` prefixes, and direct instance registrars | Request-stage hooks and per-route hooks                        | Not yet; use `--mode static`                 |
| NestJS    | Factory roots, modules, controllers, global/router prefixes, Express/Fastify platform detection    | Middleware consumers, guards, interceptors, pipes, and filters | Not yet; use `--mode static`                 |

Dynamic Fastify plugins become opaque route-provider evidence. Dynamic NestJS
middleware scopes become `unknown` review evidence, while host routing,
versioning, prefix exclusions, and unresolved module wiring are retained as
partial-confidence diagnostics. Fastify hook registration order, encapsulation,
and `fastify-plugin` prefix transparency are modeled statically. The adapters
never import framework packages from the target repository.

Organization summaries distinguish repositories with application/adapter/route
evidence from repositories where a supported framework appears only as a direct
runtime, peer, or development dependency. Both remain discoverable, but a
dependency-only package is not presented as a runnable service.

## The evidence model

express-recon deliberately separates facts from decisions:

- `inventory` records observed routes, middleware chains, source locations, app
  identity, handler hints, and coverage. It makes no security judgment.
- `audit` applies a reviewed `authMiddleware` allowlist, accepted-public
  baseline, and optional policies to that inventory.
- `public` means no configured guard matched. `unknown` means opaque middleware
  might contain a guard and requires review. `proven` means a configured guard
  was observed.
- Express `hybrid` retains both static and runtime observations. Runtime evidence is
  authoritative only when route/app identity is unambiguous; otherwise the
  observations remain separate.
- AI review may suggest configuration, but only explicit reviewed configuration
  can change an audit classification.

Every JSON report is deterministic and versioned. Run
`npx --no-install express-recon schema` for its JSON Schema. For field-by-field details, see
the [CLI and report reference](./docs/reference.md).

## Common workflows

### Multi-app repositories

Start with discovery and select by stable ID:

```bash
npx --no-install express-recon discover --src . --out .express-recon
npx --no-install express-recon docs --src . \
  --app-id 'app:apps/public/src/app.js#app' \
  --out .express-recon/public-api
```

`docs` first matches the OpenAPI document's owning package to the detected apps
in that package. Ambiguous or cross-package merges require `--app-id`; this also
prevents a root-level or unrelated spec from being silently paired with the only
app elsewhere in a monorepo. `--app-id all` is an intentional
collision-reporting merge, not the default. For trusted hybrid scans, bind the
runtime entry to the same ID:

```bash
npx --no-install express-recon audit --mode hybrid --src . \
  --app ./apps/public/src/app.js \
  --app-id 'app:apps/public/src/app.js#app' \
  --config recon.config.yaml --format json
```

### Existing OpenAPI and swagger-jsdoc

```bash
npx --no-install express-recon docs --src . --app-id 'app:src/app.js#app' \
  --out .express-recon/docs \
  --fail-on docs-conflict,docs-incomplete
```

Precedence is deterministic: existing OpenAPI wins, JSDoc fills missing fields,
and generated inventory fills the remainder. `docs-report.json` records
code-only/docs-only operations, authored conflicts, duplicates, dynamic paths,
and incomplete discovery. Data-only JavaScript/TypeScript OpenAPI modules are
reconstructed with a bounded static interpreter; repository code is never
imported or run, external package code is never loaded, and unsupported helpers
or computation fail closed. Swagger 2 is detected but must be converted before
merging. See the
[OpenAPI guide](./docs/openapi.md).

### Advisory AI middleware classification

```bash
npx --no-install express-recon review-middleware --src . --out .express-recon/review

# Give middleware-review.json to a human or model using its embedded schema,
# then validate the exact response locally:
npx --no-install express-recon import-review \
  --review .express-recon/review/middleware-review.json \
  --assessment middleware-assessment.yaml \
  --out .express-recon/review
```

The bundle contains bounded definitions, callsites, routes, deterministic hints,
coverage, and content fingerprints. Repository excerpts are untrusted data.
`import-review` rejects stale or malformed assessments and emits advisory
suggestions; it never edits config or promotes a route to `proven`. See the
[AI agent guide](./docs/ai-agent-guide.md).

### Scan a GitHub or Git repository

```bash
npx --no-install express-recon scan-repo --repo owner/project --ref main \
  --out .express-recon/remote
```

This performs one shallow HTTPS/local Git acquisition without checkout,
submodules, symlink materialization, hooks, credentials, dependency installation,
or target execution. The combined `repo-scan.json` includes commit provenance,
acquisition completeness, discovery, inventory/audit, and documentation status.
Remote scans cannot enable runtime, hybrid, or auto-entry execution.
Set `GH_TOKEN` (preferred) or `GITHUB_TOKEN` when the GitHub repository is
private; authentication is scoped to `github.com` and is never persisted.

Git fetch is time-bounded, but a hostile server can ignore partial-clone filters;
the network packfile is not a hard byte-bounded security boundary. See
[SECURITY.md](./SECURITY.md) before scanning adversarial repositories.

### Inventory a GitHub organization

```bash
npx --no-install express-recon scan-org --org acme \
  --concurrency 2 --max-repos 500 \
  --fail-on incomplete
# Writes .express-recon/acme by default.

# After an interruption or incomplete run, use the same scan-defining options:
npx --no-install express-recon scan-org --org acme \
  --concurrency 4 --max-repos 500 \
  --fail-on incomplete --resume

# Optional machine-readable progress (JSON Lines on stderr):
npx --no-install express-recon scan-org --org acme \
  --progress json 2>scan-progress.jsonl

# Compare a fresh scan with a separate, completed prior output directory:
npx --no-install express-recon scan-org --org acme \
  --baseline .express-recon/acme-before \
  --out .express-recon/acme-current --concurrency 2 --max-repos 500 \
  --fail-on incomplete
```

`scan-org` enumerates every repository visible through the GitHub organization
API, skips forks and archived repositories by default, and runs the existing
static `scan-repo` pipeline on each eligible repository. Public organizations do
not require a token. Set `GH_TOKEN` or `GITHUB_TOKEN` to include repositories
visible to that token and to fetch private repositories; the token is never
written to reports or Git configuration.

Repository status is framework-aware: `express`, `fastify`, and `nestjs` identify
a single detected framework; `multi-framework` identifies more than one. The
legacy `not-express` status is retained for artifact compatibility and now means
that no supported framework was detected after a complete scan. An incomplete
negative remains `inconclusive`. Aggregate summaries include supported, Express,
Fastify, and NestJS repository counts.

The default concurrency is `1`, so only one bounded snapshot exists at a time.
`--concurrency 2` through `8` opts into a small worker pool. Every snapshot is
deleted in `finally` before its report is returned. Organization scans always
use durable output: omitting `--out` derives
`.express-recon/<lowercase-organization>` from the current directory. Completed
reports are written immediately under `repositories/<name>/`, while
`organization-inventory.json` retains a compact aggregate index. This avoids
holding every detailed route report in memory, streaming it through stdout, or
leaving source snapshots on disk. Pass `--out` to override the location.

Progress is enabled by default for `scan-org` and is always written to stderr,
so durable JSON artifacts remain machine-readable. Interactive
terminals get a live status line with processed/total, active repositories, and
the current phase. CI/non-TTY runs get newline-delimited enumeration-page, start, phase,
completion, failure, resume, checkpoint, and final-summary messages. Use
`--progress plain` for stable human-readable CI logs, `--progress json` for a
JSONL event stream, or `--no-progress` to suppress progress while retaining
operational errors. Progress is phase-level rather than a fabricated ETA: a
slow Git fetch remains in `acquiring` until Git returns or its timeout fires.
When an AI agent launches the scan, set `EXPRESS_RECON_CONTEXT=agent`. The CLI
then uses the same durable default output and defaults progress to `none`;
explicit output/progress flags still win. Let the agent inspect the compact
aggregate first and open only relevant per-repository artifacts. Static scanning
itself uses no model tokens; returning logs/reports to the model and optional
middleware review do. The
[AI agent guide](./docs/ai-agent-guide.md#keep-organization-scans-token-efficient)
defines the reusable token-discipline rules.

In the organization output, `organization-checkpoint.json` is replaced atomically
after every complete repository. `--resume` verifies the checkpoint fingerprint
and every recorded artifact's size and SHA-256 digest, reuses only complete
results, and retries failed, inconclusive, missing, or damaged work. The
checkpoint is kept while aggregate coverage is incomplete and removed after a
complete aggregate has been written. Concurrency may change for a resume; the organization,
checkpoint compatibility generation, repository cap, filters, config, and scan
scope must still match. Explicitly compatible releases upgrade older checkpoints
after their original fingerprint and artifact digests have been verified. During
the framework-support migration, legacy positive Express entries remain reusable,
while legacy negative entries are invalidated and rescanned so Fastify or NestJS
repositories cannot stay hidden behind an old `not-express` result.
Resume reuse is visible as `RESUME` events, and `CHECKPOINT` is emitted only
after a completed repository's artifacts and atomically replaced checkpoint are
durable.

If the selected or default output is nonempty and neither action is specified, a local interactive
terminal asks whether to resume, overwrite, or cancel; cancel is the default.
CI, agent, non-TTY, and JSON-progress runs never prompt and fail before GitHub
access or file changes with an actionable `--resume`/`--overwrite` message.
`--overwrite` starts a fresh checkpoint and replaces only colliding organization
artifacts; it does not recursively clean the directory, so unrelated files are
preserved. Use a new output directory when old and new artifacts must be kept
fully separate.

The default repository cap is 100; raise `--max-repos` deliberately for larger
organizations. Hitting the cap, an API pagination failure, a failed/incomplete
repository scan, or an inconclusive unsupported result makes aggregate coverage
incomplete. Use `--include-archived` and `--include-forks` when those repositories
belong in the inventory. “Complete” always means complete for API-visible
repositories and the selected filters—it cannot account for repositories the
token cannot see.

By default, each repository's committed `.express-reconignore` participates in
its scope. For a centrally governed security inventory, pass
`--no-ignore-file` or one absolute, trusted `--ignore-file` for every repository.
The aggregate records config/scan/scope fingerprints, while each detailed route
report records the resolved ignore-file evidence.

Resume continues the recorded commits; it is not an incremental “scan latest”
operation. Run with `--overwrite` to rebuild an existing output directory
against current default branches. Raising a repository cap likewise requires a
fresh run because it changes the inventory scope.

`--baseline <prior-output>` compares a new output directory with a separate
organization output directory. Compatible repositories are compared from their
saved `repo-scan.json` artifacts one at a time, producing
`organization-delta.json` with repository additions/removals, status and
documentation changes, exact added/removed paths, and configuration-relative
authentication regressions or improvements. Counts remain exact while retained
route details are capped at 100 per repository and 5,000 overall; the aggregate
keeps only the first 20 changed repository summaries for bounded CI and Slack
use. Added or removed repositories are reported as lifecycle changes rather than
pretending every path in them was created or deleted. Both inventories must
describe the same organization and scan scope, and incomplete or unavailable
evidence makes comparison coverage explicitly incomplete.
`--fail-on incomplete` also treats partial paths and opaque route providers as
incomplete route-graph evidence. When a baseline is requested, it gates source,
route-graph, and comparison coverage.
If the current scan is interrupted or incomplete, a bounded
`comparison-baseline/` containing only the prior aggregate and required
`repo-scan.json` files is kept beside the checkpoint. A later `--resume`
automatically reuses it even when `--baseline` is omitted, then removes it after
a complete aggregate and delta are durable.

For a scheduled organization CI job, persist the complete selected/default
output directory in a protected cache or artifact if a later run must resume it. Keep private-repo
inventories out of pull-request caches, and use a low concurrency first so the
runner's disk/network envelope is measured before increasing it.

The copy-ready [scheduled organization inventory example](./examples/github-actions/scheduled-org-inventory/README.md)
restores compatible state, selects resume versus baseline comparison safely,
streams progress, renders offline HTML, applies per-run storage and retention
bounds, and notifies Slack about inventory changes or incomplete coverage from a
separate job.

### Browse saved reports as HTML

Generate a static site from an existing output directory without rescanning:

```bash
# Zero-config from a repo with exactly one saved result in .express-recon/:
npx --no-install express-recon render

# Explicit paths remain available for scripts and custom layouts:
npx --no-install express-recon render \
  --input .express-recon/acme \
  --out .express-recon/acme-site

# Build the same change view later from two saved output folders, without a scan:
npx --no-install express-recon render \
  --baseline .express-recon/acme-before \
  --input .express-recon/acme-current \
  --out .express-recon/acme-changes-site

# Render one OpenAPI contract with the packaged Swagger UI:
npx --no-install express-recon render \
  --input .express-recon/docs/openapi.json \
  --out .express-recon/api-reference
```

With no paths, `render` looks only at the current directory, `.express-recon/`,
and its immediate child directories. Exactly one directory containing a
conventional report is required; zero or multiple matches fail with a request
for `--input`. It does not recursively search the repository. The default output
is a sibling named `<input>-html`, so `.express-recon/acme` renders to
`.express-recon/acme-html`. A direct conventional report such as
`.express-recon/acme/routes.json` uses the same parent-based output, while an
arbitrarily named file such as `payments.yaml` renders to `payments-html` beside
it. `--input` and `--out` independently override those defaults, and an existing
default output is reused only when its express-recon manifest proves which files
the renderer owns. Conventional files in the same input folder intentionally
share that default site; pass `--out` when separate simultaneous views are
required.

Within an input directory, `render` prefers `organization-inventory.json`, then
`repo-scan.json`, `routes.json`, and conventional `openapi.*`/`swagger.*` names.
An organization becomes a compact overview plus one report page per confirmed
supported-framework repository and one diagnostics page per inconclusive scan.
Every valid OpenAPI artifact belonging to a supported entry also gets a stock
Swagger UI page under `openapi/`; all such pages share one local bundle. Definite
unsupported, skipped, empty, and failed entries remain visible in the overview
without report or API pages. The renderer reads and releases selected artifacts
individually instead of combining every route or specification into one enormous
page. When `organization-delta.json` is present, the overview adds change metrics
and repository transitions, and current repository pages show the bounded exact
route changes retained for that repository.

An individual OpenAPI 3 JSON/YAML file uses a packaged, stock Swagger UI rather
than an express-recon-specific contract viewer. Its spec is embedded locally so
the site works through `file://`; no CDN is required. Request submission, query
string configuration, credential persistence, and Swagger's online validator are
disabled. The content security policy also blocks browser connections, so
external `$ref` values—relative or remote—are not resolved in the offline view.
Bundle those references into one document first when their schemas must be
visible.

The generated site contains local CSS and JavaScript only, works from `file://`,
performs no network requests, executes no target code, and makes no model calls.
Repository-controlled strings are HTML-escaped or safely serialized, referenced
artifacts cannot escape the input folder, and a restrictive content security
policy is included. `render-manifest.json` lists the generated pages, assets, and
any detailed artifacts that could not be rendered. Treat original reports and
specifications as the machine-readable contracts; HTML is a human review surface
suitable for a CI artifact or static site host.

### Pull-request gates

```bash
# Produce a baseline from the base revision.
npx --no-install express-recon audit --src ./base --config recon.config.yaml \
  --format json --out ./base-results --fail-on incomplete

# Compare the full PR inventory and gate only new findings/regressions.
npx --no-install express-recon audit --src ./current --config recon.config.yaml \
  --baseline ./base-results/routes.json \
  --format json,md --out ./current-results \
  --fail-on new,regression,incomplete
```

Use the pinned [GitHub Actions example](./examples/github-actions/express-recon-pr.yml)
for annotations, bounded job summaries, and complete report artifacts. It
intentionally installs the scanner and reads config/ignore policy from the base
revision, so a pull request cannot weaken its own gate. Protect the workflow,
lockfile, config, and ignore file with CODEOWNERS or equivalent required review.
Baseline comparison fails when two current reports carry different scan-scope
fingerprints; scan both revisions with the same policy.

To send only newly discovered method/path pairs to Slack, add the
[trusted Slack notifier example](./examples/github-actions/slack-new-routes/README.md).
It consumes `delta.addedRoutes` from the audit artifact in a separate
`workflow_run`, keeping the incoming webhook out of the pull-request job. The
guide lists exactly which files to commit, how to configure the secret, how to
preview the payload without sending it, and when a committed baseline is useful.

## Runtime and hybrid trust boundary

Static mode is the default and is appropriate for untrusted source. Runtime and
hybrid modes import the app inside a bounded child process. That process contains
crashes, `process.exit()`, leaked timers, and serialized output, but it is **not
an OS sandbox**: trusted target code retains filesystem, process, and network
permissions.

```bash
# Explicit trusted entry:
npx --no-install express-recon inventory --mode hybrid --src . --app ./src/app.js

# Conservative auto-selection; fails unless discovery finds exactly one app and
# one high-confidence entry:
npx --no-install express-recon inventory --mode hybrid --src . \
  --app auto --allow-exec
```

The worker sets `EXPRESS_RECON_DRY=1`, starts with an isolated environment, and
can stub common infrastructure clients. Native ESM dependency imports are not
intercepted by the CommonJS stubbing layer. Full boot configuration and static
resolution details are in the [reference](./docs/reference.md) and
[security model](./SECURITY.md).

## MCP server for AI agents

The stdio MCP server exposes static local tools only. It cannot acquire remote
repositories or execute target code.

```jsonc
{
  "mcpServers": {
    "express-recon": {
      "command": "npx",
      "args": ["--no-install", "express-recon-mcp"],
    },
  },
}
```

Core tools include `discover_repository`, `inventory_routes`, `audit_routes`,
`query_audit`, `finding_by_fingerprint`, `suggest_auth`, `openapi_spec`,
`reconcile_openapi`, `review_middleware`, `import_middleware_review`,
`validate_policies`, and `report_schema`.

Useful requests are precise about the evidence boundary:

> Inventory every supported app in this repository. Group results by framework
> and application ID, and report coverage and partial paths before conclusions.

> Audit routes using `requireAuth` as the only confirmed authentication guard.
> List `public` and `unknown` separately; do not call either internet-reachable.

> Reconcile the selected app's existing OpenAPI document and report code-only,
> docs-only, conflicting, duplicate, and incomplete operations.

See the [AI agent guide](./docs/ai-agent-guide.md) for tool selection and a
required evidence checklist.

The MCP server intentionally has no remote or organization-scanning tool. Run
`scan-org` explicitly in the CLI, then give an agent the generated aggregate and
per-repository reports.

## Library

```js
const {
  inventory,
  audit,
  discover,
  buildReport,
  compareOrganizationReports,
  reconcileDocumentation,
  createMiddlewareReview,
  applyMiddlewareAssessments,
  scanRepository,
  scanOrganization,
  renderHtmlSite,
  executeRuntime,
  formatters,
} = require("express-recon");

const source = inventory({ mode: "static", src: "." });
const report = buildReport(source, {
  command: "inventory",
  mode: "static",
  sourceRoot: ".",
});

console.log(formatters.markdown.format(report));

async function observeOrganization() {
  return scanOrganization("acme", {
    concurrency: 2,
    onProgress(event) {
      process.stderr.write(`${JSON.stringify(event)}\n`);
    },
  });
}

renderHtmlSite(".express-recon/acme", ".express-recon/acme-site");
```

Static library inventory supports Express, Fastify, and NestJS repositories.
Passing an already loaded Express app to `inventory()`/`audit()` executes it in
the caller's process; runtime and hybrid modes are Express-only. Prefer
`executeRuntime()` when a bounded worker result is needed. The
[library reference](./docs/reference.md#library-api) describes the
shared behavior; the [complete API reference](./docs/api.md) documents every
public export.

## Documentation

- [CLI, configuration, report, policies, modes, and library reference](./docs/reference.md)
- [Complete library API](./docs/api.md)
- [AI agent and middleware-review guide](./docs/ai-agent-guide.md)
- [OpenAPI/JSDoc reconciliation guide](./docs/openapi.md)
- [CI/CD examples](./examples/README.md)
- Bundled AI skills: [`express-recon-audit`](./skills/express-recon-audit/SKILL.md)
  and [`openapi-doc`](./skills/openapi-doc/SKILL.md)
- [Security and execution trust model](./SECURITY.md)
- [Contributing and local development](./CONTRIBUTING.md)
- [Release process](./RELEASING.md)

`npm run docs:coverage` derives the supported CLI, configuration, library, and
example surfaces from the repository and requires 100% documentation and public
API JSDoc coverage.

## Known boundaries

- Static analysis cannot fully recover data-driven route registration, arbitrary
  dependency injection, computed mounts, or every TypeScript resolution pattern.
  It retains partial evidence and diagnostics instead of silently dropping it.
- Documentation-only operations are split into verified and unverified drift
  when unresolved route graphs or opaque route providers prevent a sound stale-
  documentation conclusion.
- Auth classification is only as sound as the reviewed middleware allowlist.
- OpenAPI request/response schemas are placeholders until grounded in handler or
  validator code. The bundled `openapi-doc` skill provides that AI-assisted pass.
- `scan-repo` is non-executing, but Git protocol parsing and network transfer
  still process untrusted remote data.
- Organization scans are API-visible rather than proof of every repository that
  exists; token permissions define visibility.
- Runtime/hybrid mode is Express-only and for trusted local code only.

MIT licensed. Security issues should be reported privately as described in
[SECURITY.md](./SECURITY.md).
