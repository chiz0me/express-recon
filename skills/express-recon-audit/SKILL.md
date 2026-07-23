---
name: express-recon-audit
description: >-
  Audit or inventory an Express 4/5 codebase's HTTP routes and middleware.
  Use when asked to find unauthenticated/open endpoints, list all routes and
  their auth/middleware, check which routes lack an auth guard, or produce a
  route inventory for an Express app. Triggers: "audit express routes", "find
  open endpoints", "which routes have no auth", "list routes and middleware",
  "express attack surface", "unauthenticated API endpoints".
---

# Express route audit (express-recon)

Drives the `express-recon` harness to enumerate routes and flag unauthenticated
ones. The harness parses JS/TS statically (no app boot) and classifies each
route as `proven` (behind known auth), `public` (no recognised auth), or
`unknown` (guarded only by an opaque inline middleware).

## 0. Locate the tool

Use whichever resolves first:

- `express-recon` on PATH (globally installed), else
- `node ${CLAUDE_PLUGIN_ROOT}/src/cli.js` (when running as an installed plugin;
  if `${CLAUDE_PLUGIN_ROOT}/node_modules` is missing, run
  `npm install --omit=dev --prefix ${CLAUDE_PLUGIN_ROOT}` once first), else
- `node <path-to-express-recon>/src/cli.js` (a local repo checkout).

If none is available, tell the user how to install it (`npm i -g` the
express-recon checkout) and stop.

All commands below take `--src <repoDir>` (the target repo, default cwd).

## 1. Discover auth middleware (don't guess the allowlist)

The audit is only as good as the auth allowlist. Discover candidates first:

```bash
express-recon suggest-auth --src <repoDir>
```

This returns JSON `candidates` ranked with likely guards first (`likelyAuth`,
partial route coverage). Pick the ones that are genuinely authentication /
signature / authorization middleware — names like `requireAuth`,
`passport.authenticate`, `verifyToken`, `*SignatureVerifier`, `ensureLoggedIn`.
Ignore body parsers, loggers, CORS, helmet, compression.

If a guard appears inside a wrapper call such as `asyncHandler(requireAuth)`,
add the outer callee to `authWrappers` only after verifying that it always
executes and preserves the wrapped middleware. Unconfigured wrappers remain
`unknown`; this avoids proving conditional or disabling wrappers as safe.

If the user already has a known auth-middleware list, skip discovery and use it.

## 2. Write a config

Create a temp config file mapping each chosen middleware name (or dotted callee)
to a tag:

```js
// /tmp/express-recon.config.js
module.exports = {
  authMiddleware: {
    requireAuth: "authenticated",
    "passport.authenticate": "session",
    snsSignatureVerifier: "signed:aws-sns",
  },
  // Calls listed here must always execute/preserve their wrapped middleware.
  authWrappers: ["asyncHandler"],
  // Optional: routes that are meant to be open (health, webhooks, public reads).
  // Keyed by "METHOD /path"; keeps them public but suppresses their finding and
  // the --fail-on public match, so CI fails only on NEW unauthenticated routes.
  acceptedPublic: ["GET /health", "POST /webhooks/stripe"],
};
```

On a brownfield repo, seed `acceptedPublic` with the endpoints that are
intentionally open after reviewing them — otherwise every legitimately-public
route trips `--fail-on public`. An entry that no longer matches a live public
route (deleted, or now guarded) surfaces as a `stale-baseline` finding so the
list can be pruned.

## 3. Audit

```bash
express-recon audit --src <repoDir> --config /tmp/express-recon.config.js --format json
```

Parse the JSON report (`schemaVersion`, `summary`, `routes`, `findings`). Key
fields per route: `method`, `path`, `authStatus`, `middlewares[].name`,
`source.{file,line}`, `pathConfidence`.

Findings ids to surface:

- `public-route` (**high**) — no recognised auth guards this route.
- `per-verb-gap` (**high**) — same path, one method guarded and another open
  (e.g. `POST` proven, `PATCH` public). A classic write-path bypass.
- `opaque-middleware` (**medium**) — guarded only by an inline/anonymous fn;
  read the source to judge.
- `stale-baseline` (**low**) — an `acceptedPublic` entry no longer matches a live
  public route; prune it so it can't silently pre-approve a future route.
- `policy-violation` (configured severity) — a route failed a named middleware,
  auth, role, scope, ordering, or composed policy. Report `ruleId`, structured
  `evidence`, and any expired exception.

Every finding includes a stable `fingerprint`, `severity`, `confidence`, and
source location when one was resolved. Also inspect `scanCoverage`: if
`complete` is false, do not present the audit as complete; surface the
diagnostics and fix or explicitly scope the failed files.

## 4. Report to the user

Lead with the `public-route` and `per-verb-gap` findings, each with its
`source.file:line` (use a clickable `path:line` reference). Note the totals from
`summary`. Then:

- If routes show `pathConfidence: "partial"`, say so — those mounts/paths
  couldn't be fully resolved statically; re-run with `--mode hybrid --app
  <entry>` if the app boots, to recover dynamic routes and verify.
- If a `public` route's chain contains a middleware that IS auth but wasn't in
  the allowlist, add it to the config and re-audit — iterate until the public
  list is only genuinely-open routes.

## CI gate

To fail a pipeline when any unauthenticated route exists:

```bash
express-recon audit --src <repoDir> --config <cfg> --format json \
  --fail-on public,incomplete
# exit code 2 if any public route remains or static coverage is incomplete;
# add unknown to also gate review items
```

For a pull request, scan the base revision first and pass its JSON report to the
PR scan:

```bash
express-recon audit --src <baseDir> --config <cfg> --format json --out <baseOut> \
  --fail-on incomplete
express-recon audit --src <prDir> --config <cfg> \
  --baseline <baseOut>/routes.json --format json,md --out <prOut> \
  --fail-on new,regression,incomplete
```

Review `delta.newFindings` by fingerprint and severity, and
`delta.authRegressions` with their source locations and explanations. The
repository includes a GitHub Actions JSON/Markdown example at
`examples/github-actions/express-recon-pr.yml`; it uses job summaries,
annotations, and artifacts, not SARIF.

## Modes

- `static` (default) — no app boot; safe on any checkout. Handles JS+TS, ESM
  imports, tsconfig path aliases, barrel re-exports.
- `hybrid` (`--mode hybrid --app <file>`) — adds runtime verification and
  recovers dynamically-registered routes static can't see. Only for trusted
  code; the CLI sets `EXPRESS_RECON_DRY=1` and isolates the parent environment
  by default, but the worker is not an OS sandbox. Native ESM dependency imports
  are not covered by the CommonJS infrastructure-module stubs.

## Notes

- Markdown report: add `--format md --out <dir>` to write `routes.md` for humans.
- Inventory only (no security judgment): `express-recon inventory --src <repoDir>`.
- Never run `--mode runtime`/`hybrid` on a repo you don't trust to import — it
  executes the app's module-load code. `static` never executes the target.
- To also **document the API** (OpenAPI 3.1 / Swagger with request/response
  schemas and per-endpoint notes), use the `openapi-doc` skill, or add
  `--format openapi` to the same `audit` command for the deterministic skeleton.
