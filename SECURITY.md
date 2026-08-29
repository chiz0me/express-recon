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
application. It is the appropriate mode for untrusted checkouts.

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
runs before the report is returned. With `--out`, reports are persisted as each
worker completes instead of retaining every detailed result in the aggregate.

Organization checkpoints are atomically replaced after complete repository
artifacts have been written. They contain commit IDs, compact inventory evidence,
artifact paths, sizes, and SHA-256 integrity digests, but no source snapshot or
token. `--resume` rejects incompatible tool/config/scope fingerprints and
rescans entries whose artifacts are missing, non-regular, or fail integrity
validation. Checkpoints and private-repository artifacts remain sensitive
metadata and should receive the same access controls as the final report.

`GH_TOKEN`/`GITHUB_TOKEN` are read from the environment for API access and
private Git fetches. The token is not accepted as a CLI argument, written to
reports, embedded in URLs, stored in repository Git config, or passed in Git
process arguments. A scoped authorization header is supplied to Git through its
child environment, and the raw token variables are removed from Git/worker
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

Remote scans honor a repository's `.express-reconignore` by default. That is
convenient for repository-owned inventory but lets the repository choose its
own in-scope files. A centrally governed organization audit should pass
`--no-ignore-file` or one absolute, trusted ignore file. Aggregate and detailed
scope fingerprints provide review evidence but do not replace that policy
choice.

`render` treats report fields and repository metadata as untrusted text. It
HTML-escapes values, uses fixed local CSS/JavaScript, adds a restrictive content
security policy, and performs no browser-time fetches. Organization artifact
references must remain within the input folder after both lexical and real-path
resolution, so traversal and escaping symlinks are not followed. The resulting
HTML still contains the same potentially sensitive repository names, routes,
source locations, findings, and documentation evidence as its input. Protect
and retain it like the original JSON; rendering is not redaction. Rerendering
uses a validated prior manifest to replace only renderer-owned files and refuses
nonempty, unowned output directories or unsafe generated symlinks.

The CLI's runtime and hybrid modes import the target application's entry point
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
one app and one high-confidence entry. Remote repository scans never offer
runtime, hybrid, or auto-entry execution.

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

## Dependency audit

Reviewed 2026-08-29: `npm audit --omit=dev` reports no known vulnerabilities.
The lockfile pins patched transitive releases for `@hono/node-server`, `hono`,
`fast-uri`, and `ip-address`. CI continues to run the production audit with a
high-severity gate.

The MCP entry point uses the SDK's stdio transport and does not start the SDK's
transitive Hono/Express HTTP servers. Reassess that reachability boundary before
adding an HTTP MCP transport, even when the dependency audit is clean.
