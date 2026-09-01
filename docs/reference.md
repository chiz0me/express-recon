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

Find package scopes, Express/Fastify/NestJS applications, stable app IDs, entry
candidates, OpenAPI/Swagger documents, and swagger-jsdoc sources without
executing target code.

```bash
express-recon discover --src . --out .express-recon
```

Important output fields:

- `packages[]`: nearest package roots plus declared framework packages. Each
  declaration records its `package.json` field, version range, `direct: true`,
  normalized `scope` (`runtime`, `optional`, `peer`, or `development`), and
  signal `strength`. Runtime/optional declarations are strong presence signals;
  peer and development declarations do not prove a runnable application.
- `applications[]`: separate application roots, `framework`, underlying
  `adapter`, source, route count, owning package, and entry candidates.
- `recommendedEntry`: populated only when one candidate is high-confidence.
- `documentation`: discovered specifications and JSDoc source files.
- `discoveryCoverage` and `scanCoverage`: repository traversal and route-analysis
  completeness are reported separately.
- `orphanRoutes`: routes that could not be assigned to an application root.

Supported controls are `--src`, scan scope/limits through `--config`,
`--include`, `--exclude`, `--ignore-file`/`--no-ignore-file`, `--include-tests`,
`--include-hidden`, and `--out`.

### `inventory`

Produce routes, middleware, source locations, app identity, handler hints, and
coverage without `authStatus`, findings, or other security judgment.

```bash
express-recon inventory --src . --format json,md --out .express-recon
```

`--mode` may be `static`, `runtime`, or `hybrid`. Static mode supports Express,
Fastify, and NestJS. Runtime/hybrid is currently Express-only and requires
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
JSON/YAML documents and data-only JavaScript/TypeScript CommonJS or ESM modules
are supported. Module exports are reconstructed by a bounded static interpreter;
target code and external package code are not imported, and unsupported helpers
or computation produce an incomplete candidate diagnostic. `--jsdoc` is repeatable; when
omitted, all discovered annotation sources are used.

Selection is package-aware: one app in the base document's owning package is
selected automatically. Multiple matching apps, or a document and app in
different package scopes, require `--app-id`; `all` is permitted only as an
intentional collision-reporting merge.

Documentation gates:

- `docs-drift`: code-only plus verified docs-only operations.
- `docs-conflict`: authored OpenAPI/JSDoc values disagree.
- `docs-incomplete`: dynamic or duplicate operations, incomplete route scan, or
  incomplete documentation discovery. It also matches unresolved/orphan route
  graphs and possible opaque route-provider mounts; docs-only operations in
  that state are reported as unverified rather than stale.

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

Public repositories need no authentication. For a private GitHub repository,
set `GH_TOKEN` (preferred) or `GITHUB_TOKEN`; the scoped header is used for the
initial partial fetch and any on-demand promisor object reads without persisting
the token in arguments, URLs, reports, or Git configuration.

Supplying auth middleware, an accepted-public baseline, policies, or an OpenAPI
security mapping through `--config` makes the embedded route report an `audit`;
otherwise it is an `inventory`. The combined result keeps the compatibility
field name `inventory`, whose own `command` identifies which was run.

With `--out`, every valid discovered OpenAPI 3 or Swagger 2 contract is retained
under `specifications/`. Multiple OpenAPI documents produce documentation status
`cataloged` rather than an arbitrary canonical merge. A one-document/one-package/
one-application mapping may be reconciled independently; contracts sharing an
application remain separate. `--spec <path>` still selects an intentional
canonical OpenAPI 3 merge for a focused repository scan. Swagger 2 can be
rendered but is never a reconciliation base.

Repository acquisition never accepts runtime/hybrid options, target boot
options, embedded credentials, SSH/Git protocols, symlink materialization, or
submodule traversal.

### `scan-org`

Enumerate API-visible repositories in a GitHub organization and build a static,
framework-aware inventory from the existing per-repository pipeline:

```bash
express-recon scan-org --org acme \
  --concurrency 2 --max-repos 500 --fail-on incomplete
# Writes .express-recon/acme by default.

# Continue an interrupted/incomplete run. Concurrency may be changed.
express-recon scan-org --org acme \
  --concurrency 4 --max-repos 500 --fail-on incomplete --resume

# JSON Lines progress for a log collector; results remain in the default output.
express-recon scan-org --org acme \
  --progress json 2>scan-progress.jsonl

# Compare current default branches with a separate completed inventory.
express-recon scan-org --org acme --baseline .express-recon/acme-before \
  --out .express-recon/acme-current --max-repos 500 --fail-on incomplete
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
- output defaults to `.express-recon/<lowercase-organization>` under the current
  directory; `--out` overrides it;
- `--resume` continues a compatible checkpoint in the selected/default output;
- `--overwrite` starts fresh while preserving unrelated files in that output;
- `--baseline` accepts a separate prior organization report file or output
  directory with a compatible organization and scan scope;
- `--progress` accepts `auto`, `plain`, `json`, or `none`; `--no-progress` is an
  alias for `--progress none`;
- scan configuration and CLI include/exclude/ignore/test scope apply
  independently to every selected repository.

Each completed repository report retains valid specification artifacts before
its temporary source snapshot is removed. The compact organization entry points
to those artifacts, and checkpoint integrity records cover them. `render` reads
the catalog and creates one offline API-reference page per retained OpenAPI 3 or
Swagger 2 document without rescanning or choosing a canonical specification.
Aggregate summary fields count specification-bearing repositories, available
OpenAPI/Swagger documents, and repositories left intentionally `cataloged`.

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
snapshots are active in normal operation. Each full result is written immediately
under `repositories/<name>/` in the selected/default output and released; the
aggregate `organization-inventory.json` contains compact evidence, summaries,
statuses, coverage, and relative artifact paths. Detailed scans are never
collected into one CLI stdout payload.

#### Baseline change reports

`--baseline <prior-output>` reads the prior aggregate before enumeration and
rejects a different organization, repository cap, archived/fork selection,
configuration hash, scan hash, or scope fingerprint. The baseline directory
must be separate from and non-nested with the selected/default output,
preventing a fresh scan from overwriting evidence while it is being compared.
Baseline comparison does not change scan evidence or the checkpoint fingerprint,
so the same baseline may be supplied when resuming an interrupted current run.

After scanning, common complete repositories are compared one at a time from
their saved `repo-scan.json` route reports. The resulting
`organization-delta.json` records:

- repositories added, removed, newly supported, no longer supported, newly
  Express, or no longer Express;
- repository status, application-count, route-count, and documentation-status
  transitions;
- exact added and removed paths for repositories present in both inventories;
- configuration-relative authentication regressions/improvements and finding
  count changes; and
- explicit comparison coverage and bounded diagnostics for missing, damaged,
  or scope-incompatible detailed artifacts.

Added or removed repositories remain repository lifecycle changes: their whole
route sets are not mislabeled as newly created or deleted code. Exact counts are
retained, while route detail objects are capped at 100 per repository and 5,000
overall. The delta artifact has a 32 MiB output limit; if necessary, retained
details are dropped before counts. `organization-inventory.json` embeds only the
delta summary and first 20 changed repository summaries so CI and agents can
triage without loading the full delta. A subsequent scan without `--baseline`
removes a prior generated delta instead of presenting stale changes.

Before scanning, the CLI persists a comparison-only copy under
`comparison-baseline/`, containing the prior aggregate and only the detailed
`repo-scan.json` files needed for future comparisons. It is capped at 256 MiB.
If the current scan is interrupted or incomplete, that directory stays beside
the checkpoint and a later `--resume` discovers it automatically; after a
complete aggregate and delta are written, it is removed. This preserves the
original comparison across retries without retaining source snapshots.

#### Progress and CI logs

Organization progress is written only to stderr. `auto`, the default, renders a
live status line on a TTY and stable newline-delimited text on a non-TTY such as
CI. `plain` always uses the latter format, `json` writes one
`organization-scan-progress` JSON object per line, and `none` suppresses
progress. Operational errors are still reported with `none`. In JSON mode, a
fatal scan operation ends with a `scan-failed` JSON event rather than an
additional unstructured stderr line.

`EXPRESS_RECON_CONTEXT=agent` is the explicit integration contract for an AI
agent command runner. It keeps the durable default output and changes the
implicit progress mode to `none`, keeping detailed reports and routine progress
out of model context without another required flag. `EXPRESS_RECON_CONTEXT=ci`
selects plain progress, while `interactive` retains TTY/non-TTY auto-selection.
Explicit `--out`, `--progress`, or `--no-progress` values always win. The context
affects presentation and storage safeguards only; it is not scan evidence and
does not change scope fingerprints.

When the selected/default output is nonempty, an interactive TTY asks for
`resume`, `overwrite`, or `cancel` before enumeration or writes; cancel is the default. CI, agent,
non-TTY, and JSON-progress runs never prompt because they may not have a human
input channel and stderr may be machine-readable. They fail closed with the
exact `--resume`/`--overwrite` choices instead. `--overwrite` replaces
colliding organization artifacts and resets the checkpoint, but deliberately
does not recursively delete the output directory or unrelated files.

Every JSON event has `schemaVersion`, `kind`, `event`, `timestamp`,
`elapsedMs`, and `organization`. Depending on the lifecycle point it also has
repository identity, selected `index`, `processed`/`total`, `active`, `failed`,
`concurrency`, phase, status, duration, route/application counts, or safe error
text. Event names are:

| Event                                                                                    | Meaning                                                                                           |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `enumeration-started`, `enumeration-page`, `enumeration-completed`, `enumeration-failed` | GitHub listing lifecycle, API-page visibility, and selected/resumed/pending totals                |
| `repository-skipped`, `repository-resumed`                                               | Work intentionally omitted or reused from a verified checkpoint                                   |
| `repository-started`, `repository-phase`                                                 | Active work and `acquiring`, `discovering`, `inventorying`, `documenting`, or `cleaning-up` phase |
| `repository-completed`, `repository-failed`                                              | Terminal result with monotonic processed/failure counters                                         |
| `checkpoint-written`                                                                     | CLI output artifacts and the atomically replaced checkpoint are durable                           |
| `resume-warning`, `gate-triggered`                                                       | Damaged resume work was rejected, or `--fail-on incomplete` matched                               |
| `scan-finished`, `scan-failed`                                                           | Aggregate terminal state or fatal command failure                                                 |

The phase stream is honest boundary progress, not transfer-byte progress or an
ETA. In particular, a slow Git fetch stays at `acquiring` until Git finishes or
the repository timeout expires. With concurrency greater than one, `active`
shows the current worker count and phase events identify each active repository.
Errors are control-character-safe in plain logs and token-redacted by the scan
pipeline.

#### Resume and checkpoints

`--resume` and `--overwrite` are mutually exclusive and operate on the explicit
or default output. On a fresh or explicit overwrite run, the CLI creates
`organization-checkpoint.json` before enumeration and atomically replaces it
after each repository whose acquisition, discovery, and source analysis are all
complete. The checkpoint records compact repository evidence, commit IDs,
artifact paths, sizes, and SHA-256 digests; it never contains the GitHub token or
source files.

On resume, the GitHub API is enumerated again. A recorded repository is reused
only when its name/ID still matches and every expected artifact is a regular file
with the recorded size and digest. Failed, inconclusive, absent, renamed,
recreated, missing-artifact, and damaged-artifact repositories are scanned again.
A pre-catalog checkpoint entry that reported discovered specifications but has
no retained-specification artifact list is also rescanned; completed entries
without documentation inputs remain reusable.
A completed repository is not fetched, so its checkpointed commit remains the
observation for that resumed run even if its default branch advanced.

The checkpoint fingerprint binds the checkpoint compatibility generation,
organization, `--max-repos`, archived/fork filters, configuration, and effective
scan scope. Explicitly compatible releases can resume older checkpoints after
validating both the legacy fingerprint and every artifact digest; the checkpoint
is then upgraded atomically. On migration to framework-aware scans, positive
legacy Express entries remain reusable but legacy negative entries are removed
from the checkpoint and scanned again. A scanner change that invalidates prior
evidence increments the compatibility generation and rejects the checkpoint
instead of mixing incompatible results. `--concurrency` and the current token are
deliberately not fingerprinted: concurrency does not change evidence, and every
resume is still restricted to repositories visible during its fresh API
enumeration. Run with `--overwrite` for a new scan of current default branches
or to change the repository cap/scope in an existing output directory.

The checkpoint remains after an interrupted or aggregate-incomplete run. It is
deleted only after a complete `organization-inventory.json` is successfully
written. A repository cap itself cannot be repaired by resume; start a fresh run
with `--overwrite` and a larger `--max-repos` value.

Repository statuses are `express`, `fastify`, `nestjs`, `multi-framework`,
`not-express`, `inconclusive`, `failed`, `empty`, `skipped-archived`,
`skipped-fork`, `skipped-disabled`, or `skipped-limit`. The legacy
`not-express` spelling is retained for artifact compatibility and means no
supported framework was detected only when acquisition, discovery, and source
scanning are complete. Incomplete negative evidence is `inconclusive`.

Each detected framework also has a separate `classification` so status does not
overstate what package evidence proves. Roles are `application`,
`platform-adapter`, `route-provider`, `runtime-dependency`, `peer-dependency`,
`development-dependency`, or `dependency-only`. The classification includes its
confidence, contributing signals, and counts of direct dependency declarations
by `package.json` field. Aggregate summaries therefore report
`applicationRepositories` separately from `dependencyOnlyRepositories`, and the
HTML renderer labels a dependency-only detail page as evidence rather than an
application report.

`--fail-on incomplete` exits `2` when API pagination, the repository limit, a
repository failure/inconclusive result, per-repository source coverage, a
partial or opaque route graph, or a requested baseline comparison makes the
evidence incomplete. Filters for archived/fork repositories are intentional
scope choices and do not by themselves make coverage incomplete.

Supplying auth/policy/OpenAPI configuration applies the same configuration to
every repository and turns each embedded report into an audit when applicable.
Use this only for genuinely shared middleware conventions; names alone remain
insufficient evidence.

### `render`

Render existing machine-readable artifacts as a browsable offline HTML site:

```bash
# From a repository with exactly one saved output under .express-recon/.
express-recon render

express-recon render --input .express-recon/acme \
  --out .express-recon/acme-site

# Reconstruct change views from two already-saved organization outputs.
express-recon render --baseline .express-recon/acme-before \
  --input .express-recon/acme-current \
  --out .express-recon/acme-changes-site

# Render a standalone OpenAPI 3 or Swagger 2 document with local Swagger UI assets.
express-recon render --input .express-recon/docs/openapi.json \
  --out .express-recon/api-reference
```

Both paths are optional in the CLI. Without `--input`, `render` examines only the
current directory, `.express-recon/` itself, and immediate child directories of
`.express-recon/`. A candidate directory must contain a conventional input file.
Exactly one candidate is required: no match or multiple saved outputs fail
instead of triggering a recursive search or an arbitrary choice. Symbolic or
non-regular auto-detected inputs are rejected. Pass `--input` to select a direct
`routes.json`, `repo-scan.json`, `organization-inventory.json`, OpenAPI 3, or
Swagger 2 JSON/YAML path, or any directory containing one.

Within a selected directory, detection prefers the organization aggregate, then
a repository scan, then a route report, followed by `openapi.json`,
`openapi.yaml`, `openapi.yml`, `swagger.json`, `swagger.yaml`, and `swagger.yml`.
Without `--out`, a directory input renders to the sibling `<input>-html`; a
direct conventional filename renders from its parent to `<parent>-html`; any
other direct filename renders beside it as `<stem>-html`. Explicit paths are
recommended in CI even though either option can be omitted independently.
Conventional files from one input folder share the same derived site; use
`--out` to retain multiple views at once.
`render` never scans source, acquires a repository, executes target code,
contacts the network, or invokes a model.

Optional `--baseline` accepts a prior organization report or output directory
and computes the same bounded delta while rendering, so two existing scans can
be compared without another GitHub request. It is rejected for repository or
single-route/OpenAPI inputs.

The output contains:

- `index.html`, with route/repository search and status filtering;
- `repositories/<name>.html` for confirmed supported repositories and
  inconclusive scans with an available detailed artifact; definite unsupported,
  skipped, empty, and failed entries remain index-only;
- local `assets/report.css` and `assets/report.js` with no CDN dependency;
- for a standalone OpenAPI 3 or Swagger 2 input, the packaged Swagger UI CSS/bundle, its
  license notices, and a safely serialized local configuration asset instead of
  report assets;
- for a repository or organization input, `openapi/<name>.html` plus a local
  configuration script for each retained OpenAPI 3 or Swagger 2 specification
  attached to a confirmed supported entry; those pages share one packaged
  Swagger UI bundle, while unsupported entries never produce API pages;
- `organization-delta.json` plus overview metrics and per-repository route
  changes when the organization input contains baseline evidence; and
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

OpenAPI pages use stock Swagger UI. express-recon embeds the parsed document as a
local JavaScript object; HTML-significant characters are escaped during
serialization. `supportedSubmitMethods` is empty, `tryItOutEnabled` and query
configuration are disabled, credentials are not persisted, and the online
validator is disabled. The page CSP sets `connect-src 'none'`, so server URLs and
external `$ref` targets cannot be contacted. A self-contained/bundled spec is
therefore required for complete offline schema rendering. Swagger 2 is viewable
but remains unsupported as a documentation-reconciliation base.

HTML is a human review projection, not a new evidence schema. Automation and AI
agents should continue consuming the original JSON contracts.

### `help`

Prints the same complete help text as `--help`/`-h` and exits `0`. `--version`
and `-V` print only the installed package version.

### `schema`

Print the report JSON Schema to stdout:

```bash
express-recon schema > express-recon-report.schema.json
```

## CLI option index

The command-specific sections above describe behavior and artifacts. This table
is the complete option surface; unsupported command/option combinations fail
instead of being ignored.

| Option               | Commands                                                  | Purpose                                                                                                            |
| -------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--mode`             | `inventory`, `audit`, `suggest-auth`, `review-middleware` | Select `static`, `runtime`, or `hybrid`; defaults to `static`.                                                     |
| `--src`              | Local discovery/inventory/audit/docs/review commands      | Set the source root; defaults to the current directory.                                                            |
| `--app`              | Runtime/hybrid inventory, audit, suggestion, or review    | Select a trusted application module or `auto`.                                                                     |
| `--allow-exec`       | Commands accepting `--app auto`                           | Confirm that automatic trusted target-code execution is allowed.                                                   |
| `--app-id`           | Hybrid inventory/audit, `docs`, `scan-repo`               | Select one application; `docs`/`scan-repo` also accept deliberate `all`.                                           |
| `--spec`             | `docs`, `scan-repo`                                       | Select an existing OpenAPI 3 input.                                                                                |
| `--jsdoc`            | `docs`, `scan-repo`                                       | Add an annotation source; repeatable.                                                                              |
| `--review`           | `import-review`                                           | Read the exact middleware-review bundle being assessed.                                                            |
| `--assessment`       | `import-review`                                           | Read the JSON/YAML assessment response.                                                                            |
| `--input`            | `render`                                                  | Select a report/API-specification file or output directory; otherwise require one bounded auto-detected candidate. |
| `--repo`             | `scan-repo`                                               | Select a GitHub shorthand, HTTPS Git URL, or local Git repository.                                                 |
| `--org`              | `scan-org`                                                | Select the GitHub organization login.                                                                              |
| `--ref`              | `scan-repo`                                               | Select a branch, tag, or commit; defaults to remote `HEAD`.                                                        |
| `--max-repos`        | `scan-org`                                                | Bound selected repositories to 1–10,000; defaults to 100.                                                          |
| `--concurrency`      | `scan-org`                                                | Process 1–8 source snapshots at once; defaults to 1.                                                               |
| `--resume`           | `scan-org`                                                | Continue a compatible checkpoint in the selected or default output.                                                |
| `--overwrite`        | `scan-org`                                                | Start fresh while replacing only owned/colliding artifacts.                                                        |
| `--progress`         | `scan-org`                                                | Select `auto`, `plain`, `json`, or `none` stderr progress.                                                         |
| `--no-progress`      | `scan-org`                                                | Alias for `--progress none`.                                                                                       |
| `--include-archived` | `scan-org`                                                | Include archived repositories.                                                                                     |
| `--include-forks`    | `scan-org`                                                | Include organization forks.                                                                                        |
| `--config`           | All scanning commands except `render`                     | Load validated JS/JSON/YAML configuration.                                                                         |
| `--format`           | Output-producing commands except `render`/`schema`        | Select a supported command-specific format.                                                                        |
| `--out`              | Commands with file artifacts                              | Write artifacts to a directory; `render` derives `<input>-html` and `scan-org` derives `.express-recon/<org>`.     |
| `--baseline`         | `inventory`, `audit`, `scan-org`, `render`                | Compare a prior compatible report/output; organization scans use their selected/default output.                    |
| `--fail-on`          | `audit`, `docs`, `scan-org`                               | Exit 2 when a supported quality-gate status matches.                                                               |
| `--include`          | Static/discovery/repository/organization commands         | Add a root-relative source allowlist glob; repeatable.                                                             |
| `--exclude`          | Static/discovery/repository/organization commands         | Add a root-relative source exclusion glob; repeatable.                                                             |
| `--ignore-file`      | Static/discovery/repository/organization commands         | Select a scope file, resolved from each scan root when relative.                                                   |
| `--no-ignore-file`   | Static/discovery/repository/organization commands         | Disable the configured/default scope file.                                                                         |
| `--include-tests`    | Static/discovery/repository/organization commands         | Opt test paths into the scan.                                                                                      |
| `--include-hidden`   | Static/discovery/repository/organization commands         | Opt hidden paths into the scan, excluding fixed VCS/vendor/build paths.                                            |
| `--version`, `-V`    | Global                                                    | Print the installed package version without running a command.                                                     |
| `--help`, `-h`       | Global                                                    | Print onboarding, command, option, trust, and exit-code help.                                                      |

## Environment variables

| Variable                | Behavior                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `EXPRESS_RECON_CONTEXT` | `agent`, `ci`, `interactive`, or `auto`; changes safe organization progress/output defaults but never scan evidence. |
| `GH_TOKEN`              | Preferred GitHub API and private-fetch token for repository/organization scans.                                      |
| `GITHUB_TOKEN`          | Fallback when `GH_TOKEN` is unset.                                                                                   |
| `EXPRESS_RECON_DRY`     | Set to `1` automatically inside the trusted runtime worker before importing the target app.                          |

Tokens are sent through scoped process environment/configuration rather than
rendered in command arguments or reports. Explicit CLI progress flags override
context defaults.

## Artifacts and exit codes

Commands accepting `--out` create directories as needed. `scan-org` also creates
its default `.express-recon/<lowercase-organization>` hierarchy when omitted.
Existing regular artifact files may be replaced, but the CLI refuses symbolic
links and non-regular files at generated artifact paths. Organization scans also
reject unsafe `repositories/` output directories before GitHub enumeration.

| Command                   | Artifact(s)                                                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discover`                | `discovery.json`                                                                                                                                                                                                                      |
| `inventory` / `audit`     | `routes.json`, `routes.md`, and/or `openapi.json` according to `--format`                                                                                                                                                             |
| `docs`                    | `openapi.json`, `docs-report.json`                                                                                                                                                                                                    |
| `review-middleware`       | `middleware-review.json`                                                                                                                                                                                                              |
| `import-review`           | `middleware-suggestions.json`                                                                                                                                                                                                         |
| `scan-repo`               | `repo-scan.json`, `discovery.json`, `routes.json`; retained API contracts under `specifications/`; canonical OpenAPI/docs report when mergeable                                                                                       |
| `scan-org`                | `organization-inventory.json`; optional bounded `organization-delta.json`; per-repo scan, discovery, routes, specification catalogs, and mergeable docs under `repositories/<name>/`; `organization-checkpoint.json` while incomplete |
| `render`                  | `index.html`, local report and/or shared Swagger UI assets, `render-manifest.json`, optional copied organization delta, repository pages, and one supported-framework API page per retained OpenAPI 3/Swagger 2 contract              |
| `suggest-auth` / `schema` | JSON on stdout                                                                                                                                                                                                                        |

`pretty` is terminal-oriented and is not written as an artifact. Supported
inventory/audit formats are `pretty`, `json`, `md`, and `openapi`; formats may
be comma-separated.

Exit codes:

| Code | Meaning                                                            |
| ---: | ------------------------------------------------------------------ |
|  `0` | Command completed and no requested gate matched.                   |
|  `1` | Invalid CLI/config input or operational failure.                   |
|  `2` | Command completed, but at least one `--fail-on` condition matched. |

Diagnostics go to stderr and remain in machine reports where applicable. JSON
and OpenAPI stdout remain parseable even when a gate exits `2`. `scan-org`
progress also uses stderr; select `--progress json` when the stderr channel must
itself be machine-readable.

## Configuration

`--config` accepts CommonJS (`.js`/`.cjs`), JSON, or YAML. JSON/YAML is data-only
and preferred for untrusted/static workflows. JavaScript config executes with
the invoking user's permissions. Unknown fields fail instead of being ignored.

Top-level keys:

| Key              | Purpose                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `authMiddleware` | Confirmed middleware-to-auth grant mapping.                        |
| `authWrappers`   | Wrappers proven to always execute/preserve their inner middleware. |
| `acceptedPublic` | Reviewed intentionally unauthenticated routes.                     |
| `policies`       | Deterministic route requirements and expiring exceptions.          |
| `openapi`        | Explicit security schemes and auth-tag mappings.                   |
| `scan`           | Scope and resource limits.                                         |
| `boot`           | Trusted runtime/hybrid worker settings.                            |

A top-level JSON/YAML array is shorthand for `{ policies: [...] }`.

### Complete configuration field index

These are all accepted configuration keys. Paths containing `[]` describe each
array item; `<name>` is a user-selected middleware key. Unknown keys at any
validated level fail closed.

| Area                 | Accepted fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Top level            | `acceptedPublic`, `authMiddleware`, `authWrappers`, `boot`, `openapi`, `policies`, `scan`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Auth grant           | `authMiddleware.<name>.tag`, `authMiddleware.<name>.tags`, `authMiddleware.<name>.roles`, `authMiddleware.<name>.scopes`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Accepted-public item | `acceptedPublic[].applicationId`, `acceptedPublic[].method`, `acceptedPublic[].path`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| OpenAPI              | `openapi.securityByTag`, `openapi.securitySchemes`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Scan                 | `scan.exclude`, `scan.ignoreFile`, `scan.include`, `scan.includeHidden`, `scan.maxFileBytes`, `scan.maxFiles`, `scan.maxTotalBytes`, `scan.timeoutMs`                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Runtime boot         | `boot.env`, `boot.inheritEnv`, `boot.maxOutputBytes`, `boot.sandbox`, `boot.settleMs`, `boot.stubModules`, `boot.timeoutMs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Policy               | `policies[].id`, `policies[].description`, `policies[].severity`, `policies[].match`, `policies[].require`, `policies[].exceptions`, `policies[].message`, `policies[].recommendation`                                                                                                                                                                                                                                                                                                                                                                                                             |
| Policy selector      | `policies[].match.applicationIds`, `policies[].match.methods`, `policies[].match.paths`, `policies[].match.excludePaths`, `policies[].match.authStatuses`, `policies[].match.tags`, `policies[].match.roles`, `policies[].match.scopes`                                                                                                                                                                                                                                                                                                                                                            |
| Policy requirement   | `policies[].require.auth`, `policies[].require.anyMiddleware`, `policies[].require.allMiddleware`, `policies[].require.noMiddleware`, `policies[].require.middlewareOrder`, `policies[].require.anyTag`, `policies[].require.allTags`, `policies[].require.noTags`, `policies[].require.anyRole`, `policies[].require.allRoles`, `policies[].require.noRoles`, `policies[].require.anyScope`, `policies[].require.allScopes`, `policies[].require.noScopes`, `policies[].require.roles`, `policies[].require.scopes`, `policies[].require.all`, `policies[].require.any`, `policies[].require.not` |
| Policy exception     | `policies[].exceptions[].id`, `policies[].exceptions[].reason`, `policies[].exceptions[].expires`, `policies[].exceptions[].match`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

`roles` and `scopes` in a requirement are concise aliases for `allRoles` and
`allScopes`. Nested `all`, `any`, and `not` values use the same complete
requirement field set, with a maximum expression depth of 12.

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
Accepted-public and policy method selectors support `GET`, `POST`, `PUT`,
`PATCH`, `DELETE`, `HEAD`, `OPTIONS`, `TRACE`, and `ALL`.

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
  includeHidden: false # true opts into paths such as .cursor/
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

Dependency, VCS, build, hidden, and test paths are excluded by default.
`--include-hidden` or `scan.includeHidden: true` opts hidden directories such as
`.cursor/` into local and remote materialization, discovery, and source scans;
`.git` and built-in dependency/build outputs remain excluded. Treat this as an
intentional scope expansion because hidden paths may contain private tooling or
configuration. Test directories include `test`, `tests`, `testcases`, `spec`,
`specs`, `__tests__`, and `__mocks__`; `--include-tests` opts them and
`*.test.*`/`*.spec.*` files in.

Limits are applied in deterministic path order. Parse/read/traversal failures or
limits set coverage `complete: false` and add diagnostics. Do not convert an
incomplete result into a clean bill of health by filtering out its diagnostics.

## Runtime boot options

Runtime/hybrid is Express-only and for trusted local code only.

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

Complete top-level field index:

| Field                                                                                                   | Presence                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`, `tool`, `toolVersion`, `command`, `mode`, `applications`, `routes`, `globalMiddleware` | Required on every route report.                                                                                  |
| `target`, `configHash`, `diagnostics`, `routeGraph`, `scanCoverage`, `openapi`                          | Included when the corresponding target, configuration, uncertainty, graph, coverage, or OpenAPI evidence exists. |
| `summary`, `policies`, `policyExceptions`, `findings`                                                   | Audit-only judgment and policy evidence.                                                                         |
| `delta`                                                                                                 | Included when a compatible `--baseline` is supplied.                                                             |

Important fields:

- `configHash`: SHA-256 of canonical analysis config, without embedding config.
- `applications[]`: stable ID, `framework`, underlying `adapter` (`express`,
  `fastify`, or `unknown`), source, route count, and global lifecycle middleware.
- `routes[].framework`: `express`, `fastify`, or `nestjs` for current scans.
- `routes[].applicationId`: app identity or `null` for unresolved/orphan routes.
- `routes[].source`: repository-relative file and line when known.
- `routes[].io`: best-effort request/response/handler hints from static analysis.
  The compatible `request` field-name arrays, `responses[].bodyKeys`, and
  `statusCodes` remain available. Optional `io.schemas.request` and
  `io.schemas.responses` contracts add bounded JSON Schema, evidence kind,
  confidence, and source. `io.schemas.conflicts` keeps type, requiredness, and
  constraint disagreements, or fields seen by weaker evidence but absent from a
  stronger schema.
- `routes[].pathConfidence`: `full` or `partial`.
- `routes[].middlewares[].stage`: optional lifecycle role (`middleware`, `hook`,
  `guard`, `interceptor`, `pipe`, or `filter`) when the source API proves it.
- `routes[].authStatus`, tags, roles, scopes, and `authEvidence`: audit only.
- `routes[].presence` and `observations`: hybrid evidence (`both`,
  `static-only`, `runtime-only`) without discarding either scanner's view.
- `scanCoverage`: discovered/analyzed/failed/skipped counts, bytes, limit flag,
  `complete`, and portable `scope` evidence. Scope includes normalized
  include/exclude values, test selection, ignore-file presence/rule count/content
  hash, built-in exclusions, and an effective-scope fingerprint. Absolute ignore
  paths are represented as `<external>/<basename>` rather than leaked.
- `routeGraph`: whether every emitted route was assigned to an app and resolved
  to a full path, plus `orphanRoutes`, `partialRoutes`, `registrarRoutes`, and
  evidence for possible opaque route-provider mounts. A false `complete` value
  prevents documentation-only operations from being asserted stale without
  further evidence and matches `--fail-on incomplete`.
- `summary`, `findings`, normalized `policies`, and applied
  `policyExceptions`: audit only.
- `delta`: comparison with `--baseline`.

Finding types:

| Finding             | Meaning                                                    |
| ------------------- | ---------------------------------------------------------- |
| `public-route`      | No configured authentication guard matched.                |
| `opaque-middleware` | A possible guard is opaque; manual review required.        |
| `per-verb-gap`      | Methods on the same app/path have different auth states.   |
| `stale-baseline`    | An accepted-public entry no longer matches a public route. |
| `policy-violation`  | A configured route requirement failed.                     |

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
`.cts` with no type-check, dependency installation, framework import, or build.
Because transpiler-based projects commonly place JSX in `.js`, a failed `.js`
parse is retried with JSX grammar before coverage is marked incomplete. All
adapters share the same file/byte/time limits and common route contract.
TypeScript `.d.ts`, `.d.mts`, and `.d.cts` declaration files are excluded
because they cannot register runtime routes.

Express resolution includes:

- separate `express()` roots and `express.Router()` bindings, including
  route-less listening apps, immutable aliases of `require`, and inline
  `require("express")()` factories;
- `app.METHOD()`, `router.METHOD()`, `route().all().get()` chains, and arrays of
  literal paths;
- cross-file mounts, resolvable direct registrar calls, and middleware
  registration order;
- same-file string constants, concatenation, and template paths;
- `require`, ESM import, package `#imports`, nearest-package `tsconfig` paths and
  `baseUrl`, NodeNext `.js` specifiers targeting TypeScript source, and common
  barrel re-exports;
- path-scoped middleware, configured transparent wrappers, and one-hop
  controller handler hints.

Fastify resolution includes:

- `fastify()`/`Fastify()` roots and shorthand methods including `trace`;
- `route({ method, url, handler })`, including static method/path arrays;
- local, imported, CommonJS, ESM, and `fastify-plugin`-wrapped plugins;
- nested `register()` prefixes, direct functions receiving a local Fastify
  instance, call-site propagation for imported plugin arguments, encapsulated
  request-stage hooks, registration order, duplicate source-site suppression,
  and `fastify-plugin` transparency (including its ignored prefix rule);
- known hook/decorator-only packages such as the Fastify CORS and Helmet plugins
  do not make route coverage opaque, while unknown or route-providing plugins
  remain fail-visible;
- `onRequest`, `preParsing`, `preValidation`, and `preHandler` evidence at
  plugin and per-route scope; and
- handler request/response hints where the function is statically resolvable;
  plus static `body`, `querystring`/`query`, `params`, `headers`, and per-status
  `response` schemas from route options.

NestJS resolution includes:

- official `@nestjs/common`/`@nestjs/core` decorators, `NestFactory.create()`,
  default or named module exports, module/controller graphs, NodeNext source
  resolution, and Express versus Fastify platform adapters;
- repository-local workspace package imports and statically returned
  `register()`/`forRoot()` dynamic-module metadata;
- controller and method paths, static arrays, global prefixes, and
  `RouterModule.register()` prefixes;
- global/controller/method guards, interceptors, pipes, and filters, including
  `APP_GUARD`, `APP_INTERCEPTOR`, `APP_PIPE`, and `APP_FILTER` providers;
- `MiddlewareConsumer.apply().exclude().forRoutes()` for static controller,
  path, and `RequestMethod` scopes; and
- decorated request fields, `HttpCode`, default response codes, and returned
  object shapes as bounded handler hints; and
- TypeScript parameter/property types, local or one-hop imported DTOs,
  `class-validator` constraints, and `@nestjs/swagger` property metadata.

Express handler I/O additionally recognizes same-file Zod/Joi schemas used by
`parse`, `safeParse`, `validate`, or `validateAsync`, route-level
`express-validator` chains and `checkSchema()`, nested field paths, direct
request reads, and literal response shapes. Static validator interpretation is
bounded and never imports or executes the validation package. Dynamic schema
factories, arbitrary refinements/transforms, conditional validation, and
unsupported helper composition remain open evidence for review.

The scanner retains partial or opaque evidence for dynamic/data-driven
registration, registrar functions, computed paths/scopes, unresolved dependency
injection, bare-package routers/plugins, Nest host/version routing and global
prefix exclusions, and unsupported resolution chains. A dynamic Nest middleware
scope becomes opaque `unknown` middleware so it cannot falsely prove a route
public or authenticated. `tsconfig extends` chains are not followed. Express
regex/computed guard scopes are conservatively treated as host-wide rather than
used to prove a route public. Standalone Fastify plugin routes without a local
root are retained as partial evidence when the function uses a conventional
`fastify`/`server`/`instance` parameter, a `*Plugin` name, or another
Fastify-specific API; otherwise an ambiguous `(app) => app.get(...)` registrar
keeps the legacy Express interpretation. A generic `.route()` call alone is not
Fastify evidence, which avoids classifying browser-automation APIs such as
`page.route()` as server routes.

### Runtime mode

Runtime is Express-only. It walks the trusted app that actually booted and can
observe dynamic registration. Source and mount paths are strongest when
instrumentation captured the registration. Pure runtime has no static
`scanCoverage`.

### Hybrid mode

Hybrid is Express-only and combines static breadth/source hints with runtime wiring. It matches by
application identity, exact route, registration source, or unambiguous partial
suffix. Runtime middleware/auth is authoritative only for a confirmed pair.
Ambiguous duplicate paths, shared-router sources, or unsourced observations stay
separate instead of being assigned to the first app.

## Library API

```js
const recon = require("express-recon");
```

The [complete library API](./api.md) documents the signature, return contract,
and trust boundary of every public export. The overview below highlights how
the main primitives compose.

Primary exports:

- `discover(root, options)`
- `inventory(options)`
- `audit(options, config)`
- `suggestAuth(registry)`
- `buildReport(registry, metadata)`
- `compareReports(before, after)`
- `compareOrganizationReports(before, after, loaders)`
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
Static mode supports Express, Fastify, and NestJS and requires `src`. Hybrid
also requires `src`, but hybrid/runtime observation is Express-only. Direct
runtime library use accepts an already loaded Express `app`, which has already
executed in the caller. CLI-style worker use is:

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

- `onRepository({ repository, status, frameworks, express, coverageComplete, routeGraphComplete, scan })`
  can persist a completed detailed scan immediately. `express` remains as a
  compatibility projection; `frameworks` is the framework-neutral evidence;
  the two completeness fields distinguish readable source from a fully resolved
  route graph;
- `onProgress(event)` synchronously observes the versioned organization events
  listed under [Progress and CI logs](#progress-and-ci-logs), including
  repository phases and monotonic counters;
- `retainScans: false` keeps only compact aggregate evidence after that callback.
- `resumeEntries` accepts previously validated, complete compact entries and
  requires `retainScans: false`; matching repositories are not reacquired.

Concurrency defaults to one and is capped at eight. The callback runs after the
repository snapshot has already been removed. The CLI's selected/default output
uses both streaming controls; library callers should do the same for large organizations. The
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

`compareOrganizationReports()` compares two aggregate contracts. Supply
`loadBaselineScan(entry)` and `loadCurrentScan(entry)` callbacks to enable exact
route comparison for common complete supported repositories; callbacks should
return the corresponding `repository-scan` object. Without loaders, aggregate
repository/status/count changes are still returned, while required exact
comparisons are marked incomplete instead of silently treated as unchanged.

`renderHtmlSite()` is synchronous and returns the render manifest plus the
absolute `index.html` path. It accepts the same file or directory inputs as the
CLI `render` command and writes a deterministic, offline site without changing
the input artifacts. Pass `{ baseline: priorPath }` as its third argument to
compare two organization outputs while rendering.

## Related guides

- [README and quickstart](../README.md)
- [Complete library API](./api.md)
- [AI agent guide](./ai-agent-guide.md)
- [OpenAPI guide](./openapi.md)
- [Security model](../SECURITY.md)
- [Contributing](../CONTRIBUTING.md)
