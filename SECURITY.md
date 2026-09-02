# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories for
this repository. Do not open a public issue containing exploit details.

Include the affected express-recon version, reproduction steps, impact, and any
suggested mitigation. Reports concerning incorrect route or middleware
classification are welcome: a false negative can cause a caller to trust an
unprotected endpoint.

## Execution trust model

Static mode parses JavaScript and TypeScript source without importing the target
application or its installed framework packages. Express, Fastify, and NestJS
adapters share the same bounded AST traversal and fail-visible coverage model.
It is the appropriate mode for untrusted checkouts.

JavaScript/TypeScript OpenAPI modules are also handled without `require()` or
dynamic import. A bounded AST interpreter accepts a deliberately small data-only
subset, follows only local modules inside the scan root, and rejects unsupported
imports or computation. Explicitly modeled data helpers never load their
external package implementation. A rejected module remains an incomplete
documentation candidate; express-recon does not fall back to executing it.

`scan-repo` accepts GitHub shorthand, HTTPS Git URLs, or explicit local Git
directories. It fetches one shallow ref into a temporary object store without a
working-tree checkout, then materializes only size/count-bounded JS, TS, JSON,
and YAML inputs as non-executable regular files. Hooks, interactive credential
helpers, system/global Git config, LFS smudging, submodules, and symlinks are
disabled or ignored. It never installs dependencies, loads remote config, or
imports target code. Embedded URL credentials and non-HTTPS remote protocols
are rejected. Inherited Git/Git Credential Manager/askpass environment
variables are stripped before acquisition, and only HTTPS (or an explicitly
selected local repository) is enabled as a transport.

Materialization limits do not guarantee a hard network/packfile byte ceiling: a
Git server may ignore partial-clone filters, and Git itself must parse remote
protocol data. The fetch is time-bounded, but highly adversarial repositories
should still be scanned inside an OS/container boundary with a patched Git
client and filesystem quotas.

`scan-org` uses GitHub's REST API only to enumerate repositories visible to the
caller, then invokes the same `scan-repo` acquisition for each selected default
branch. It is static-only. The default concurrency is one and the CLI caps it at
eight. Each worker owns one bounded temporary snapshot, and `finally` removal
runs before the report is returned. The CLI persists reports as each worker
completes instead of retaining every detailed result in the aggregate; `--out`
overrides its safe default location.

Organization checkpoints are atomically replaced after complete repository
artifacts have been written. They contain commit IDs, compact inventory evidence,
artifact paths, sizes, and SHA-256 integrity digests, but no source snapshot or
token. `--resume` rejects incompatible tool/config/scope fingerprints and
rescans entries whose artifacts are missing, non-regular, or fail integrity
validation. Explicitly compatible releases validate the checkpoint's original
fingerprint and artifact digests before upgrading it to the current compatibility
generation. Checkpoints and private-repository artifacts remain sensitive
metadata and should receive the same access controls as the final report.
All CLI artifact writers refuse an existing symbolic link or non-regular output
target. Organization scans additionally validate their generated checkpoint,
aggregate, and `repositories/` paths before enumeration, so reusing an output
directory cannot redirect report writes through those paths.

Organization baselines are parsed as bounded JSON and never execute code or
contact their recorded repository URLs. Detailed `repositoryScan` references
must be safe relative paths that remain inside the baseline directory after
real-path resolution. `scan-org --baseline` rejects overlapping external
baseline/output directories, caps retained route-change details and delta
bytes, and keeps only a 256 MiB comparison-only baseline beside an incomplete
checkpoint. That directory contains reports—not source snapshots—but may still
reveal private repository names, routes, and source locations. It is removed
only after a complete aggregate/delta is durable and otherwise needs the same
access controls as checkpoint state.

`GH_TOKEN`/`GITHUB_TOKEN` are read from the environment for API access and
private Git fetches. The token is not accepted as a CLI argument, written to
reports, embedded in URLs, stored in repository Git config, or passed in Git
process arguments. A scoped authorization header is supplied to Git through its
child environment for both the initial partial fetch and any on-demand promisor
object reads, and the raw token variables are removed from Git/worker
environments. Reports can still reveal private repository names, routes, source
locations, and documentation; store organization outputs as sensitive data.
Organization progress on stderr also includes repository names, phases, and
safe failure text. Treat CI logs and captured JSONL progress as sensitive when
the token can see private/internal repositories. Token and credential forms are
redacted, but redaction is not a substitute for restricted log access.

Organization coverage is explicitly “API-visible.” Even an authenticated result
cannot prove that its token was permitted to see every private/internal
repository. GitHub API rate exhaustion, pagination errors, repository caps, and
per-repository failures remain visible and can be gated with
`scan-org --fail-on incomplete`.

The `scan-org` CLI always uses durable storage. If `--out` is omitted, the
destination is `.express-recon/<lowercase-organization>` beneath the real current
working directory. A symbolic or non-directory `.express-recon` entry is
rejected, newly created output directories use owner-only permissions, and a
nonempty destination still requires an explicit resume/overwrite decision in
noninteractive contexts. This avoids putting detailed organization reports on
stdout without turning a convenient default into overwrite authority.

Remote scans honor a repository's `.express-reconignore` by default. That is
convenient for repository-owned inventory but lets the repository choose its
own in-scope files. A centrally governed organization audit should pass
`--no-ignore-file` or one absolute, trusted ignore file. Aggregate and detailed
scope fingerprints provide review evidence but do not replace that policy
choice.

Hidden directories are excluded by default. `--include-hidden` (or
`scan.includeHidden: true`) deliberately widens local and remote materialization
to paths such as `.cursor/`, while `.git`, dependencies, and generated/build
outputs such as `.express-recon/` remain excluded. Hidden paths can contain private configuration or
tooling; enable this only when the scan goal requires those inputs.

`render` treats report fields, repository metadata, and OpenAPI content as
untrusted data. Report values are HTML-escaped; an OpenAPI document is serialized
with HTML-significant characters escaped before stock Swagger UI reads it. Every
site uses fixed local CSS/JavaScript, a restrictive content security policy, and
no browser-time network fetches. OpenAPI request submission, query configuration,
credential persistence, and online validation are disabled; `connect-src 'none'`
also prevents server URLs or external `$ref` targets from being contacted.
Organization artifact references must remain within the input folder after both
lexical and real-path resolution, so traversal and escaping symlinks are not
followed. This applies to repository reports and per-repository OpenAPI
artifacts; API pages are generated only for entries already classified as a
supported framework. Automatic CLI input discovery is deliberately bounded to the current
directory, `.express-recon/`, and its immediate children, rejects symbolic input
candidates, and refuses ambiguity instead of recursively walking the repository.
The derived HTML destination is a sibling `-html` directory, never the evidence
directory itself.

The resulting HTML still contains the same potentially sensitive repository
names, routes, source locations, findings, and API contract content as its input.
Protect and retain it like the original JSON/YAML; rendering is not redaction.
Rerendering uses a validated prior manifest to replace only renderer-owned files
and refuses nonempty, unowned output directories or unsafe generated symlinks.

`refresh` treats its entire output as a tool-owned state directory. It refuses
filesystem roots, home/source/current directories, source-local destinations
outside `.express-recon/<name>`, symbolic links, extra unowned entries, and
damaged integrity-protected artifacts. Updates are built in a sibling temporary
directory, validated, optionally rendered, and then swapped into place. Even
`--overwrite` requires a valid ownership manifest; it does not authorize
recursive deletion of an arbitrary nonempty directory.
Manifest hashes detect edits relative to that manifest; they are not signatures
and do not authenticate a cache controlled by an attacker. Apply the same trust
boundary to restored refresh state as to the source revision being scanned.

AI/human enrichment is accepted only with `--accept-enrichment` and only for
operation summaries, descriptions, parameters, request bodies, responses, and
component schemas. Paths, methods, security, tags, operation IDs, and scanner
trace evidence remain immutable. The complete document must pass the bundled
official OpenAPI 3.0/3.1 schema without network access; local `$ref` values must
resolve and every operation must retain a response. Accepted content is
reapplied only while its operation and all recorded source-dependency hashes
match. Repository content remains untrusted during the review;
`enrichmentSources` adds invalidation evidence and is not authority to execute
the named files. Refresh manifests retain repository-local invocation paths but
never persist external config/ignore-file locations, which callers must repeat.

The packaged Swagger UI distribution declares Scarf installation analytics as a
dependency. `package.json` sets `scarfSettings.enabled` to `false`, which disables
that analytics path for express-recon and downstream installations.

The CLI's Express-only runtime and hybrid modes import the target application's entry point
inside a disposable child process. The parent enforces a timeout and output
limit, and the worker contains target `process.exit()` calls, crashes, leaked
timers, and module/prototype mutation. Its boot compatibility shim also stubs
common infrastructure clients and neutralizes `listen()`.

The worker is process isolation, not an operating-system security boundary.
Target code can still read or write files, spawn other processes, and make
network requests through unstubbed clients using the invoking user's
permissions. Use runtime or hybrid mode only for code you trust. Parent
environment inheritance is disabled by default; `boot.inheritEnv: true` opts
trusted target code back into receiving it.

`--app auto` does not weaken that boundary. It is available only for a trusted
local scan, requires `--allow-exec`, and fails unless discovery finds exactly
one Express app and one high-confidence entry. A uniquely detected Fastify or
NestJS app fails before execution and remains static-only. Remote repository
scans never offer runtime, hybrid, or auto-entry execution.

Infrastructure stubbing patches CommonJS `Module._load`. It does not intercept
native ESM dependency imports, so an ESM application can still import and use a
real database, broker, cloud, or network client. `EXPRESS_RECON_DRY=1`,
`boot.env`, timeouts, and output limits reduce accidental boot side effects but
do not turn runtime/hybrid mode into a security sandbox.

Library callers that pass an already loaded `app` to `inventory()` or `audit()`
execute that application's import themselves and do not receive the CLI worker
boundary. Use `executeRuntime()` when a serialized, bounded worker scan is
preferred.

JavaScript passed through `--config` is executable and has the same trust
requirement. JSON and YAML configuration are parsed as data and are preferred
for policy-only use.

Middleware-review source excerpts are untrusted repository data. The exported
bundle tells model/human reviewers not to follow repository-authored
instructions, and no model or network provider is invoked by express-recon.
Imported assessments must match exact bundle/candidate hashes and remain
advisory: they never mutate config or promote an audit result to `proven`.
The complete evidence and reporting rules for agents are in the
[AI agent guide](./docs/ai-agent-guide.md).

## Webhook trust model

`notify` is the only report-consumption command that deliberately makes an
outbound request. Scanning, comparison, and event construction remain local;
the request occurs only when selected evidence produces a non-empty event and
`--dry-run` is absent. Empty deltas succeed without reading an endpoint or key.

The URL and signing keys are read from named environment variables and are
never accepted as command-line values, written into events, or included in
errors. Delivery requires an exact hostname allowlist, HTTPS on the default
port, no URL credentials/query/fragment, and redirects disabled. IP literals,
localhost, and local DNS suffixes are rejected. The allowlist should be
committed in the trusted workflow while the URL remains secret, so changing the
URL secret cannot redirect evidence to another hostname. This validation is not
a DNS or network sandbox; use runner egress policy when untrusted configuration
can affect name resolution or routing.

Requests use the Standard Webhooks header/signing shape: HMAC-SHA256 covers the
event ID, Unix timestamp, and exact raw JSON body. Keys must contain at least 32
bytes. A current and previous key can produce two signatures during rotation.
Signatures authenticate bytes; they do not encrypt route metadata or establish
receiver authorization by themselves. The receiver must verify before parsing,
enforce timestamp freshness, compare in constant time, and atomically persist
the deterministic `webhook-id` as an idempotency key. Timestamp checking without
durable ID deduplication is not replay protection.

Events are data-minimized and size-bounded. Source locations are omitted by
default, details are capped, and complete evidence stays in the CI artifact.
Route paths, repository names, refs, and other event fields are still untrusted
and potentially sensitive. Receivers must validate the event contract and avoid
copying its values into logs, markup, commands, queries, or URLs without the
appropriate escaping.

## CI trust model

A pull request must not choose the scanner binary, dependency lockfile,
classification config, or ignore policy used to judge itself. The bundled
GitHub Actions example sources all four from the base revision, runs static mode
without repository secrets, pins third-party actions to full commit SHAs, and
caps/sanitizes untrusted annotation and job-summary content. Full reports are
kept as short-retention artifacts instead of being copied wholesale into the
summary.

Protect the workflow, scanner lockfile, data-only config, and
`.express-reconignore` with required review or CODEOWNERS. Scope fingerprints
make new reports fail comparison when their effective scan scope differs. Older
reports without scope evidence remain readable for compatibility, but cannot
provide that comparability proof and should be regenerated for a security gate.
Organization reports and caches can disclose private repository names, routes,
and source locations; never make a privileged organization cache available to
untrusted pull-request jobs.

The signed-webhook example keeps endpoint/signing secrets in a separate
`workflow_run` job. That event can access secrets even though the originating
pull-request job could not, so the privileged job checks out the reviewed
default-branch lockfile, installs with lifecycle scripts disabled, validates one
exact size-bounded artifact, and never executes pull-request code. Protect the
workflow, destination allowlist, and lockfile with required review. An artifact
is untrusted input even when GitHub transported it between the two jobs.

## Dependency audit

Reviewed 2026-08-29: `npm audit --omit=dev` reports no known vulnerabilities.
The lockfile pins patched transitive releases for `@hono/node-server`, `hono`,
`fast-uri`, and `ip-address`. CI continues to run the production audit with a
high-severity gate.

The MCP entry point uses the SDK's stdio transport and does not start the SDK's
transitive Hono/Express HTTP servers. Reassess that reachability boundary before
adding an HTTP MCP transport, even when the dependency audit is clean.
