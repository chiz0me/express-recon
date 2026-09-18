# Changelog

## 0.21.1

- Reuse unchanged framework classifications with structural uncertainty, including
  submodules, symlinks and bounded-tree or manifest limits. They remain incomplete
  and eligible for scanning; transient probe failures are still retried.
- Preserve live commit checks and explicit `--reclassify` full refreshes, avoiding
  repeated expensive probes that cannot resolve an unchanged source limitation.

## 0.21.0

- Add `scan-org --classification-snapshot` and the `classificationSnapshot` API
  option to share one completed classification pass across a pipeline. Scan the
  recorded commits without repeating enumeration or classification requests.
- Validate snapshot scope and classifier compatibility, retain uncertain candidates
  and partial coverage, and reject unfinished snapshots before resetting scan output.

## 0.20.0

- Add persistent, commit-verified organization framework classification and
  JavaScript/Gin scan plans, including nested and mixed-framework repositories.
- Let `scan-org --classification-cache` avoid provably irrelevant repositories
  and reuse classification during fresh route scans. Unknown inputs remain eligible.
- Save classification after each repository and report cache invalidation and
  probe costs independently from route/audit checkpoints.

## 0.19.1

- Give organization scan phases independent bounded watchdog budgets so slow
  acquisition does not prematurely terminate healthy analysis or documentation.
  Report the stalled phase and timeout; repeated progress cannot extend a deadline.
- Materialize source snapshots with bounded Git blob batches instead of spawning
  Git once per file. Preserve byte/count/deadline limits, authentication isolation,
  exact binary content, and conservative partial-coverage reporting.
- Add synthetic slow-worker, stuck-worker, batched-read and malformed-output
  regression tests without internal source or organization-specific fixtures.

## 0.19.0

- Resolve declarative package `_moduleAliases`, import-then-export ESM barrels,
  and bounded static `Object.keys(routes).forEach(...)` mounts. Keep unknown,
  mutated, conditional, and oversized route maps fail-visible.
- Connect imported factories returning Express apps to subsequent mounts, keep
  separate factory instances isolated, and retain uncertainty for dynamic paths
  and ambiguous factory returns.
- Avoid false Fastify registration gaps from ordinary `.register()` methods
  and unrelated callbacks whose parameter happens to be named `server`.
- Select NestJS dynamic-module metadata from the called registration method,
  including async variants, rather than merging unused factory methods.
- Advance organization scan evidence to generation 5 so resume/update rescans
  older results. Generation 4 remains readable and integrity-checked for offline
  rendering; independent domain sidecars and accepted enrichment remain intact.
- Cover new resolution paths and conservative failure behavior with synthetic
  regression tests; no application source or organization-specific fixtures.

## 0.18.0

- Redesign organization reports around route-level results. Related statistics
  now combine raw counts and percentages, documentation overlap is attributed to
  authored OpenAPI, Swagger, and JSDoc evidence, and invalid specifications move
  into a collapsed section below the repository tables.
- Sort repositories by descending route count by default, add independent
  repository/domain/status/framework filters, and keep wide tables readable with
  responsive labelled rows. Supported repositories with no discovered routes
  are collapsed separately so incomplete scans with route evidence stay visible.
- Load an independently maintained `domain-inventory.json` sidecar from an
  organization scan folder. Reports include deduplicated deployment hosts,
  repository evidence, a joined render artifact, and conservative OpenAPI server
  enrichment without rewriting source scans or specifications.
- Preserve domain inventory and reviewed binding sidecars across organization
  update, resume, and overwrite workflows while keeping them outside the native
  scan integrity manifest.

## 0.17.4

- Separate retained invalid source specifications from saved-file access errors.
  Organization HTML shows “Invalid API specifications” with specification and
  repository counts, collapsed repository/cause groups, and deduplicated messages.
  “Artifact warnings” is reserved for saved-file problems; other notices are separate.
- Add deduplicated structured `diagnostics` and `diagnosticSummary` to render
  results/manifests and saved-state validation. CLI summaries include category
  counts while preserving existing warning fields for consuming tools.
- Publish the additive diagnostics JSON Schema and document exact fields, count
  semantics, display limits, and v0.17.3 integration compatibility.
- Verify native organization integrity manifests before rendering. Invalid raw
  source files remain retained and excluded from API viewers; hash failures and
  invalid generated/enriched specifications remain fatal. Failed renders preserve
  the existing site.

## 0.17.3

- Validate retained OpenAPI/Swagger references during repository scans. Invalid
  source specifications are retained byte-for-byte with structured diagnostics,
  excluded from API viewers, and shown as warnings without blocking offline
  organization validation or rendering. They still mark coverage incomplete.
- Keep integrity manifest coverage for invalid raw artifacts and strict validation
  for generated OpenAPI and accepted enrichment. Reference errors identify the
  repository, application when known, original source, saved artifact, and reference.
- Checkpoint successfully processed repositories with incomplete coverage. Resume
  preserves their status, verifies artifact hashes and the current source commit,
  and retries operational failures, interrupted work, or incompatible evidence.
  Changed configuration or scan scope invalidates reuse. Legacy retained-spec
  checkpoints are rescanned to establish reference-validation metadata.
- Report up to 20 oversized file paths per repository, their byte sizes, the
  configured `scan.maxFileBytes`, and the count of additional omitted entries.
- Show artifact warnings and acquisition diagnostics in offline HTML reports.

Earlier release notes are available in the
[GitHub releases](https://github.com/chiz0me/express-recon/releases).
