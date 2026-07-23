# express-recon

An inventory & audit harness for Express 4/5 route surfaces, built to be driven
by **humans, CI, and AI agents** off the same contract. It enumerates every
route, method, middleware chain, and source location, then (in audit mode)
classifies each route as **proven** (behind known auth), **public** (no
recognised auth), or **review** (guarded by something opaque), and emits machine
findings including per-verb auth gaps.

Two scanners, opposite failure modes:

- **static** (default): parses JS/TS source with an AST (resolves ESM imports,
  tsconfig path aliases, and barrel re-exports). No app boot, no setup in the
  target repo, source file/line for free. Misses dynamically-registered routes.
- **runtime**: loads the live app in a bounded child process and walks its
  router stack. Sees dynamic routes; the app must import cleanly. Mount-path
  prefixes are captured via instrumentation, so they survive on Express 5.
- **hybrid**: static for breadth + locations, runtime to verify and recover
  what static missed. Lowest chance of missing an open endpoint.

## CLI

```bash
express-recon <command> [options]
```

| command        | what it does                                                  |
| -------------- | ------------------------------------------------------------- |
| `inventory`    | list routes, methods, middleware chains, source (no judgment) |
| `audit`        | inventory + classify (proven/public/review) + findings        |
| `suggest-auth` | propose auth-middleware allowlist candidates (JSON)           |
| `schema`       | print the JSON Schema of the report contract                  |

`inventory`/`audit` also emit an **OpenAPI 3.1** document via `--format openapi`
(see [OpenAPI / Swagger output](#openapi--swagger-output)).

```bash
# Zero-setup audit of a checked-out repo:
express-recon audit --src ./ --config ./recon.config.js --format pretty

# CI / agent gate: non-zero exit if any unauthenticated route exists:
express-recon audit --src ./ --config ./recon.config.js --format json --fail-on public

# Bootstrap the allowlist on an unfamiliar repo:
express-recon suggest-auth --src ./ > candidates.json

# Verify static findings against the live app and catch dynamic routes:
express-recon audit --mode hybrid --src ./ --app ./src/app.js \
  --config ./recon.config.js --format json,md --out ./recon-out
```

| option                            | meaning                                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `--mode static\|runtime\|hybrid`  | scanner (default `static`)                                                                                 |
| `--src <dir>`                     | repo root to scan (static/hybrid; default cwd)                                                             |
| `--app <path>`                    | JS file exporting the Express app (runtime/hybrid)                                                         |
| `--config <path>`                 | JS file exporting auth classification, route policies, scan scope, and boot options                        |
| `--format json,md,pretty,openapi` | output formats (default `pretty`)                                                                          |
| `--out <dir>`                     | write `routes.json`/`routes.md` (else stdout)                                                              |
| `--fail-on <statuses>`            | audit only: exit `2` on `public`, `unknown`, `policy`, `policy:<id>`, `new`, `regression`, or static/hybrid `incomplete` |
| `--include <glob>`                | scan only matching root-relative source paths; repeatable                                                  |
| `--exclude <glob>`                | exclude matching root-relative source paths; repeatable                                                    |
| `--ignore-file <path>`            | scope file relative to `--src` (default `.express-reconignore`)                                            |
| `--include-tests`                 | also scan test files/dirs (`test/`, `__tests__/`, `*.test.*`, `*.spec.*` are excluded by default)          |

## For agents & CI: the report contract

`--format json` emits one versioned, self-describing artifact. Run
`express-recon schema` for the full JSON Schema. Shape:

```jsonc
{
  "schemaVersion": "1.3",
  "tool": "express-recon",
  "command": "audit", // or "inventory"
  "mode": "static",
  "routes": [
    {
      "method": "PATCH",
      "path": "/widgets/:id",
      "middlewares": [{ "name": "express.json", "kind": "call", "raw": "express.json()" }],
      "source": { "file": "src/routes/widgets.js", "line": 12 },
      "io": {
        // static/hybrid: request/response hints mined from the handler
        "request": { "body": ["name"], "query": [], "params": ["id"], "headers": [] },
        "responses": [{ "status": 200, "bodyKeys": ["id", "name"] }],
        "statusCodes": [],
        "handlerResolved": true,
        "handlerName": "updateWidget",
        "handlerSource": { "file": "src/routes/widgets.js", "line": 12 },
      },
      "pathConfidence": "full", // "partial" when a mount/path couldn't be resolved
      "authStatus": "public", // audit only: proven | public | unknown
      "tags": ["public"], // audit only
      "roles": [], // audit only: grants from authMiddleware
      "scopes": [], // audit only: grants from authMiddleware
      "authEvidence": { "matched": [] }, // audit only
      "accepted": true, // audit only: public but in the acceptedPublic baseline
      "presence": "both", // hybrid only: both | static-only | runtime-only
    },
  ],
  "globalMiddleware": [{ "name": "helmet", "kind": "call", "raw": "helmet()" }],
  "scanCoverage": { "discovered": 24, "analyzed": 24, "failed": 0, "complete": true },
  "summary": {
    "routes": 1,
    "public": 1,
    "unknown": 0,
    "proven": 0,
    "accepted": 0,
    "policyViolations": 0,
    "policyExceptions": 0,
  }, // audit only
  "findings": [
    // audit only
    {
      "id": "public-route",
      "ruleId": "public-route",
      "fingerprint": "finding_23ca7d3875ceab10",
      "severity": "high",
      "confidence": "high",
      "method": "PATCH",
      "path": "/widgets/:id",
      "source": { "file": "...", "line": 12 },
      "detail": "No recognised auth middleware guards this route.",
      "recommendation": "Add an always-enforcing auth middleware...",
    },
  ],
}
```

Finding ids: `public-route`, `per-verb-gap` (same path, different auth per
method), `opaque-middleware`, `stale-baseline` (an `acceptedPublic` entry that no
longer matches a public route), and `policy-violation`. `id` is the finding type;
`ruleId` identifies the built-in rule or configured policy, while `fingerprint`
is the stable per-route identity for baselines and CI correlation. `inventory`
reports omit `summary`/`findings` and the per-route `authStatus`/`tags`.
Static and hybrid reports include `scanCoverage`. Parser, file-read, or directory
traversal failures set `complete: false`, add diagnostics, and can be enforced in
CI with `--fail-on incomplete`. Pure runtime reports have no static source
coverage, so combining runtime mode with that gate is rejected rather than
silently passing.

An agent workflow: `suggest-auth` to draft the allowlist → write `--config` →
`audit --format json` → act on `findings` → `--fail-on public,incomplete` to assert.

## Baseline comparison and PR gates

Use a prior JSON report as a baseline to surface only what changed:

```bash
express-recon audit --src ./ --config ./recon.config.js \
  --baseline ./main-routes.json --format json,md \
  --fail-on new,regression
```

The current repository is still scanned in full, so a change to a shared router
mount or global middleware can affect routes declared in unchanged files.
`report.delta` contains added/removed routes, authentication regressions and
improvements, plus net-new/resolved findings. `--fail-on new` gates new finding
fingerprints; `--fail-on regression` gates routes whose auth state became less
safe (`proven` → `unknown`/`public`, or `unknown` → `public`). Both require
`--baseline`. Each auth change includes an `explanation` and structured
`changes` showing removed/added middleware, tags, roles, scopes, or ordering.

For GitHub pull requests, copy the
[JSON/Markdown workflow example](./examples/github-actions/express-recon-pr.yml).
It checks out the base and PR revisions, scans both with the same pinned scanner
and data-only config, publishes the complete reports as an artifact, writes a
linked delta summary to the job summary, and emits source annotations for
net-new findings. Annotations carry severity, rule, route, and stable
fingerprint; the gate fails on new findings, auth regressions, or incomplete
coverage. The example intentionally does not emit or upload SARIF, so it uses PR
checks and artifacts rather than GitHub's Code Scanning tab. Protect the scanner
lockfile and recon config with normal code review or `CODEOWNERS`.

## OpenAPI / Swagger output

`--format openapi` renders the route inventory as an **OpenAPI 3.1** document:

```bash
express-recon audit --src ./ --config ./recon.config.js --format openapi --out ./out
# writes ./out/openapi.json (loads in Swagger UI / Redoc)
```

What the tool derives deterministically, with no app boot:

- **Paths & operations** — Express `:param`/`{param}`/`*` templated to OpenAPI
  `{param}`; `router.all()` expanded across the concrete verbs.
- **Parameters** — path params from the template; query and header params from
  the mined `io` hints.
- **Request/response placeholders** — a `requestBody` object schema of the field
  names the handler reads (`req.body.*`, destructuring), and a response per
  status code (`res.status(N).json({...})`) carrying its top-level keys.
- **Security** — `components.securitySchemes` + per-operation `security` from the
  audit's auth classification (run over `audit`, not `inventory`, to get this).
- **Traceback** — every operation carries an `x-express-recon` extension with the
  handler `source` file:line, `authStatus`, middleware chain, `handlerResolved`,
  and `handlerName` (the dotted callee, e.g. `controllers.user.getUser`) so an AI
  pass can jump straight to the controller method even on dependency-injected apps
  where the body isn't statically resolvable.

The schema bodies are **placeholders** — field names without refined types,
marked `x-express-recon-unrefined`. To turn them into real request/response JSON
Schema and per-endpoint notes, run the bundled **`openapi-doc` skill**, which
reads each handler's code (AI-assisted) and fills in the schemas, `enum`s, shared
`components/schemas`, and `summary`/`description` for each operation, validates
the merged document, and renders a viewable HTML page (Redoc). The skeleton alone
is a usable, if under-specified, spec; the skill is what documents the
input/output structures.

**Coverage depends on how the app wires handlers.** Inline handlers and
first-party controllers resolve statically, so their request/response hints and
`handlerSource` come for free. Dependency-injection apps
(`module.exports = (controllers) => { router.get('/x', controllers.foo.bar) }`)
and feature-flag/dynamic dispatch can't be followed statically — those operations
still get a correct skeleton (path, method, security, `handlerName`) but sparse
hints, and the `openapi-doc` skill documents them by reading the named controller.
Nothing is invented: an unresolved handler is flagged, not guessed.

## MCP server (for agents)

A Model Context Protocol server exposes the harness as typed tools over stdio:

```bash
express-recon-mcp
```

Core tools are `inventory_routes`, `audit_routes`, `suggest_auth`,
`openapi_spec`, and `report_schema`. Larger audits can use `query_audit` for a
compact summary or cursor-paginated, filtered route/finding pages.
`finding_by_fingerprint` resolves one stable finding and its route, while
`validate_policies` validates nested requirements and exception expiry without
scanning a repository. **Static mode only**: MCP tools parse source and never
execute the target repo, so runtime/hybrid remains a human-opt-in CLI path.

Register it with an MCP client (e.g. Claude Code / Claude Desktop):

```jsonc
{
  "mcpServers": {
    "express-recon": { "command": "npx", "args": ["express-recon-mcp"] },
  },
}
```

Once registered, plain-language requests trigger the tools. Ask the agent things
like:

> "Which routes in this Express app have no authentication?"
>
> "Audit this repo and list every publicly reachable endpoint."
>
> "Inventory the routes in `./src` and show their middleware chains."
>
> "Suggest an auth-middleware allowlist for this codebase."

The agent picks the matching tool (`audit_routes`, `inventory_routes`, or
`suggest_auth`), runs it against the working directory, and acts on the returned
`findings`. A typical loop: `suggest_auth` → `audit_routes` with the chosen
allowlist → act on `findings`.

## Library

```js
const {
  inventory,
  audit,
  suggestAuth,
  buildReport,
  instrument,
  executeRuntime,
  formatters,
} = require("express-recon");

// primitives: opts is { mode, src?, app? }
const inv = inventory({ mode: "static", src: "./" }); // raw, no judgment
const reg = audit({ mode: "static", src: "./" }, config); // classified
const report = buildReport(reg, { command: "audit", mode: "static" });

console.log(formatters.markdown.format(report));
console.log(suggestAuth(inv).candidates);

// Direct in-process library use: instrument the SAME Express instance the app
// uses before registration, so Express 5 mount prefixes survive.
instrument(require("express"));
const live = audit({ mode: "runtime", app: require("./src/app") }, config);

// Bounded worker alternative; returns a serializable route registry.
const runtimeRegistry = await executeRuntime("./src/app", { timeoutMs: 10_000 });
```

The CLI uses `executeRuntime()` automatically for runtime/hybrid. Passing a
loaded `app` directly remains available for library integrations, but executes
that app in the caller's process.
`instrument()` also captures `use()` path scopes (strings and arrays), so a
path-scoped guard is attributed only to routes under its prefix; without it,
Express 5 keeps no recoverable path and scoped middleware is conservatively
treated as host-wide.

## The auth allowlist

`authMiddleware` maps a middleware **name** or **dotted callee** to either a
simple tag or structured authentication/authorization grants:

```js
module.exports = {
  authMiddleware: {
    requireAuth: "authenticated",
    "passport.authenticate": {
      tags: ["session"],
      roles: ["member"],
      scopes: ["profile:read"],
    },
    snsSignatureVerifier: "signed:aws-sns",
  },
  // Only wrappers that always execute/preserve their wrapped middleware.
  authWrappers: ["asyncHandler"],
};
```

Classification (public-unless-proven):

- **proven**: the chain contains a middleware whose name/callee is allow-listed.
  Inner names count only when the outer call is listed in `authWrappers`;
  `asyncHandler(requireAuth)` therefore matches `requireAuth` only when
  `asyncHandler` is configured as a wrapper that always executes/preserves it.
  Structured entries add `roles` and `scopes` for authorization policies.
- **review** (`unknown`): no match, but the chain has an _opaque_ middleware (an
  inline/anonymous closure, an unnameable expression, or an unconfigured wrapper
  containing a recognized auth name) that could be hiding auth. Surfaced, not
  assumed safe.
- **public**: no match and every middleware is a nameable identifier or call you
  could have allow-listed (`express.json`, a logger). Treated as unauthenticated.
  If a named middleware here is auth, add it to the allowlist and re-run, or run
  `suggest-auth` to find candidates automatically.

## The public baseline (`acceptedPublic`)

Some endpoints are meant to be open — health checks, webhooks, public reads. On a
brownfield repo they'd make `--fail-on public` unusable. `acceptedPublic` is a
reviewed allowlist of intentionally-open routes, keyed by `METHOD /path`:

```js
module.exports = {
  authMiddleware: { requireAuth: "authenticated" },
  acceptedPublic: ["GET /health", "POST /webhooks/stripe"],
};
```

An accepted route stays `public` but is tagged `accepted`: its `public-route`
finding is suppressed and it no longer trips `--fail-on public`, so CI fails only
on **new** unauthenticated routes. The summary reports an `accepted` count.

The baseline is checked against reality: an `acceptedPublic` entry that no longer
matches a live public route — the route was deleted, or now has auth — surfaces as
a `stale-baseline` finding (severity `low`) so the list can be pruned and can't
silently pre-approve a future route that reuses the path.

## Configurable route policies

`policies` turns the route inventory into a deterministic Express security-policy
engine. A policy selects routes by method, path glob, auth status, tag, role, or
scope, then evaluates authentication, authorization, middleware, ordering, or
nested boolean requirements. `*` matches within one path segment; `**` crosses
path segments.

```js
module.exports = {
  authMiddleware: {
    requireAuth: { tags: ["authenticated"], roles: ["member"] },
    requireAdmin: { tags: ["authenticated"], roles: ["admin"], scopes: ["users:write"] },
  },
  policies: [
    {
      id: "writes-require-auth",
      severity: "high",
      match: {
        methods: ["POST", "PUT", "PATCH", "DELETE"],
        paths: ["/api/**"],
        excludePaths: ["/api/webhooks/**"],
      },
      require: { auth: true },
    },
    {
      id: "public-rate-limit",
      match: { authStatuses: ["public"] },
      require: { anyMiddleware: ["rateLimit", "slowDown"] },
      recommendation: "Apply the standard public-endpoint rate limiter.",
    },
    {
      id: "admin-writes",
      match: { methods: ["POST", "DELETE"], paths: ["/admin/**"] },
      require: {
        all: [
          { auth: true },
          { roles: ["admin"] },
          { any: [{ scopes: ["users:write"] }, { allTags: ["break-glass"] }] },
          { middlewareOrder: ["requireAuth", "requireAdmin"] },
        ],
        not: { allMiddleware: ["debugBypass"] },
      },
      exceptions: [
        {
          id: "migration-callback",
          reason: "Legacy callback during migration",
          expires: "2027-01-31",
          match: { paths: ["/admin/migration/callback"] },
        },
      ],
    },
  ],
};
```

Requirements can combine:

- `auth: true` — the route must be classified `proven`.
- `anyMiddleware` — at least one named middleware must be present.
- `allMiddleware` — every named middleware must be present.
- `noMiddleware` — none of the named middleware may be present.
- `middlewareOrder` — named middleware must occur in the declared order.
- `anyTag`/`allTags`/`noTags` — constrain authentication tags.
- `anyRole`/`allRoles`/`noRoles` — constrain authorization roles; `roles` is
  shorthand for `allRoles`.
- `anyScope`/`allScopes`/`noScopes` — constrain scopes; `scopes` is shorthand
  for `allScopes`.
- `all`, `any`, and `not` — recursively compose requirement objects.

Wrapper arguments count, so `asyncHandler(csrfProtection)` satisfies a
`csrfProtection` requirement. Violations include structured `evidence`,
`confidence`, and a deterministic recommendation. Gate all policy violations
with `--fail-on policy`, or one rule with `--fail-on policy:writes-require-auth`.
Every exception requires a route selector, reason, and ISO expiry date. Active
exceptions appear in `report.policyExceptions`; once expired they stop
suppressing the violation and are attached to its evidence.

Configuration may be executable CommonJS (`.js`/`.cjs`) or data-only JSON/YAML.
A top-level JSON/YAML array is shorthand for `{ policies: [...] }`. Prefer
data-only configuration when boot hooks are unnecessary. Configuration is
strict: unknown top-level, `scan`, `boot`, auth-grant, and policy fields fail
early instead of being silently ignored.

```yaml
authMiddleware:
  requireAuth:
    tags: [authenticated]
    roles: [member]
policies:
  - id: writes-require-auth
    match: { methods: [POST, PUT, PATCH, DELETE], paths: ["/api/**"] }
    require: { auth: true }
```

## Static scan scope

Large repositories can restrict static analysis with root-relative path globs.
`*` stays within one path segment, `?` matches one non-slash character, and
`**` crosses directories:

```js
module.exports = {
  scan: {
    include: ["apps/api/**", "packages/routes/**"],
    exclude: ["**/generated/**", "**/vendor/**"],
    ignoreFile: ".express-reconignore", // default; use false to disable
  },
};
```

The equivalent repeatable CLI flags are `--include` and `--exclude`.
`.express-reconignore` uses the same root-relative globs, one per line. Empty
lines and `#` comments are ignored; a later `!pattern` re-includes a previously
ignored file:

```gitignore
generated/**
private/**
!private/public-routes.js
```

Built output, dependency, VCS, hidden, and test directories retain their safe
default exclusions. The test-directory defaults include `test`, `tests`,
`testcases`, `spec`, `specs`, `__tests__`, and `__mocks__`; `--include-tests`
opts these paths and `*.test.*`/`*.spec.*` files back in.

## Runtime / hybrid: isolated boot worker and compatibility shim

`--app` is required for runtime/hybrid. The CLI executes the target application
inside a disposable child process and returns only its serialized route
registry. This contains target crashes, `process.exit()`, prototype/module
mutations, and leaked timers. The parent also enforces boot time and output
limits.

The worker is not an operating-system security sandbox: target code retains the
invoking user's filesystem, process, and network permissions. Runtime/hybrid
remain intended for trusted local code; use static mode for untrusted
checkouts.
See [`SECURITY.md`](./SECURITY.md) for the complete execution and configuration
trust model.

The compatibility shim helps an unmodified trusted app load when its database,
cache, or broker is unavailable:

- **Infra clients are stubbed.** `require`s of common infra packages (`pg`,
  `mysql2`, `ioredis`, `redis`, `mongoose`, `mongodb`, `kafkajs`, `amqplib`,
  `@prisma/client`, `knex`, `sequelize`, `typeorm`, `bullmq`, `nodemailer`,
  any `@aws-sdk/*`, …) return inert stubs: every property/call/`new` chains,
  `await client.connect()` resolves, nothing ever rejects. Interception happens
  before module resolution, so the package doesn't even have to be installed.
  Routes registered inside `connect().then(...)` (or after an `await`ed
  connect) are still captured. Conventional last-argument Node callbacks such
  as `client.connect((err, connection) => …)` also run asynchronously with a
  null error and chainable inert result. Event listeners, subscriptions,
  consumers, and transaction bodies remain inert rather than being mistaken
  for completion callbacks. Relative/absolute/`node:` imports — your actual app
  code — are never touched.
- **`listen()` never binds** (the callback still fires) and **`process.exit`
  is ignored** during boot, so `.catch(() => process.exit(1))` teardown can't
  kill the scan.
- **Partial boots still report.** If the app throws _after_ registering routes
  (say, a config validator the shim couldn't satisfy), the routes captured
  up to that point are harvested and the report carries a
  `boot: … results may be partial` diagnostic instead of failing outright.

Everything the shim did is surfaced in `report.diagnostics` (and mirrored to
stderr as `[warn]` lines). Tune it via `--config`:

```js
module.exports = {
  boot: {
    env: { DATABASE_URL: "postgres://x", SESSION_SECRET: "recon" }, // satisfy env validators
    stubModules: ["my-internal-db-client", "@my-scope/"], // extras; trailing "/" = prefix
    timeoutMs: 10_000, // 100ms–5min
    settleMs: 50, // 0–5s deferred registration window
    maxOutputBytes: 5 * 1024 * 1024, // 1KiB–100MiB
    inheritEnv: false, // pass only boot.env + dry-run flag
    sandbox: false, // disable infra/listen stubs
  },
};
```

`boot.env` matters as often as the stubs: many boots die in an envalid/zod
schema check, not on a socket. Environment inheritance defaults to `false`;
set `inheritEnv: true` only when the trusted target genuinely needs the parent
process environment.

CommonJS and ESM entry points are supported. Promise, Node-style callback, and
short timer-deferred wiring are captured during `boot.settleMs`; increase it
for known longer initialization without exceeding `boot.timeoutMs`. The
infrastructure-module shim intercepts CommonJS `require()` through
`Module._load`; native ESM dependency imports are not stubbed. An ESM entry point
can therefore still load or contact real infrastructure unless its own dry-run
guard prevents that behavior. The worker remains process isolation, not an OS
sandbox.

The explicit gate remains useful—the worker sets `EXPRESS_RECON_DRY=1` before
loading the app:

```js
const DRY = process.env.EXPRESS_RECON_DRY === "1";
if (!DRY) {
  connectDB();
  redis.ping();
}
const app = express();
// …route wiring…
if (!DRY) app.listen(PORT);
module.exports = app;
```

## Static mode: what it resolves

Parses **JavaScript and TypeScript** (`.js/.jsx/.cjs/.mjs/.ts/.tsx/.mts/.cts`)
with oxc, no type-checking, no build step. It proves from the AST:

- `app.METHOD(path, …)` and `.route(path).all().get().post()` chains — `.all()`
  links count as middleware for the sibling verbs registered after them.
- Chained registrations (`app.use(a).use(b)`, `router.get(…).post(…)`).
- `router.use([path], subRouter)` mounts, including across files. Array paths
  (`use(['/a','/b'], …)`, `get(['/a','/b'], …)`) expand to one route/mount per
  path.
- Paths built from same-file `const` strings, `+` concatenation, and template
  literals (``app.get(`${V1}/users`, …)``).
- **Path-scoped middleware is scoped**: `app.use("/admin", mw)` guards only
  routes under `/admin`, and **registration order is honored** — a `use()` after
  a route does not guard it (matching real Express semantics).
- Wrapped guards: `asyncHandler(requireAuth)` matches the allowlist through the
  wrapper's arguments.
- Cross-file links via **`require` and ESM `import`** (default, named, namespace).
- Module resolution via relative paths, **package.json `imports` subpath
  aliases** (`#routes/*`, including conditions objects), **tsconfig `paths`
  aliases** + `baseUrl`, and **barrel re-exports** (`export { default } from …`,
  `export * from …`).
- `express.Router()` whether imported by `require`, default, or named `Router`.
- `x as T`, `x!`, and parenthesized expressions are unwrapped.
- Test files (`test/`, `tests/`, `__tests__/`, `*.test.*`, `*.spec.*`) are
  excluded by default so fixture apps don't pollute the inventory
  (`--include-tests` to opt back in).

It does **not** resolve, and marks `pathConfidence: "partial"` rather than
silently dropping a route:

- Dynamically-registered routes (loops, data-driven), shown as `/<dynamic>`.
  Use `--mode hybrid` to recover them.
- Registrar functions (`module.exports = (app) => { app.get(…) }`): the routes
  are emitted with an unknown prefix plus a diagnostic naming the file, since
  the host is bound at the call site. Hybrid mode recovers the real paths and
  merges them back by suffix.
- Non-literal mount paths/routers, and routers reached only through a
  bare/node_modules import or a `tsconfig` that isn't found, emitted with an
  unknown prefix. `tsconfig` `extends` chains aren't followed.
- Regex or computed `use()` scopes: the guard is kept on the whole host (errs
  toward "has middleware", never toward "public").
