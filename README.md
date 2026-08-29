<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/lockup-dark.svg">
    <img src="assets/logo/lockup-light.svg" alt="express-recon" width="300">
  </picture>
</p>

# express-recon

Offline-first route inventory, authentication audit, and OpenAPI reconciliation
for Express 4 and 5. It parses JavaScript and TypeScript repositories without
booting the target app, and gives developers, CI jobs, and AI agents the same
versioned evidence contract.

> `public` means “no authentication middleware recognized by the supplied
> configuration.” It does not prove that a route is internet-reachable.
> `proven` is also configuration-relative: it means a known guard is present,
> not that the guard's implementation is correct.

## Start here

Requirements: Node.js `^20.19.0` or `>=22.12.0`.

Install it in the Express repository so CI and teammates use the locked version:

```bash
npm install --save-dev express-recon
npx --no-install express-recon --help
```

Local `discover`, static `inventory`/`audit`, `docs`, and middleware review do
not use the network, install target dependencies, or import target code. Package
installation is the only network step in this local workflow.

## Five-minute offline workflow

### 1. Discover the repository

```bash
npx --no-install express-recon discover --src . --out .express-recon
```

Inspect `.express-recon/discovery.json` for package roots, distinct Express
applications, stable application IDs, likely runtime entries, existing OpenAPI
documents, swagger-jsdoc sources, and `discoveryCoverage`.

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

| Goal | Command | Target code runs? | Network? | Primary evidence |
| --- | --- | ---: | ---: | --- |
| Understand an unfamiliar repo | `discover` | No | No | packages, apps, entries, docs |
| List routes without security judgment | `inventory` | No in static mode | No | route registry |
| Classify auth and enforce policies | `audit` | No in static mode | No | findings and summary |
| Merge OpenAPI, JSDoc, and code | `docs` | No | No | spec plus drift report |
| Prepare human/AI middleware review | `review-middleware` | No in static mode | No | bounded evidence bundle |
| Validate a review response | `import-review` | No | No | advisory config suggestions |
| Scan one Git ref | `scan-repo` | No | Yes, for Git fetch | provenance plus static results |
| Inventory a GitHub organization | `scan-org` | No | Yes, API plus Git fetches | per-repo reports plus aggregate index |
| Recover dynamic wiring | runtime/hybrid `inventory` or `audit` | **Yes** | Target code may use it | runtime observations |

The repository is the acquisition and discovery boundary. Each detected
`express()` root is a separate application with a stable
`app:<relative-file>#<binding>` ID. Identical paths in separate apps remain
separate throughout findings, baselines, policies, hybrid reconciliation, and
OpenAPI trace metadata.

## The evidence model

express-recon deliberately separates facts from decisions:

- `inventory` records observed routes, middleware chains, source locations, app
  identity, handler hints, and coverage. It makes no security judgment.
- `audit` applies a reviewed `authMiddleware` allowlist, accepted-public
  baseline, and optional policies to that inventory.
- `public` means no configured guard matched. `unknown` means opaque middleware
  might contain a guard and requires review. `proven` means a configured guard
  was observed.
- `hybrid` retains both static and runtime observations. Runtime evidence is
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

`docs` requires a selection when more than one app is present. `--app-id all`
is an intentional collision-reporting merge, not the default. For trusted
hybrid scans, bind the runtime entry to the same ID:

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
and incomplete discovery. Swagger 2 is detected but must be converted before
merging. See the [OpenAPI guide](./docs/openapi.md).

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

Git fetch is time-bounded, but a hostile server can ignore partial-clone filters;
the network packfile is not a hard byte-bounded security boundary. See
[SECURITY.md](./SECURITY.md) before scanning adversarial repositories.

### Inventory a GitHub organization

```bash
npx --no-install express-recon scan-org --org acme \
  --out .express-recon/acme --concurrency 2 --max-repos 500 \
  --fail-on incomplete

# After an interruption or incomplete run, use the same scan-defining options:
npx --no-install express-recon scan-org --org acme \
  --out .express-recon/acme --concurrency 4 --max-repos 500 \
  --fail-on incomplete --resume

# Optional machine-readable progress (JSON Lines on stderr):
npx --no-install express-recon scan-org --org acme \
  --out .express-recon/acme --progress json 2>scan-progress.jsonl
```

`scan-org` enumerates every repository visible through the GitHub organization
API, skips forks and archived repositories by default, and runs the existing
static `scan-repo` pipeline on each eligible repository. Public organizations do
not require a token. Set `GH_TOKEN` or `GITHUB_TOKEN` to include repositories
visible to that token and to fetch private repositories; the token is never
written to reports or Git configuration.

The default concurrency is `1`, so only one bounded snapshot exists at a time.
`--concurrency 2` through `8` opts into a small worker pool. Every snapshot is
deleted in `finally` before its report is returned. With `--out`, completed
reports are written immediately under `repositories/<name>/`, while
`organization-inventory.json` retains a compact aggregate index. This avoids
holding every detailed route report in memory or leaving source snapshots on
disk.

Progress is enabled by default for `scan-org` and is always written to stderr,
so JSON on stdout and files under `--out` remain machine-readable. Interactive
terminals get a live status line with processed/total, active repositories, and
the current phase. CI/non-TTY runs get newline-delimited enumeration-page, start, phase,
completion, failure, resume, checkpoint, and final-summary messages. Use
`--progress plain` for stable human-readable CI logs, `--progress json` for a
JSONL event stream, or `--no-progress` to suppress progress while retaining
operational errors. Progress is phase-level rather than a fabricated ETA: a
slow Git fetch remains in `acquiring` until Git returns or its timeout fires.
When an AI agent launches the scan, set `EXPRESS_RECON_CONTEXT=agent`. The CLI
then requires `--out` and defaults progress to `none`; explicit progress flags
still win. Let the agent inspect the compact aggregate first and open only
relevant per-repository artifacts. Static scanning itself uses no model tokens;
returning logs/reports to the model and optional middleware review do. The
[AI agent guide](./docs/ai-agent-guide.md#keep-organization-scans-token-efficient)
defines the reusable token-discipline rules.

With `--out`, `organization-checkpoint.json` is replaced atomically after every
complete repository. `--resume` verifies the checkpoint fingerprint and every
recorded artifact's size and SHA-256 digest, reuses only complete results, and
retries failed, inconclusive, missing, or damaged work. The checkpoint is kept
while aggregate coverage is incomplete and removed after a complete aggregate
has been written. Concurrency may change for a resume; the organization, tool
version, repository cap, filters, config, and scan scope must still match.
Resume reuse is visible as `RESUME` events, and `CHECKPOINT` is emitted only
after a completed repository's artifacts and atomically replaced checkpoint are
durable.

The default repository cap is 100; raise `--max-repos` deliberately for larger
organizations. Hitting the cap, an API pagination failure, a failed/incomplete
repository scan, or an inconclusive non-Express result makes aggregate coverage
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
operation. Run again without `--resume` to rebuild against current default
branches. Raising a repository cap likewise starts a fresh run because it
changes the inventory scope.

For a scheduled organization CI job, persist the complete `--out` directory in
a protected cache or artifact if a later run must resume it. Keep private-repo
inventories out of pull-request caches, and use a low concurrency first so the
runner's disk/network envelope is measured before increasing it.

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
      "args": ["--no-install", "express-recon-mcp"]
    }
  }
}
```

Core tools include `discover_repository`, `inventory_routes`, `audit_routes`,
`query_audit`, `finding_by_fingerprint`, `suggest_auth`, `openapi_spec`,
`reconcile_openapi`, `review_middleware`, `import_middleware_review`,
`validate_policies`, and `report_schema`.

Useful requests are precise about the evidence boundary:

> Inventory every Express app in this repository. Report scan coverage and
> partial paths before drawing conclusions.

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
  reconcileDocumentation,
  createMiddlewareReview,
  applyMiddlewareAssessments,
  scanRepository,
  scanOrganization,
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
```

Passing an already loaded Express app to `inventory()`/`audit()` executes it in
the caller's process. Prefer `executeRuntime()` when a bounded worker result is
needed. The [library reference](./docs/reference.md#library-api) describes the
exported primitives.

## Documentation

- [CLI, configuration, report, policies, modes, and library reference](./docs/reference.md)
- [AI agent and middleware-review guide](./docs/ai-agent-guide.md)
- [OpenAPI/JSDoc reconciliation guide](./docs/openapi.md)
- [Security and execution trust model](./SECURITY.md)
- [Contributing and local development](./CONTRIBUTING.md)
- [Release process](./RELEASING.md)

## Known boundaries

- Static analysis cannot fully recover data-driven route registration, arbitrary
  dependency injection, computed mounts, or every TypeScript resolution pattern.
  It retains partial evidence and diagnostics instead of silently dropping it.
- Auth classification is only as sound as the reviewed middleware allowlist.
- OpenAPI request/response schemas are placeholders until grounded in handler or
  validator code. The bundled `openapi-doc` skill provides that AI-assisted pass.
- `scan-repo` is non-executing, but Git protocol parsing and network transfer
  still process untrusted remote data.
- Organization scans are API-visible rather than proof of every repository that
  exists; token permissions define visibility.
- Runtime/hybrid mode is for trusted local code only.

MIT licensed. Security issues should be reported privately as described in
[SECURITY.md](./SECURITY.md).
