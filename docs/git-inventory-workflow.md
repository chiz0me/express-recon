# Git-backed inventory and enrichment

Keep source-reading credentials in the scan job, and publication credentials in a
separate job. Express Recon does not choose your inventory branch, commit changes,
open PRs, or publish documentation. All paths below are examples you can replace.

## CI: scan and save evidence

GitHub App authentication requires `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, and
`GITHUB_APP_PRIVATE_KEY`. The private key may contain actual PEM newlines or escaped
`\n` sequences. Supply it through your CI secret store; do not commit it or echo it.
The installation needs repository metadata access and Contents: read for downloads.

```sh
express-recon scan-org --org acme --auth github-app --out inventory --progress json
express-recon validate --input inventory
```

Alternatively, supply `GH_TOKEN` or `GITHUB_TOKEN` and use `--auth token`. The default
`--auth auto` prioritizes complete App credentials over ambient tokens. Partial App
settings fail clearly; explicit token mode ignores App settings. An authentication
failure never changes identities automatically. With neither identity, token mode
can enumerate public repositories unauthenticated.

The parent scan process shares an installation-token provider between API requests
and repository acquisition workers. It renews tokens five minutes before expiry,
coalesces concurrent renewal, and redacts old and new tokens from diagnostics. App
private keys are not passed to scan workers or Git subprocesses. Workers receive
only the installation token needed for their bounded repository acquisition.

App scans verify that the installation belongs to the requested organization and
enumerate `/installation/repositories`, with pagination and the usual repository
filters. `coverage.enumeration.access.repositorySelection` reports `all` or `selected`.
`coverage.complete` means that the requested scan scope finished successfully;
selected installations clear their checkpoints and support `--update` normally.
`coverage.enumeration.organizationAccessComplete: false` separately records limited
organization visibility, and HTML retains a warning. PAT
coverage remains limited to what that token can see; it is not proof of all private
repositories being accessible.

See GitHub's [installation authentication guide](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
and [installation repository endpoint](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation).

Commit the entire inventory output, including `organization-manifest.json` and
referenced repository artifacts. A separate publication credential may write that
commit, but should not be reused as the source-reading credential.

## Developer: prepare from inventory and source

Clone the inventory repository and the matching source repository. Check out the
exact commit recorded in the inventory, then prepare a workspace:

```sh
express-recon prepare --input inventory --repo acme/api --src ../api \
  --out inventory/workspaces/api --app-id all
```

`all` creates a stable, independent subdirectory for every application. Omit
`--app-id` only when the repository has one application, or supply an exact ID from
its saved route report. App IDs remain source-relative; changing a checkout path
does not change identity. Changing an application's declaration identity requires
a new workspace, not guessing that unrelated applications are equivalent.

Preparation records `source.json` and the same provenance in the integrity-protected
refresh manifest: repository, commit, application, scan settings, settings hash,
tool version, and native report schema version. A GitHub `origin` identifying the
expected repository and an exact matching `HEAD` are required. Dirty, ignored, and
untracked working-tree files are not scanned: acquisition materializes the committed
snapshot. No target code is executed and dependencies are not installed.

New inventories contain portable scan settings. For older inventories, explicitly
supply the matching `--config` or rescan. An external ignore file is stored as bounded
content, so relocating the checkout does not invalidate a machine-specific path.
Refresh uses saved settings; use `prepare` again to deliberately change them.

When a repository contains multiple specifications, pass a source-relative
`--spec first.openapi.json` to `prepare`. Use repeatable `--jsdoc annotations.js`
to select annotation files explicitly. Both selections persist in the workspace.
Run `prepare` again with different selectors to change them: accepted enrichment
is preserved, and operations with changed generated evidence require review.

## Enrich, accept, and update

Edit an application's `openapi.json` using its source checkout and your preferred
assistant. Reports are evidence, not a replacement for implementation source.
Then accept the reviewed fields:

```sh
express-recon refresh --src ../api --out inventory/workspaces/api/app-ID \
  --accept-enrichment
express-recon validate --input inventory/workspaces/api/app-ID
```

Replace `app-ID` with the actual directory returned by `prepare`. For a single
selected application, `--out` is the workspace itself, without an added subdirectory.
Commit the entire workspace, not just the edited OpenAPI file.

When CI updates the inventory, check out the new source commit and run `prepare`
against the **existing** workspace. Accepted overlays are preserved. Changed evidence
is retained but excluded from current applied documentation until reviewed again.
Use the existing `--review-operation 'GET /path'` acceptance option for explicit
reapproval. `refresh-report.json` explains operation and schema review reasons.
To block CI on stale evidence, use `refresh --fail-on enrichment-stale`; the default
reports it without failing. Unreviewed operations have a separate
`enrichment-unreviewed` gate.

JavaScript/TypeScript source fingerprints ignore ordinary comments, source positions,
quote style, and formatting. Documentation comments are retained because they can
affect generated contracts. Meaningful changes in any referenced source file remain
conservative whole-file invalidations; unknown/unparseable dependencies use raw
bytes. Add `x-express-recon.enrichmentSources` relative file paths to an edited
operation when review depends on files not already present in scanner evidence.
These declared dependencies are verified on subsequent refreshes. This is not a
proof of arbitrary runtime dependency equivalence.

Old byte-based acceptance fingerprints may need one explicit reapproval after an
upgrade to semantic fingerprints. The overlay itself is not deleted. Future unknown
schema/evidence versions fail validation; pin package versions in CI and developers'
environments, inspect validation output, and upgrade through a normal review PR.

## Source-free validation and rendering

```sh
express-recon validate --input inventory
express-recon validate --input inventory/workspaces/api/app-ID
express-recon render --input inventory --out site --shared-assets
express-recon render --input inventory --out site --shared-assets --check
```

Validation requires no source checkout, credentials, network, or writes. It checks
saved contracts, referenced files, available integrity hashes, and self-contained
OpenAPI references. Legacy inventories without a complete hash manifest are explicitly
reported as `legacy-unhashed`; validation cannot reconstruct historical hashes.
Validate each application workspace separately as well as the organization inventory.

The renderer discovers native workspaces under the inventory's `workspaces` folder.
Use repeatable `--workspaces PATH` for other locations. It links applied OpenAPI and
accepted overlay evidence, labels older source/settings/review status, and leaves
original route counts unchanged. Invalid or ambiguous workspaces fail rendering
before replacing the prior site. Rendering and validation do not execute source or
obtain credentials.

`render --check` returns 0 when current and 2 when missing/outdated, lists changed
files, and does not create directories, locks, temporary files, or modify output.
Supply the same rendering options used to generate the site. It compares owned
generated files, not unrelated files. Text output has final newlines and no trailing
whitespace; inline content is normalized **before** CSP hashes are calculated.

`--shared-assets` uses one self-contained OpenAPI viewer per organization, with
embedded specifications selected by its local link. This avoids repeating the large
Swagger UI bundle in every application HTML page while retaining direct `file:`
viewing. Default rendering still creates independent self-contained API pages.

## Incomplete scans and failed updates

Keep incomplete inventory artifacts and their checkpoint. A scan that exits with
`--fail-on incomplete` (exit code 2) still saves an inventory that can be validated
and rendered offline. Use `scan-org --resume` to continue it, or `scan-org --update` for subsequent
inventory updates; existing checkpoint and compatibility checks decide which evidence
can be reused safely. Repository visibility restrictions remain explicit even when
every accessible repository has been scanned.

Resume checkpoints every successfully processed repository with integrity-checked
artifacts, including incomplete results caused by symlinks, submodules, parser
errors, file limits, or invalid source specifications. Reuse preserves incomplete
coverage: it does not turn those results into complete scans. Interrupted work,
operational failures, and damaged artifacts are retried. Unchanged eligible entries
are checked against the current GitHub commit before reuse, using the same renewing
token provider. Changed commits, push markers, default branches, configuration,
scope, or evidence compatibility cause a rescan. If revision verification fails,
the repository is scanned again instead of trusting stale evidence.

Deterministic coverage gaps may continue to produce exit code 2 after resume.
Fix the source and commit it, adjust scan settings, or use `--overwrite` to force
a fresh scan. Oversized-file diagnostics contain up to 20 repository-relative
paths, file sizes in bytes, and `scan.maxFileBytes` (default 5 MiB), plus an omitted
entry count. No file contents are included in these diagnostics.

For a selected installation left with a checkpoint by v0.17.0, run `--resume` once
with v0.17.1 to finish it; subsequent runs can use `--update`.

### Invalid retained source specifications

Repository-owned OpenAPI and Swagger files are untrusted source evidence, not
express-recon-generated contracts. During scanning, the catalog checks their
renderable structure, OpenAPI schema where applicable, and internal references.
Unresolved or external references are never silently repaired or fetched.

An invalid catalog entry has `status: "invalid"` and a `diagnostic` containing
`code: "invalid-source-specification"`, `message`, `repository`, `sourcePath`, and
the saved `artifactPath`; `reference` and `applicationId` are included when known.
The raw file is retained byte-for-byte and remains covered by the organization
integrity manifest and checkpoint hashes. Invalid files mark repository coverage
incomplete, but do not block `validate --input` or `render --input`. Validation
reports warnings, and HTML shows the diagnostic without loading the file into
the API viewer. Valid source contracts remain viewable.

Generated OpenAPI, reconciled contracts, and accepted enrichment workspaces still
require valid references; they cannot opt into the retained-source exception.
Changing any retained raw artifact still fails integrity validation.

### Diagnostic output contract (v0.17.4+)

`renderHtmlSite()` / `checkHtmlSite()` results and `render-manifest.json` add
`diagnostics` and `diagnosticSummary`. Saved-state loaders add the same fields
inside `validation`. The machine-readable `validate` CLI also places
`diagnosticSummary` at the top level; the `render` CLI includes that summary but
leaves full details in the render manifest and HTML. Existing CLI fields and exit
codes are unchanged.

Every diagnostic contains these required fields:

| Field           | Type           | Meaning                                                                                  |
| --------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `code`          | string         | `invalid-source-specification`, `artifact-unavailable`, or `render-warning`              |
| `category`      | string         | `invalid-api-specification`, `artifact`, or `render`, respectively                       |
| `repository`    | string or null | Repository identity when known                                                           |
| `applicationId` | string or null | Associated application when known                                                        |
| `sourcePath`    | string or null | Original repository-relative source path                                                 |
| `artifactPath`  | string or null | Saved-file path relative to the inventory/input root, not a GitHub Actions artifact name |
| `message`       | string         | Complete recorded diagnostic message                                                     |

`reference` is an optional string containing the invalid reference, when recorded.
Invalid-spec diagnostics also include `cause`: `unresolved-reference`,
`external-reference`, `invalid-schema`, or `invalid-document`. The cause is a display
group inferred from the recorded v0.17.3-compatible message; it does not replace
the original evidence or change validation decisions. Other categories omit it.
The published schema is [report-diagnostics-v1.schema.json](../schemas/native/report-diagnostics-v1.schema.json).

The summary always includes all keys, including zero counts:

```json
{
  "total": 40,
  "byCategory": {
    "invalid-api-specification": 40,
    "artifact": 0,
    "render": 0
  },
  "invalidSpecifications": 40,
  "affectedRepositories": 6
}
```

The numbers above are illustrative. `total` and category counts count unique
diagnostics after exact deduplication of all structured fields. `invalidSpecifications`
counts unique `(repository, artifactPath)` identities (falling back to `sourcePath`
when no saved-file path exists); `affectedRepositories` counts distinct known
repositories with invalid specifications, case-insensitively. Several diagnostics
can describe one specification. Other categories do not affect these two counts.

The legacy `warnings` string array in render results/manifests and organization
`validation.warnings` remains available, including invalid-spec warning strings.
The render CLI retains its numeric `warnings` count. These legacy observations may
contain duplicates and must **not** be used as artifact-error counts. Consumers
should use `diagnosticSummary.byCategory` instead. Unclassified legacy integration
or comparison warnings use category `render`; real saved-file access errors use
category `artifact`.

HTML separates “Invalid API specifications”, “Artifact warnings”, and “Render
notices”. Invalid specifications are grouped by repository, cause, and exact
message; identical messages appear once per group with their associated source
paths, retained-copy paths, application IDs, and references. Repository and cause
details start collapsed. Each page displays at most 25 repository groups, 10 cause
groups per repository, and 100 detailed diagnostic entries overall. Displayed
messages are limited to 2,000 characters. Complete deduplicated diagnostics and
full messages remain in `render-manifest.json`, without those display limits.

For native inventories with an integrity manifest, rendering first runs strict
saved-state validation: missing/unsafe files, mismatched hashes, and invalid
generated or enriched contracts are fatal and leave the previous site intact.
Legacy/unhashed inputs retain best-effort rendering and report file problems under
“Artifact warnings”. A missing or unsafe raw copy is a file problem, not a retained
invalid-spec warning. Source invalidity itself remains non-blocking and does not
change coverage, raw bytes, hashes, viewer exclusion, or strict enrichment checks.

**Upgrading from v0.17.3:** no inventory migration, rescan, or re-acceptance is needed
for these reporting changes. Update the package pin to v0.17.4 and rerender the
existing inventory. Generated HTML/manifests change, so `render --check` reports
them outdated until regenerated. Allow the additive fields in strict consumer
models and use the category summary instead of parsing warning text. Input schemas
and the render-manifest `schemaVersion: "1.0"` remain unchanged; no source credentials
or checkouts are needed to validate or rerender.

To recover a v0.17.2 inventory affected by an invalid retained reference, upgrade
to v0.17.3 and run `scan-org --resume` against the saved checkpoint. Repositories
with older retained-spec metadata are rescanned once to establish the new status
and diagnostics. The old output is not silently rewritten by offline validation.

Workspace refreshes and HTML replacement use staged atomic updates. Verification or
render failures leave the prior workspace/site intact. Multi-application preparation
updates each application independently; rerun after resolving an application-specific
failure. Review and commit successful changes through your own PR process.

## Public library interfaces

`createGitHubTokenProvider(options)` returns `mode`, `getToken()`,
`verifyOrganization(login)`, and `redact(error)`. Library callers explicitly pass
`environment: process.env` or credential values; the library does not implicitly
read ambient credentials. Pass a shared `tokenProvider` to `scanOrganization` or
`listOrganizationRepositories`.

`prepareWorkspaces({ input, repository, root, output, applicationId?, scanSettings?, spec?, jsdoc? })`
and `refreshSourceWorkspace({ root, output, acceptEnrichment?, reviewOperations? })`
provide the native source-bound workflow. `applicationId: "all"` prepares every app.

`loadSavedState(input)` detects saved organization/workspace state;
`loadOrganizationInventory(input)` returns the validated report, root, scans map,
and integrity validation status. `loadRefreshWorkspace(output)` returns the validated
manifest, routes, generated/applied/baseline OpenAPI, enrichment, documentation report,
and refresh report. Only intentional editor/acceptance integrations should use its
`{ allowEditedOpenApi: true }` option; ordinary validation verifies every saved hash.

`checkHtmlSite(input, output, options)` is the read-only equivalent of
`renderHtmlSite(input, output, { ...options, check: true })`. Both return `current`
and `changedFiles` in check mode.
