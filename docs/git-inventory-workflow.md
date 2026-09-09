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
Selected access deliberately cannot claim complete organization coverage. PAT
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

Keep incomplete inventory artifacts and their checkpoint. Resolve the cause, then
rerun the same scope with `scan-org --resume`. Use `scan-org --update` for subsequent
inventory updates; existing checkpoint and compatibility checks decide which evidence
can be reused safely. Repository visibility restrictions remain explicit even when
every accessible repository has been scanned.

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

`prepareWorkspaces({ input, repository, root, output, applicationId?, scanSettings? })`
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
