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

## Accepted dependency risk

Reviewed 2026-07-23: `npm audit --omit=dev` reports
`GHSA-frvp-7c67-39w9` as a moderate transitive issue in
`@hono/node-server`, pulled in by `@modelcontextprotocol/sdk`. The vulnerable
behavior is Windows path traversal in Hono's static-file server. Express Recon's
MCP entry point uses the SDK's stdio transport and does not start Hono or serve
static files, so the affected path is not reachable in this project.

The patched `@hono/node-server` release is outside the SDK v1 dependency range;
npm currently proposes downgrading the SDK as its automated fix. We therefore
retain the current SDK and keep CI gated at high/critical severity. Revisit this
exception when the supported SDK line accepts `@hono/node-server >=2.0.5`, when
the project migrates to a compatible SDK major, or if an HTTP MCP transport is
introduced.
