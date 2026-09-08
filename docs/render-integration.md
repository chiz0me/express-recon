# Integrating another tool with the offline renderer

Export data, not HTML or executable plugins. Express Recon reads a versioned
`render-bundle.json` and its referenced artifacts without executing the producer
or target repository. New framework identifiers require no scanner changes.
Native Express/Fastify/NestJS outputs and the existing Gin importer still work.

## Contracts and versions

The [schema catalog](../schemas/README.md) separates native inventory/audit
`2.0` from producer-neutral render `1.0`. These versions are independent of the
package version. Copy or reference the packaged schemas and pin the package/tag;
do not depend on the mutable `main` branch as a deployment contract.

The renderer supports exactly `schemaVersion: "1.0"` for bundles and their route
files. Unsupported versions fail explicitly; they are never interpreted as an
older version. Published interchange shapes are immutable. Future shapes need
an explicit version, reader dispatch, migration notes, and compatibility tests
while retaining existing readers. Reserved fields are closed to catch typos.
Use namespaced `extensions` (for example `sample-recon.scan-mode`) for additive
producer-specific information; these are preserved, not interpreted as facts.
The optional `$schema` field is informational and never fetched over the network.

## Files and required fields

See the complete [synthetic example](../examples/render-bundle/README.md).

```text
tool-output/
  render-bundle.json
  routes.json
  openapi.json
  evidence.json
```

| Record         | Required information                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundle         | `kind: render-bundle`, `schemaVersion: 1.0`, stable `id`, `producer.name` and `.version`, UTC/offset `generatedAt`, `organization.host` and `.owner`, `coverage`, `repositories` |
| Repository     | `name`, `commit` (revision or `null`), `outcome`, `coverage`, `frameworks`                                                                                                       |
| Route file     | `kind: render-routes`, `schemaVersion: 1.0`, `routes`                                                                                                                            |
| Route          | Stable unique `id`, uppercase `method`, `path` (or `null`), `framework`, `pathConfidence` (`full`, `partial`, `unknown`)                                                         |
| Coverage       | `complete` (`true`, `false`, `null`) and `reasons` (array of strings)                                                                                                            |
| File reference | Bundle-relative `path`, readable `label`; optional lowercase hexadecimal `sha256` over original file bytes                                                                       |
| Statistic      | Unique `id`, readable `label`, nonnegative numeric `value`, explicit `unit`                                                                                                      |

The JSON schemas define precise length, count, and character restrictions.
Framework and producer identifiers are lowercase open-ended tokens, such as
`django`, `spring`, or `my-tool`. Repository names are unique within a bundle;
GitHub identities are case-insensitive. Keep one repository entry per producer
snapshot. Route IDs must be unique across all applications in its route file.
Use stable source-derived IDs; array positions are not stable identities.

Repository outcomes are `scanned`, `inconclusive`, `failed`, `skipped`, `empty`,
or `unsupported`. `scanned` requires a `routes` reference (an empty routes array
is valid). Failed/inconclusive outcomes cannot declare complete coverage.
`empty` means the repository was examined and empty, not that a scan failed.
Use `null` for unknown coverage and explain uncertainty. “Complete” is complete
within the producer's declared scope, not proof that every runtime route exists.
Record excluded scope and limitations in coverage reasons or JSON evidence.

`commit` must identify the immutable examined revision, not a branch name or
requested ref. If it cannot be established, use `null`.

Optional route fields include `applicationId`, source `{file, line}`, middleware
names, and `auth: {status, basis}`. Auth status is `public`, `unknown`, or `proven`;
it is always a **producer claim**, shown with its basis in expandable evidence,
not reclassified into an Express Recon audit. Never infer authentication from
a middleware name alone. Missing source/commit/auth evidence must remain absent
or unknown; do not fabricate it. Partial/unknown/null route paths force
incomplete displayed coverage even if the producer claimed complete.

Repository `specifications` reference OpenAPI 3 or Swagger 2
JSON/YAML documents; each gets an offline API page. Use self-contained specs
with internal references. External references are not fetched or bundled.
The reader applies the existing renderer's bounded structural checks, not full
OpenAPI semantic validation; keep the producer's own specification validation.
`evidence` references arbitrary JSON documents, not HTML, scripts, source trees,
or binaries. They are parsed and reserialized into downloadable JSON files;
byte formatting is not preserved. Extensions survive in these source downloads.
Keep tokens, secrets, personal data, and unnecessary source out of all artifacts.

Optional bundle/repository `statistics` are displayed under their producer.
They are not added to native scan metrics. Route/application aggregate metrics
count producer observations separately, without cross-tool deduplication.
Routes without an application ID are grouped under `unassigned`; the displayed
application-group count is not a claim that all actual applications were found.

## Validation and rendering

From a checkout:

```sh
node src/render-bundle.js examples/render-bundle/render-bundle.json
node src/cli.js render --input examples/render-bundle --out /tmp/render-bundle-example-html
```

From a project with a pinned `express-recon` dependency:

```sh
node node_modules/express-recon/src/render-bundle.js tool-output/render-bundle.json
npx --no-install express-recon render --input tool-output --out tool-output-html
```

The validator prints only a compact validity/repository-count/warnings summary.
Exit 0 means the contract and references validated; it does **not** mean scan
coverage is complete. Exit 1 means a validation/read warning, unsupported
version, or invalid contract. `loadRenderBundle(file)` from
`express-recon/src/render-bundle` provides the same offline validation in JS,
returning `{manifest, report, warnings}`; the normalized `report` is a render
projection, not native scan/audit evidence or persisted comparison state.

## Discovery and combining output

Direct bundle input renders only that bundle. In a directory, root native
`organization-inventory.json` takes precedence, followed by `render-bundle.json`,
then the legacy Gin/repository/routes/spec candidates. If no root candidate
exists, a single immediate-child organization inventory is preferred; otherwise
exactly one child organization/bundle/Gin candidate is required.

When rendering a native organization inventory, matching optional
`render-bundle.json` files in its folder, the selected output folder, and that
folder's immediate non-hidden child directories are imported. No recursive
search or filename guessing for arbitrary evidence takes place. The bundle's
host and owner must match the inventory before referenced files are read.
Two valid bundles with the same producer name and bundle ID are both skipped
with a warning. Use one snapshot per producer for an output folder; distinct
bundle IDs represent distinct observations and their totals are not deduplicated.
Native `express-recon` companion bundles and `gin-recon` companions alongside
already-imported legacy Gin data are skipped to avoid counting the same source
twice. Explicit standalone bundles from those producers are still accepted.

Matching repositories share one organization row with combined framework
filters but keep separate producer detail pages, evidence, and API references.
The native scan is not replaced. Coverage is conservative: all contributing
observations must be complete, and differing/unknown commit identities make
combined coverage incomplete with a visible explanation. Native baseline
comparisons remain native-only; standalone bundles do not support `--baseline`.
Scanned repositories appear in the complete/incomplete table, and other outcomes
remain in the collapsed reference table. Source outcomes remain visible in detail.

## Safety and failure behavior

- Paths are relative to the manifest folder, never to the process directory.
  Absolute paths, traversal, URLs, percent encoding, and symlinks escaping that
  folder are rejected. Use portable ASCII forward-slash paths.
- Limits: 32 MiB per file; 256 MiB and 10,000 artifact read attempts across an
  import set; 32 optional bundles; 20,000 discovery-directory entries. Schema
  limits include 10,000 repositories, 100,000 routes per file, 100 evidence files
  and 100 specifications per repository, and 50 statistics per scope. JSON
  complexity is bounded to depth 64 and 2 million visited values.
- A missing, unreadable, oversized, unsafe, malformed, or hash-mismatched
  referenced file produces warnings and incomplete coverage while retaining
  other readable evidence. Structurally invalid manifests/route contracts,
  duplicate IDs, or undeclared route frameworks invalidate that bundle.
- An invalid optional bundle is skipped with a warning; native rendering
  continues. An invalid explicit bundle fails transactionally without replacing
  an existing generated site. Exhausting a shared read budget aborts the bundle
  rather than creating warnings for unbounded remaining references. No imported
  files change native scan artifacts.
- HTML uses escaped text, local JSON downloads, and the existing offline assets
  and content security policy. Report code is not loaded from a producer.

## Porting prompt / reusable skill

Use the bundled [express-recon-render-port skill](../skills/express-recon-render-port/SKILL.md).
Install it with your coding agent's normal skill mechanism or give the agent its
`SKILL.md` directly. From the consuming repo, this prompt also works without a
skill installer:

```text
Implement an optional Express Recon render exporter for this tool.
Read node_modules/express-recon/skills/express-recon-render-port/SKILL.md,
node_modules/express-recon/docs/render-integration.md and the packaged
schemas/render/v1/*.schema.json completely before editing.
Follow schemaVersion 1.0; preserve our existing scanner and native outputs.
Map real producer/repository/commit/outcome/coverage/route/spec/evidence data,
keeping unknowns explicit. Add synthetic golden fixtures and negative tests.
Validate the produced bundle with the packaged validator and render it offline.
Report the mapping, unmapped fields, tests, and remaining limitations.
Do not publish, release, upload reports, or access credentials for this task.
```
