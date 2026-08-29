# express-recon reference

This is the durable reference for the CLI, configuration, report contract,
scanner behavior, and library API. Start with the project [README](../README.md)
if you have not run the offline workflow yet.

## Contents

- [Commands](#commands)
- [Artifacts and exit codes](#artifacts-and-exit-codes)
- [Configuration](#configuration)
- [Route policies](#route-policies)
- [Scan scope and limits](#scan-scope-and-limits)
- [Runtime boot options](#runtime-boot-options)
- [Report contract](#report-contract)
- [Baselines](#baselines)
- [Scanner behavior](#scanner-behavior)
- [Library API](#library-api)

## Commands

Run `express-recon --help` for the installed version's concise option list.
Paths are resolved from the current working directory unless stated otherwise.

### `discover`

Find package scopes, Express applications, stable app IDs, runtime entry
candidates, OpenAPI/Swagger documents, and swagger-jsdoc sources without
executing target code.

```bash
express-recon discover --src . --out .express-recon
```

Important output fields:

- `packages[]`: nearest package roots and Express dependency information.
- `applications[]`: separate Express roots, source, route count, owning package,
  and entry candidates.
- `recommendedEntry`: populated only when one candidate is high-confidence.
- `documentation`: discovered specifications and JSDoc source files.
- `discoveryCoverage` and `scanCoverage`: repository traversal and route-analysis
  completeness are reported separately.
- `orphanRoutes`: routes that could not be assigned to an application root.

Supported controls are `--src`, scan scope/limits through `--config`,
`--include`, `--exclude`, `--ignore-file`/`--no-ignore-file`, `--include-tests`,
and `--out`.

### `inventory`

Produce routes, middleware, source locations, app identity, handler hints, and
coverage without `authStatus`, findings, or other security judgment.

```bash
express-recon inventory --src . --format json,md --out .express-recon
```

`--mode` may be `static`, `runtime`, or `hybrid`. Runtime/hybrid requires
`--app <entry>`; `--app auto` also requires `--allow-exec`.

### `audit`

Classify an inventory with a reviewed configuration, evaluate route policies,
and emit findings.

```bash
express-recon audit --src . --config recon.config.yaml \
  --format json,md --out .express-recon \
  --fail-on public,unknown,incomplete
```

Audit statuses accepted by `--fail-on`:

- `public`, `unknown`, `proven`: matching routes, excluding accepted-public
  routes from the `public` count.
- `policy`: every configured policy violation.
- `policy:<id>`: violations for one policy.
- `new`: findings absent from `--baseline`.
- `regression`: routes whose auth state became less safe.
- `incomplete`: incomplete static source coverage; rejected in pure runtime
  mode because no static coverage exists.

`new` and `regression` require `--baseline <routes.json>`.

### `suggest-auth`

Rank named middleware that may be authentication guards. The result is JSON on
stdout and is deliberately advisory.

```bash
express-recon suggest-auth --src . > auth-candidates.json
```

Confirm actual behavior before copying a candidate into `authMiddleware`.

### `docs`

Reconcile one app's existing OpenAPI 3 document, swagger-jsdoc blocks, and
static route inventory.

```bash
express-recon docs --src . --app-id 'app:src/app.js#app' \
  --spec docs/openapi.yaml --jsdoc src/routes.js \
  --out .express-recon/docs
```

`--spec` is optional when exactly one OpenAPI candidate is discovered.
`--jsdoc` is repeatable; when omitted, all discovered annotation sources are
used. A multi-app repository requires `--app-id`; `all` is permitted only as an
intentional collision-reporting merge.

Documentation gates:

- `docs-drift`: code-only plus docs-only operations.
- `docs-conflict`: authored OpenAPI/JSDoc values disagree.
- `docs-incomplete`: dynamic or duplicate operations, incomplete route scan, or
  incomplete documentation discovery.

### `review-middleware`

Export bounded evidence for named/anonymous middleware plus the strict schema a
human or model must follow.

```bash
express-recon review-middleware --src . --out .express-recon/review
```

The bundle contains fingerprints, `evidenceCoverage`, definitions, callsites,
sample routes, static/runtime disagreements, deterministic name hints, taxonomy,
and an untrusted-source notice. Inventory and definition-search coverage each
carry scope evidence; a mismatch makes the bundle incomplete. Static mode is
the safe default; hybrid review has the same trusted-code requirement as hybrid
inventory.

### `import-review`

Validate an assessment against its exact bundle and emit advisory config
suggestions.

```bash
express-recon import-review \
  --review .express-recon/review/middleware-review.json \
  --assessment middleware-assessment.yaml \
  --out .express-recon/review
```

Bundle and candidate fingerprints must match. Unknown fields, invalid taxonomy,
duplicates, and stale assessments fail closed. Only `high` confidence plus
`always` enforcement can produce a suggestion. Nothing is applied automatically.

### `scan-repo`

Acquire one GitHub shorthand, HTTPS URL, or explicit local Git repository/ref,
then perform static discovery, inventory/audit, and documentation reconciliation.

```bash
express-recon scan-repo --repo owner/project --ref main \
  --out .express-recon/remote
```

Supplying auth middleware, an accepted-public baseline, policies, or an OpenAPI
security mapping through `--config` makes the embedded route report an `audit`;
otherwise it is an `inventory`. The combined result keeps the compatibility
field name `inventory`, whose own `command` identifies which was run.

Repository acquisition never accepts runtime/hybrid options, target boot
options, embedded credentials, SSH/Git protocols, symlink materialization, or
submodule traversal.

### `scan-org`

Enumerate API-visible repositories in a GitHub organization and build a static
Express inventory from the existing per-repository pipeline:

```bash
express-recon scan-org --org acme --out .express-recon/acme \
  --concurrency 2 --max-repos 500 --fail-on incomplete

# Continue an interrupted/incomplete run. Concurrency may be changed.
express-recon scan-org --org acme --out .express-recon/acme \
  --concurrency 4 --max-repos 500 --fail-on incomplete --resume

# JSON Lines progress for a log collector; results still go to --out/stdout.
express-recon scan-org --org acme --out .express-recon/acme \
  --progress json 2>scan-progress.jsonl
```

Scope and resource controls:

- public organizations work without authentication;
- `GH_TOKEN` takes precedence over `GITHUB_TOKEN` when either is set;
- authenticated enumeration includes only repositories visible to that token;
- forks and archived repositories are skipped unless `--include-forks` or
  `--include-archived` is present;
- disabled and empty repositories are recorded but not fetched;
- `--max-repos` defaults to 100 and accepts 1–10,000;
- `--concurrency` defaults to 1 and accepts 1–8;
- `--resume` requires `--out` and continues a compatible checkpoint;
- `--progress` accepts `auto`, `plain`, `json`, or `none`; `--no-progress` is an
  alias for `--progress none`;
- scan configuration and CLI include/exclude/ignore/test scope apply
  independently to every selected repository.

The default uses each repository's `.express-reconignore`. A central CI owner
can use `--no-ignore-file` or an absolute trusted `--ignore-file` to prevent a
repository from choosing its own organization-inventory scope. Aggregate
`scope.fingerprint`, `configHash`, and `scanHash` make that policy auditable;
per-repository route artifacts retain the detailed scope and ignore content
hash.

The implementation uses GitHub's
[List organization repositories](https://docs.github.com/en/rest/repos/repos?apiVersion=2022-11-28#list-organization-repositories)
endpoint, pins REST API version `2022-11-28`, and follows the documented
[pagination link relation](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api).
API pagination is independent of the scan cap, so the report can say how many
repositories were visible and which eligible repositories exceeded the cap.
Each selected repository is fetched at its remote default (`HEAD`).

Every repository snapshot is removed by the per-repository scanner's `finally`
block before its result is returned. At concurrency `N`, at most `N` bounded
snapshots are active in normal operation. With `--out`, each full result is
written immediately under `repositories/<name>/` and released; the aggregate
`organization-inventory.json` contains compact evidence, summaries, statuses,
coverage, and relative artifact paths. Without `--out`, detailed scans remain
embedded so stdout is self-contained and memory use grows with the organization.

#### Progress and CI logs

Organization progress is written only to stderr. `auto`, the default, renders a
live status line on a TTY and stable newline-delimited text on a non-TTY such as
CI. `plain` always uses the latter format, `json` writes one
`organization-scan-progress` JSON object per line, and `none` suppresses
progress. Operational errors are still reported with `none`. In JSON mode, a
fatal scan operation ends with a `scan-failed` JSON event rather than an
additional unstructured stderr line.

`EXPRESS_RECON_CONTEXT=agent` is the explicit integration contract for an AI
agent command runner. It requires `scan-org --out <dir>` before enumeration and
changes the implicit progress mode to `none`, keeping detailed reports and
routine progress out of model context. `EXPRESS_RECON_CONTEXT=ci` selects plain
progress, while `interactive` retains TTY/non-TTY auto-selection. An explicit
`--progress` or `--no-progress` always wins. The context affects presentation
and storage safeguards only; it is not scan evidence and does not change scope
fingerprints.

Every JSON event has `schemaVersion`, `kind`, `event`, `timestamp`,
`elapsedMs`, and `organization`. Depending on the lifecycle point it also has
repository identity, selected `index`, `processed`/`total`, `active`, `failed`,
`concurrency`, phase, status, duration, route/application counts, or safe error
text. Event names are:

| Event | Meaning |
| --- | --- |
| `enumeration-started`, `enumeration-page`, `enumeration-completed`, `enumeration-failed` | GitHub listing lifecycle, API-page visibility, and selected/resumed/pending totals |
| `repository-skipped`, `repository-resumed` | Work intentionally omitted or reused from a verified checkpoint |
| `repository-started`, `repository-phase` | Active work and `acquiring`, `discovering`, `inventorying`, `documenting`, or `cleaning-up` phase |
| `repository-completed`, `repository-failed` | Terminal result with monotonic processed/failure counters |
| `checkpoint-written` | CLI `--out` artifacts and the atomically replaced checkpoint are durable |
| `resume-warning`, `gate-triggered` | Damaged resume work was rejected, or `--fail-on incomplete` matched |
| `scan-finished`, `scan-failed` | Aggregate terminal state or fatal command failure |

The phase stream is honest boundary progress, not transfer-byte progress or an
ETA. In particular, a slow Git fetch stays at `acquiring` until Git finishes or
the repository timeout expires. With concurrency greater than one, `active`
shows the current worker count and phase events identify each active repository.
Errors are control-character-safe in plain logs and token-redacted by the scan
pipeline.

#### Resume and checkpoints

`--resume` requires `--out`. On a fresh output run, the CLI creates
`organization-checkpoint.json` before enumeration and atomically replaces it
after each repository whose acquisition, discovery, and source analysis are all
complete. The checkpoint records compact repository evidence, commit IDs,
artifact paths, sizes, and SHA-256 digests; it never contains the GitHub token or
source files.

On resume, the GitHub API is enumerated again. A recorded repository is reused
only when its name/ID still matches and every expected artifact is a regular file
with the recorded size and digest. Failed, inconclusive, absent, renamed,
recreated, missing-artifact, and damaged-artifact repositories are scanned again.
A completed repository is not fetched, so its checkpointed commit remains the
observation for that resumed run even if its default branch advanced.

The checkpoint fingerprint binds the exact tool version, organization,
`--max-repos`, archived/fork filters, configuration, and effective scan scope.
Changing any of those fails before GitHub enumeration instead of mixing
incompatible evidence. `--concurrency` and the current token are deliberately
not fingerprinted: concurrency does not change evidence, and every resume is
still restricted to repositories visible during its fresh API enumeration.
Run without `--resume` for a new scan of current default branches or to change
the repository cap/scope.

The checkpoint remains after an interrupted or aggregate-incomplete run. It is
deleted only after a complete `organization-inventory.json` is successfully
written. A repository cap itself cannot be repaired by resume; start a fresh run
with a larger `--max-repos` value.

Repository statuses are `express`, `not-express`, `inconclusive`, `failed`,
`empty`, `skipped-archived`, `skipped-fork`, `skipped-disabled`, or
`skipped-limit`. A repository is `not-express` only when acquisition, discovery,
and source scanning are complete. Incomplete negative evidence is
`inconclusive`, preventing a false organization-level non-Express conclusion.

`--fail-on incomplete` exits `2` when API pagination, the repository limit, a
repository failure/inconclusive result, or per-repository coverage makes the
aggregate incomplete. Filters for archived/fork repositories are intentional
scope choices and do not by themselves make coverage incomplete.

Supplying auth/policy/OpenAPI configuration applies the same configuration to
every repository and turns each embedded report into an audit when applicable.
Use this only for genuinely shared middleware conventions; names alone remain
insufficient evidence.

### `render`

Render existing machine-readable artifacts as a browsable offline HTML site:

```bash
express-recon render --input .express-recon/acme \
  --out .express-recon/acme-site
```

Both options are required. `--input` accepts a direct `routes.json`,
`repo-scan.json`, or `organization-inventory.json` path, or a directory containing
one. Directory detection prefers the organization aggregate, then a repository
scan, then a route report. `render` never scans source, acquires a repository,
executes target code, contacts the network, or invokes a model.

The output contains:

- `index.html`, with route/repository search and status filtering;
- `repositories/<name>.html` for confirmed Express repositories and
  inconclusive scans with an available detailed artifact; definite non-Express,
  skipped, empty, and failed entries remain index-only;
- local `assets/report.css` and `assets/report.js` with no CDN dependency; and
- `render-manifest.json`, recording the source kind, generated pages, and
  non-fatal artifact warnings.

The output directory must be empty or contain a prior express-recon HTML site.
On a rerender, the prior manifest is validated before only its generated files
are replaced; stale repository pages are removed and unrelated files are
preserved. A nonempty unowned directory, unsafe generated symlink, or tampered
manifest path fails closed instead of overwriting or deleting unknown content.

Organization artifact references are resolved inside the input directory and
real-path checked so traversal and escaping symlinks are not followed. Report
values are treated as untrusted text and HTML-escaped. Generated pages use a
restrictive content security policy and do not fetch JSON at viewing time, so a
site copied into a CI artifact remains usable through `file://`. Missing, unsafe,
or damaged per-repository artifacts produce an aggregate warning rather than
hiding the remaining organization evidence. Root input errors exit `1`.

HTML is a human review projection, not a new evidence schema. Automation and AI
agents should continue consuming the original JSON contracts.

### `schema`

Print the report JSON Schema to stdout:

```bash
express-recon schema > express-recon-report.schema.json
```

## Artifacts and exit codes

With `--out`, directories are created as needed.

| Command | Artifact(s) |
| --- | --- |
| `discover` | `discovery.json` |
| `inventory` / `audit` | `routes.json`, `routes.md`, and/or `openapi.json` according to `--format` |
| `docs` | `openapi.json`, `docs-report.json` |
| `review-middleware` | `middleware-review.json` |
| `import-review` | `middleware-suggestions.json` |
| `scan-repo` | `repo-scan.json`, `discovery.json`, `routes.json`; OpenAPI/docs report when mergeable |
| `scan-org` | `organization-inventory.json`; per-repo `repo-scan.json`, discovery, routes, and mergeable docs under `repositories/<name>/`; `organization-checkpoint.json` while incomplete |
| `render` | `index.html`, local CSS/JavaScript, `render-manifest.json`, and organization repository pages |
| `suggest-auth` / `schema` | JSON on stdout |

`pretty` is terminal-oriented and is not written as an artifact. Supported
inventory/audit formats are `pretty`, `json`, `md`, and `openapi`; formats may
be comma-separated.

Exit codes:

| Code | Meaning |
| ---: | --- |
| `0` | Command completed and no requested gate matched. |
| `1` | Invalid CLI/config input or operational failure. |
| `2` | Command completed, but at least one `--fail-on` condition matched. |

Diagnostics go to stderr and remain in machine reports where applicable. JSON
and OpenAPI stdout remain parseable even when a gate exits `2`. `scan-org`
progress also uses stderr; select `--progress json` when the stderr channel must
itself be machine-readable.

## Configuration

`--config` accepts CommonJS (`.js`/`.cjs`), JSON, or YAML. JSON/YAML is data-only
and preferred for untrusted/static workflows. JavaScript config executes with
the invoking user's permissions. Unknown fields fail instead of being ignored.

Top-level keys:

| Key | Purpose |
| --- | --- |
| `authMiddleware` | Confirmed middleware-to-auth grant mapping. |
| `authWrappers` | Wrappers proven to always execute/preserve their inner middleware. |
| `acceptedPublic` | Reviewed intentionally unauthenticated routes. |
| `policies` | Deterministic route requirements and expiring exceptions. |
| `openapi` | Explicit security schemes and auth-tag mappings. |
| `scan` | Scope and resource limits. |
| `boot` | Trusted runtime/hybrid worker settings. |

A top-level JSON/YAML array is shorthand for `{ policies: [...] }`.

### Authentication grants

```yaml
authMiddleware:
  requireAuth: authenticated
  passport.authenticate:
    tags: [session]
    roles: [member]
    scopes: [profile:read]

# Include only wrappers whose implementation always invokes the wrapped guard.
authWrappers: [asyncHandler]
```

A string is shorthand for one auth tag. Structured grants may contain `tag`,
`tags`, `roles`, and `scopes`. Roles/scopes without a tag imply the
`authenticated` tag.

An inner name such as `requireAuth` inside `asyncHandler(requireAuth)` proves
auth only when `asyncHandler` is explicitly listed in `authWrappers`. Otherwise
the route is `unknown`, not `proven`.

### Accepted-public baseline

```yaml
acceptedPublic:
  # Legacy/global form: applies to every app with this method/path.
  - POST /webhooks/stripe

  # Preferred multi-app form.
  - applicationId: app:apps/public/src/app.js#app
    method: GET
    path: /health
```

Accepted routes remain `authStatus: public` and gain `accepted: true`; their
`public-route` finding and `--fail-on public` match are suppressed. An entry
that no longer matches a public route emits a `stale-baseline` finding.

### OpenAPI security mapping

```yaml
openapi:
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer, bearerFormat: JWT }
    sessionCookie: { type: apiKey, in: cookie, name: session }
  securityByTag:
    authenticated: [bearerAuth]
    session: [sessionCookie]
```

Every mapped name must exist in `securitySchemes`. Middleware names and audit
tags never imply a protocol: cookies, bearer tokens, HMAC, API keys, and mTLS
cannot be distinguished safely from a name alone. Multiple mapped guards on a
route are conjunctive in one OpenAPI Security Requirement Object.

## Route policies

A policy selects routes and evaluates a requirement:

```yaml
policies:
  - id: admin-writes
    description: Admin writes require the standard guard chain.
    severity: high
    match:
      applicationIds: [app:src/admin.js#app]
      methods: [POST, PUT, PATCH, DELETE]
      paths: ["/admin/**"]
      excludePaths: ["/admin/webhooks/**"]
    require:
      all:
        - auth: true
        - roles: [admin]
        - anyScope: [users:write, users:admin]
        - middlewareOrder: [requireAuth, requireAdmin]
      not:
        allMiddleware: [debugBypass]
    exceptions:
      - id: migration-callback
        reason: Temporary migration integration.
        expires: 2027-01-31
        match: { paths: ["/admin/migration/callback"] }
```

Selectors:

- `applicationIds`, `methods`, `paths`, `excludePaths`
- `authStatuses`, `tags`, `roles`, `scopes`

Path globs use `*` within one segment and `**` across segments.

Leaf requirements:

- `auth: true`
- `anyMiddleware`, `allMiddleware`, `noMiddleware`, `middlewareOrder`
- `anyTag`, `allTags`, `noTags`
- `anyRole`, `allRoles`, `noRoles`; `roles` aliases `allRoles`
- `anyScope`, `allScopes`, `noScopes`; `scopes` aliases `allScopes`

Compose requirements recursively with `all`, `any`, and `not`. Exceptions must
have a route selector, reason, and valid ISO date. Active exceptions appear in
`policyExceptions`; expired ones stop suppressing violations and add diagnostics.

## Scan scope and limits

```yaml
scan:
  include: ["apps/api/**", "packages/routes/**"]
  exclude: ["**/generated/**", "**/vendor/**"]
  ignoreFile: .express-reconignore # false disables it
  maxFiles: 50000
  maxFileBytes: 5242880
  maxTotalBytes: 262144000
  timeoutMs: 120000
```

Defaults are 50,000 files, 5 MiB per file, 250 MiB total source, and 120 seconds.
CLI `--include`/`--exclude` values are repeatable and are combined with config.
`--no-ignore-file` overrides both the default and a configured ignore file.
An explicit `--ignore-file` may be absolute (useful for one trusted CI policy
applied to two checkouts); relative paths are resolved from each scan root.

`.express-reconignore` uses root-relative globs, one per line. Blank lines and
`#` comments are ignored; a later `!pattern` re-includes a path:

```gitignore
generated/**
private/**
!private/public-routes.js
```

The scope applies consistently to package/app discovery, OpenAPI candidates,
swagger-jsdoc sources, route analysis, and middleware review. Include patterns
form the initial allowlist. Excludes always win. Ignore rules are then evaluated
in order, so `!pattern` can reverse only an earlier ignore rule—not an explicit
exclude or a missing include. This is a deliberately small glob format, not a
complete `.gitignore` implementation.

Dependency, VCS, build, hidden, and test paths are excluded by default. Test
directories include `test`, `tests`, `testcases`, `spec`, `specs`, `__tests__`,
and `__mocks__`; `--include-tests` opts them and `*.test.*`/`*.spec.*` files in.

Limits are applied in deterministic path order. Parse/read/traversal failures or
limits set coverage `complete: false` and add diagnostics. Do not convert an
incomplete result into a clean bill of health by filtering out its diagnostics.

## Runtime boot options

Runtime/hybrid is for trusted local code only.

```yaml
boot:
  env:
    DATABASE_URL: postgres://placeholder
    SESSION_SECRET: recon
  inheritEnv: false
  stubModules: [my-internal-db-client, "@my-scope/"]
  sandbox: true
  timeoutMs: 10000
  settleMs: 50
  maxOutputBytes: 5242880
```

Defaults: isolated environment, compatibility stubs enabled, 10-second timeout,
50 ms deferred-registration window, and 5 MiB output limit. `settleMs` must be
less than `timeoutMs`.

The worker:

- sets `EXPRESS_RECON_DRY=1` before importing the target;
- neutralizes `listen()` and target `process.exit()` while stubs are enabled;
- provides inert CommonJS stubs for common database/cache/broker/cloud clients;
- captures routes registered after promises, conventional completion callbacks,
  and short timers;
- returns partial routes with a diagnostic if boot fails after registration;
- contains process crashes/timers but not filesystem, process, or network access.

CommonJS stubbing patches `Module._load`; native ESM dependency imports are not
intercepted. `inheritEnv: true` exposes the parent's environment to trusted
target code and should be exceptional.

## Report contract

`buildReport()` and CLI JSON use schema version `2.0`. Required top-level fields
are `schemaVersion`, `tool`, `toolVersion`, `command`, `mode`, `applications`,
`routes`, and `globalMiddleware`.

Important fields:

- `configHash`: SHA-256 of canonical analysis config, without embedding config.
- `applications[]`: stable ID, source, route count, and global middleware.
- `routes[].applicationId`: app identity or `null` for unresolved/orphan routes.
- `routes[].source`: repository-relative file and line when known.
- `routes[].io`: best-effort request/response/handler hints from static analysis.
- `routes[].pathConfidence`: `full` or `partial`.
- `routes[].authStatus`, tags, roles, scopes, and `authEvidence`: audit only.
- `routes[].presence` and `observations`: hybrid evidence (`both`,
  `static-only`, `runtime-only`) without discarding either scanner's view.
- `scanCoverage`: discovered/analyzed/failed/skipped counts, bytes, limit flag,
  `complete`, and portable `scope` evidence. Scope includes normalized
  include/exclude values, test selection, ignore-file presence/rule count/content
  hash, built-in exclusions, and an effective-scope fingerprint. Absolute ignore
  paths are represented as `<external>/<basename>` rather than leaked.
- `summary`, `findings`, normalized `policies`, and applied
  `policyExceptions`: audit only.
- `delta`: comparison with `--baseline`.

Finding types:

| Finding | Meaning |
| --- | --- |
| `public-route` | No configured authentication guard matched. |
| `opaque-middleware` | A possible guard is opaque; manual review required. |
| `per-verb-gap` | Methods on the same app/path have different auth states. |
| `stale-baseline` | An accepted-public entry no longer matches a public route. |
| `policy-violation` | A configured route requirement failed. |

Every current finding carries `ruleId`, stable `fingerprint`, severity,
confidence, app identity, detail, and recommendation. Fingerprints intentionally
exclude source line so harmless line moves do not create new findings.

Use `express-recon schema` rather than copying a partial example when building a
consumer. Inventory reports intentionally omit audit-only judgment fields.

## Baselines

```bash
express-recon audit --src . --config recon.config.yaml \
  --baseline previous/routes.json --format json
```

The current repository is always scanned in full. Delta output contains added
and removed routes, auth regressions/improvements with causes, new findings, and
resolved findings. Version 2 keys include `applicationId` so duplicate paths in
different apps compare independently.

Schema 1.x baselines retain historical global method/path matching for
compatibility. Regenerate them promptly: they cannot distinguish separate apps
that share a path.

When both reports contain current scope evidence, comparison requires matching
scope fingerprints and fails operationally if they differ. This prevents an
ignore/include/test change from masquerading as a route delta. Apply the same
trusted scope to both checkouts. Older reports without scope evidence remain
readable for compatibility but cannot prove scope comparability.

## Scanner behavior

### Static mode

Static mode parses `.js`, `.jsx`, `.cjs`, `.mjs`, `.ts`, `.tsx`, `.mts`, and
`.cts` with no type-check or build. It resolves:

- separate `express()` roots and `express.Router()` bindings;
- `app.METHOD()`, `router.METHOD()`, `route().all().get()` chains, and arrays of
  literal paths;
- cross-file mounts and middleware registration order;
- same-file string constants, concatenation, and template paths;
- `require`, ESM import, package `#imports`, nearest-package `tsconfig` paths and
  `baseUrl`, and common barrel re-exports;
- path-scoped middleware, configured transparent wrappers, and one-hop
  controller handler hints.

It retains partial evidence for dynamic/data-driven registration, registrar
functions, computed/regex paths or scopes, unresolved dependency injection,
bare-package routers, and unsupported resolution chains. `tsconfig extends`
chains are not followed. Regex/computed guard scopes are conservatively treated
as host-wide rather than used to prove a route public.

### Runtime mode

Runtime walks the app that actually booted and can observe dynamic registration.
Source and mount paths are strongest when instrumentation captured the
registration. Pure runtime has no static `scanCoverage`.

### Hybrid mode

Hybrid combines static breadth/source hints with runtime wiring. It matches by
application identity, exact route, registration source, or unambiguous partial
suffix. Runtime middleware/auth is authoritative only for a confirmed pair.
Ambiguous duplicate paths, shared-router sources, or unsourced observations stay
separate instead of being assigned to the first app.

## Library API

```js
const recon = require("express-recon");
```

Primary exports:

- `discover(root, options)`
- `inventory(options)`
- `audit(options, config)`
- `suggestAuth(registry)`
- `buildReport(registry, metadata)`
- `compareReports(before, after)`
- `reconcileDocumentation(report, options)`
- `createMiddlewareReview(report, options)`
- `applyMiddlewareAssessments(bundle, assessment)`
- `scanRepository(source, options)` and `acquireRepository(source, options)`
- `scanOrganization(organization, options)` and
  `listOrganizationRepositories(organization, options)`
- `renderHtmlSite(inputPath, outputPath)`
- `executeRuntime(appPath, boot)` and `instrument(express)`
- `evaluatePolicies`, `normalizePolicies`, `loadConfig`, and `validateConfig`
- `REPORT_SCHEMA`, `MIDDLEWARE_ASSESSMENT_SCHEMA`, and `formatters`

`inventory()`/`audit()` options use `mode: "static" | "runtime" | "hybrid"`.
Static/hybrid requires `src`. Direct runtime library use accepts an already
loaded `app`, which has already executed in the caller. CLI-style worker use is:

```js
const runtimeRegistry = await recon.executeRuntime("./src/app.js", {
  timeoutMs: 10_000,
});

const registry = recon.inventory({
  mode: "hybrid",
  src: ".",
  runtimeRegistry,
  runtimeEntry: "./src/app.js",
  applicationId: "app:src/app.js#app",
});
```

Raw registries use absolute source paths internally. Pass `sourceRoot` to
`buildReport()` to normalize portable repository-relative paths.

`scanOrganization()` is asynchronous. Its main options are `token`,
`maxRepositories`, `concurrency`, `includeArchived`, `includeForks`, shared
`config`/`scan` settings, and streaming/resume controls:

- `onRepository({ repository, status, express, coverageComplete, scan })` can
  persist a completed detailed scan immediately;
- `onProgress(event)` synchronously observes the versioned organization events
  listed under [Progress and CI logs](#progress-and-ci-logs), including
  repository phases and monotonic counters;
- `retainScans: false` keeps only compact aggregate evidence after that callback.
- `resumeEntries` accepts previously validated, complete compact entries and
  requires `retainScans: false`; matching repositories are not reacquired.

Concurrency defaults to one and is capped at eight. The callback runs after the
repository snapshot has already been removed. CLI `--out` uses both streaming
controls; library callers should do the same for large organizations. The
organization contract has its own `kind` and schema version and is not described
by `REPORT_SCHEMA`, which applies to individual route inventory/audit reports.
An exception from `onProgress` disables that observer, adds a redacted
diagnostic, and never changes scan evidence. `scanRepository()` likewise accepts
an optional best-effort `onProgress` callback with `repository-scan-progress`
phase events. The CLI adds checkpoint/resume/gate events that it owns around the
library stream.
The CLI owns checkpoint persistence, compatibility fingerprints, and artifact
integrity validation; library callers supplying `resumeEntries` must provide
equivalent validation themselves.

`renderHtmlSite()` is synchronous and returns the render manifest plus the
absolute `index.html` path. It accepts the same file or directory inputs as the
CLI `render` command and writes a deterministic, offline site without changing
the input artifacts.

## Related guides

- [README and quickstart](../README.md)
- [AI agent guide](./ai-agent-guide.md)
- [OpenAPI guide](./openapi.md)
- [Security model](../SECURITY.md)
- [Contributing](../CONTRIBUTING.md)
