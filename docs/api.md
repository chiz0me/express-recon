# Library API

This page documents every value exported by `require("express-recon")`. The
public export list is checked against these headings in CI; adding an export
without documenting it fails `npm run docs:coverage`.

Unless a section says otherwise, functions are synchronous and throw an
`Error` for invalid input. Repository source, route names, paths, middleware
names, diagnostics, and documentation excerpts are untrusted data: escape them
before placing them in HTML, terminals, or chat markup.

## Inventory and audit

### `inventory(options)`

Builds a route registry without security judgment. `options.mode` is
`static`, `runtime`, or `hybrid`. Static scans support Express, Fastify, and
NestJS and require `options.src`; runtime and hybrid are Express-only. Direct
runtime use accepts an already-loaded Express `options.app` or a serialized
`options.runtimeRegistry`. Loading an app in the caller means that the caller
has already executed it.

Returns routes, framework/application identities, lifecycle middleware,
diagnostics, and static coverage evidence when applicable.

### `audit(options, config)`

Runs `inventory()` and applies validated authentication grants, accepted-public
entries, and route policies. Its return value is still a registry; pass it to
`buildReport()` for the versioned audit contract and findings.

Authentication conclusions are relative to `config`. A `proven` result means a
configured guard was observed, not that the guard implementation is correct.

### `suggestAuth(registry)`

Ranks named middleware as possible authentication candidates using deterministic
name and placement hints. Suggestions are review input and never modify config
or grant security authority.

### `buildReport(registry, metadata)`

Converts a registry into the portable report contract. `metadata.command` must
be `inventory` or `audit`; `metadata.mode` records the scan mode. Set
`metadata.sourceRoot` to normalize source paths relative to the repository and
`metadata.config` to record its stable hash.

Audit reports include `summary` and `findings`; inventory reports intentionally
omit security judgment.

### `REPORT_SCHEMA`

JSON Schema for the route inventory/audit report returned by `buildReport()`.
It does not describe repository-scan or organization-inventory envelopes.

## Discovery and API documentation

### `discover(root, options)`

Finds package scopes, Express/Fastify/NestJS applications, likely entries,
OpenAPI documents, and swagger-jsdoc sources without importing target code.
Framework package declarations include direct-dependency field, scope, and
strength evidence; presence does not imply that the package is an application.
Scan-scope and resource limits use the same fields as `config.scan`.

### `reconcileDocumentation(report, options)`

Merges an authored OpenAPI 3 document, `@openapi`/`@swagger` blocks, and code
inventory using deterministic precedence. `options.root` identifies the scan
root; `options.spec`, `options.jsdoc`, and `options.applicationId` may resolve an
ambiguous discovery result.

Returns `{ document, report }`, where `report` contains drift, conflicts,
coverage, and provenance. JavaScript documentation modules are statically
reconstructed as data and never imported.

## Middleware review

### `createMiddlewareReview(report, options)`

Builds a bounded evidence bundle containing middleware candidates, sample
routes, call sites, definitions, fingerprints, and the assessment schema.
`options.root` locates source files and `options.scan` applies normal scan
limits. Repository excerpts remain untrusted.

### `validateAssessment(value)`

Validates the provider-neutral middleware assessment structure and taxonomy.
This checks shape and bounds only; it does not establish that the assessment was
created for a particular evidence bundle.

### `applyMiddlewareAssessments(bundle, assessment)`

Validates the assessment, binds it to exact bundle and candidate fingerprints,
and returns advisory configuration suggestions. Stale, duplicate, or unknown
candidates fail closed. It never edits configuration or changes audit results.

### `MIDDLEWARE_ASSESSMENT_SCHEMA`

JSON Schema embedded in middleware-review bundles and used for assessment
responses. The schema is provider-neutral and strict about unknown fields.

## Baselines and reconciliation

### `compareReports(before, after)`

Compares two compatible route reports and returns added/removed routes,
authentication regressions/improvements, and new/resolved findings. Different
static scan-scope fingerprints are rejected so a filter change cannot masquerade
as a route change.

### `compareOrganizationReports(before, after, options)`

Compares two aggregate organization inventories with the same organization and
scan scope. Aggregate repository lifecycle and count changes require no loaders.
For exact route and authentication changes, provide synchronous
`options.loadBaselineScan(entry)` and `options.loadCurrentScan(entry)` callbacks
that return the corresponding `repository-scan` objects.

Detailed route evidence is bounded while exact summary counts are retained.
Missing or invalid detailed artifacts make comparison coverage explicitly
incomplete.

### `reconcile(staticRegistry, runtimeRegistry)`

Combines static breadth/source evidence with runtime wiring. Matching respects
application identity and preserves ambiguous observations instead of assigning
them to an arbitrary route. Runtime reconciliation is currently Express-only.

## Policies and configuration

### `normalizePolicies(policies)`

Validates the data-only policy language, rejects unknown fields, normalizes
aliases such as `roles`/`scopes`, and returns deterministic policy objects.

### `evaluatePolicies(registry, policies, options)`

Evaluates policies against a classified registry and returns a new registry with
policy findings, active exceptions, and expiration diagnostics. `options.now`
may supply a deterministic date for tests or reproducible evaluation.

### `loadConfig(path)`

Loads and validates CommonJS, JSON, or YAML configuration. JSON/YAML is
data-only; CommonJS executes with the caller's permissions. A top-level array is
accepted as policy shorthand.

### `validateConfig(value)`

Validates an in-memory configuration object, including nested authentication,
policy, OpenAPI, scan, and boot fields. Unknown fields fail instead of being
ignored. The validated input object is returned.

## Runtime and hybrid support

### `instrument(express)`

Patches the supplied Express module instance before route registration so mount
paths, registration sources, and app identity can be observed. The operation is
idempotent and returns the same Express function. It does not boot an app.

### `executeRuntime(appPath, boot)`

Returns a promise for a serialized route registry after booting a trusted app in
a bounded child process. The process boundary contains exits, crashes, output,
and leaked timers, but it is not an OS sandbox and retains the invoking user's
filesystem and network permissions.

`boot` supports the documented `boot.*` configuration fields. Prefer static
mode for untrusted repositories.

## Repository and organization scanning

### `acquireRepository(source, options)`

Creates a bounded, non-executing source snapshot for a Git URL, GitHub
`owner/repository`, or local Git repository. The return value contains `temp`,
`snapshot`, and provenance. The caller must remove `temp`; use
`scanRepository()` when raw snapshot access is unnecessary.

### `scanRepository(source, options)`

Acquires one Git ref, performs static discovery/inventory/documentation work,
returns a `repository-scan` envelope, and deletes the temporary source snapshot
in a `finally` block. `options.config`, `options.scan`, `options.ref`,
`options.githubToken`, and a best-effort `options.onProgress` callback are
supported.

### `listOrganizationRepositories(organization, options)`

Returns a promise for all repositories visible through the paginated GitHub
organization API, plus rate-limit and coverage evidence. `options.token` adds
the caller's API visibility; partial pagination remains explicit.

### `scanOrganization(organization, options)`

Returns a promise for a bounded aggregate inventory. Important options include
`token`, `maxRepositories`, `concurrency`, `includeArchived`, `includeForks`,
`config`, `scan`, `onProgress`, `onRepository`, `retainScans`, and validated
`resumeEntries`.

Concurrency defaults to one and is capped at eight. Repository failures are
isolated, snapshots are cleaned independently, and incomplete evidence never
becomes a negative framework conclusion. Each repository includes neutral
`frameworks` evidence plus the legacy `express` compatibility projection.
Framework evidence separates application/adapter/route-provider roles from
runtime, peer, development, or dependency-only package signals. The CLI owns
durable checkpoints; library callers using `resumeEntries` must provide
equivalent integrity validation.

## Rendering and formatting

### `renderHtmlSite(inputPath, outputPath, options)`

Renders an existing `routes.json`, `repo-scan.json`, organization inventory,
OpenAPI 3 or Swagger 2 JSON/YAML document, or containing directory into an
offline HTML site. API-specification inputs use packaged Swagger UI assets with request submission, remote
validation, browser connections, and query-string configuration disabled. Pass
`{ baseline: priorOrganizationPath }` to render organization change views
without rescanning.

Repository and organization rendering also create a Swagger UI page for every
retained OpenAPI 3 or Swagger 2 artifact referenced by a confirmed
supported-framework entry. The pages share one local Swagger UI bundle;
unsupported entries remain overview-only. Artifact
paths are lexically and real-path contained within the organization input.

The renderer only replaces files named in its prior manifest and rejects a
non-empty unowned output directory. It returns the manifest and absolute
`index.html` path. Unlike the CLI convenience layer, this library function
requires both `inputPath` and `outputPath`; it does not inspect the caller's
working directory or derive a destination.

## Notifications

### `buildNotificationEvents(report, options)`

Builds bounded provider-neutral events from a baseline-aware `routes.json`,
`organization-inventory.json`, or `organization-delta.json` object. Supported
event selections are `routes.added`, `routes.removed`, `auth.regressed`, and
`scan.incomplete`; the default selects added routes, auth regressions, and
incomplete evidence. `options.maxItems` defaults to 20 and is capped at 100.
Source locations are omitted unless `options.includeSource` is true, and unsafe
or absolute sources are still discarded.

Empty selected deltas return an empty array. Change events fail when their
required baseline delta is absent, rather than treating every current route as
new. IDs are deterministic across delivery reruns for the same evidence,
revision, subject, and event type; receivers should use them as durable
idempotency keys.

### `validateNotificationEvent(event)`

Validates the strict version 1 envelope, allowed event type, deterministic ID
shape, timestamp, context fields, count/detail consistency, bounded route or
repository-summary (including mixed organization-detail) items, and normalized
source locations. It returns the input
object unchanged. Shape validation does not make route/repository text safe for
logs, HTML, shell commands, URLs, or database queries; consumers must continue
to treat every value as untrusted data.

### `signWebhook(body, options)`

Returns `webhook-id`, `webhook-timestamp`, and `webhook-signature` headers for
the exact string/Buffer body using Standard Webhooks HMAC-SHA256 signing.
`options` supplies the event `id`, integer Unix `timestamp`, and one current
secret or `[current, previous]` secrets. Each secret must contain at least 32
bytes. `whsec_`-prefixed values are decoded as base64; other values are used as
UTF-8 bytes.

### `verifyWebhookSignature(body, headers, secrets, options)`

Verifies the exact raw request body with constant-time comparisons and rejects
missing headers, invalid signatures, and timestamps outside the default
five-minute tolerance. It returns `{ id, timestamp }`. Signature verification
does not provide replay storage: the receiver must atomically persist and
deduplicate `id` before processing an event.

### `deliverWebhook(event, options)`

Posts one JSON event to `options.url`. Delivery requires at least one exact
`options.allowHosts` DNS hostname, HTTPS on the default port, no URL credentials,
query, or fragment, one or two signing `secrets`, and a body no larger than 256
KiB. Redirects are errors. Timeout defaults to 10 seconds; attempts default to
three and are capped at three. Network errors, 408, 425, 429, and selected 5xx
responses receive bounded backoff; other non-2xx responses fail immediately.

The allowlist prevents a changed URL secret from redirecting delivery to a
different hostname, but it is not a DNS/network sandbox. Keep the allowlist in
trusted configuration and apply normal egress controls when the caller handles
untrusted configuration.

## Formatting

### `formatters`

An object with `json`, `markdown`, `pretty`, and `openapi` formatters. Each
module exposes `format(report)`; the OpenAPI formatter also exposes
`build(report)`. Inventory-to-OpenAPI output has no invented security schemes;
audit security requires explicit tag-to-scheme configuration.

## Complete example

```js
const recon = require("express-recon");

const registry = recon.inventory({ mode: "static", src: "." });
const report = recon.buildReport(registry, {
  command: "inventory",
  mode: "static",
  sourceRoot: ".",
});

process.stdout.write(recon.formatters.markdown.format(report));
```

See the [CLI and configuration reference](./reference.md),
[OpenAPI guide](./openapi.md), and [security model](../SECURITY.md) for the
behavior shared by CLI and library use.
