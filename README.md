# express-recon

An inventory & audit harness for Express 4/5 route surfaces — built to be driven
by **humans, CI, and AI agents** off the same contract. It enumerates every
route, method, middleware chain, and source location, then (in audit mode)
classifies each route as **proven** (behind known auth), **public** (no
recognised auth), or **review** (guarded by something opaque), and emits machine
findings including per-verb auth gaps.

Two scanners, opposite failure modes:

- **static** (default) — parses JS/TS source with an AST (resolves ESM imports,
  tsconfig path aliases, and barrel re-exports). No app boot, no setup in the
  target repo, source file/line for free. Misses dynamically-registered routes.
- **runtime** — loads the live app and walks its router stack. Sees dynamic
  routes; the app must import cleanly. Mount-path prefixes are captured via
  instrumentation, so they survive on Express 5.
- **hybrid** — static for breadth + locations, runtime to verify and recover
  what static missed. Lowest chance of missing an open endpoint.

## CLI

```bash
express-recon <command> [options]
```

| command | what it does |
|---------|--------------|
| `inventory` | list routes, methods, middleware chains, source — no judgment |
| `audit` | inventory + classify (proven/public/review) + findings |
| `suggest-auth` | propose auth-middleware allowlist candidates (JSON) |
| `schema` | print the JSON Schema of the report contract |

```bash
# Zero-setup audit of a checked-out repo:
express-recon audit --src ./ --config ./recon.config.js --format pretty

# CI / agent gate — non-zero exit if any unauthenticated route exists:
express-recon audit --src ./ --config ./recon.config.js --format json --fail-on public

# Bootstrap the allowlist on an unfamiliar repo:
express-recon suggest-auth --src ./ > candidates.json

# Verify static findings against the live app and catch dynamic routes:
express-recon audit --mode hybrid --src ./ --app ./src/app.js \
  --config ./recon.config.js --format json,md --out ./recon-out
```

| option | meaning |
|--------|---------|
| `--mode static\|runtime\|hybrid` | scanner (default `static`) |
| `--src <dir>` | repo root to scan (static/hybrid; default cwd) |
| `--app <path>` | JS file exporting the Express app (runtime/hybrid) |
| `--config <path>` | JS file exporting `{ authMiddleware: { name: tag } }` |
| `--format json,md,pretty` | output formats (default `pretty`) |
| `--out <dir>` | write `routes.json`/`routes.md` (else stdout) |
| `--fail-on <statuses>` | audit only: exit `2` if any route matches (e.g. `public,unknown`) |

## For agents & CI: the report contract

`--format json` emits one versioned, self-describing artifact. Run
`express-recon schema` for the full JSON Schema. Shape:

```jsonc
{
  "schemaVersion": "1.0",
  "tool": "express-recon",
  "command": "audit",            // or "inventory"
  "mode": "static",
  "routes": [
    {
      "method": "PATCH",
      "path": "/widgets/:id",
      "middlewares": [{ "name": "express.json", "kind": "call", "raw": "express.json()" }],
      "source": { "file": "src/routes/widgets.js", "line": 12 },
      "pathConfidence": "full",  // "partial" when a mount/path couldn't be resolved
      "authStatus": "public",    // audit only: proven | public | unknown
      "tags": ["public"],        // audit only
      "presence": "both"         // hybrid only: both | static-only | runtime-only
    }
  ],
  "globalMiddleware": [{ "name": "helmet", "kind": "call", "raw": "helmet()" }],
  "summary": { "routes": 1, "public": 1, "unknown": 0, "proven": 0 },  // audit only
  "findings": [                                                        // audit only
    { "id": "public-route", "severity": "high", "method": "PATCH",
      "path": "/widgets/:id", "source": { "file": "...", "line": 12 },
      "detail": "No recognised auth middleware guards this route." }
  ]
}
```

Finding ids: `public-route`, `per-verb-gap` (same path, different auth per
method), `opaque-middleware`. `inventory` reports omit `summary`/`findings` and
the per-route `authStatus`/`tags`.

An agent workflow: `suggest-auth` to draft the allowlist → write `--config` →
`audit --format json` → act on `findings` → `--fail-on public` to assert.

## MCP server (for agents)

A Model Context Protocol server exposes the harness as typed tools over stdio:

```bash
express-recon-mcp
```

Tools: `inventory_routes({ dir })`, `audit_routes({ dir, authMiddleware? })`,
`suggest_auth({ dir })`, `report_schema()`. Each returns the same JSON report
contract as the CLI. **Static mode only** — the MCP tools parse source and never
execute the target repo, so an agent can't be coerced into running untrusted
code. Runtime/hybrid stays a human-opt-in CLI path.

Register it with an MCP client (e.g. Claude Code / Claude Desktop):

```jsonc
{
  "mcpServers": {
    "express-recon": { "command": "npx", "args": ["express-recon-mcp"] }
  }
}
```

The agent loop becomes: `suggest_auth` → `audit_routes` with the chosen
allowlist → act on `findings`.

## Library

```js
const { inventory, audit, suggestAuth, buildReport, instrument, formatters } =
  require("express-recon");

// primitives — opts is { mode, src?, app? }
const inv = inventory({ mode: "static", src: "./" });          // raw, no judgment
const reg = audit({ mode: "static", src: "./" }, config);      // classified
const report = buildReport(reg, { command: "audit", mode: "static" });

console.log(formatters.markdown.format(report));
console.log(suggestAuth(inv).candidates);

// runtime: instrument the SAME express the app uses, BEFORE it registers routes,
// so mount-path prefixes survive (Express 5 compiles them away otherwise).
instrument(require("express"));
const live = audit({ mode: "runtime", app: require("./src/app") }, config);
```

The CLI does the `instrument()` step automatically for runtime/hybrid.

## The auth allowlist

`authMiddleware` maps a middleware **name** or **dotted callee** to a tag:

```js
module.exports = {
  authMiddleware: {
    requireAuth: "authenticated",
    "passport.authenticate": "session",
    snsSignatureVerifier: "signed:aws-sns",
  },
};
```

Classification (public-unless-proven):

- **proven** — the chain contains a middleware whose name/callee is allow-listed.
- **review** (`unknown`) — no match, but the chain has an *opaque* middleware (an
  inline/anonymous closure, or an unnameable expression) that could be hiding auth.
  Surfaced, not assumed safe.
- **public** — no match and every middleware is a nameable identifier or call you
  could have allow-listed (`express.json`, a logger). Treated as unauthenticated.
  If a named middleware here is auth, add it to the allowlist and re-run — or run
  `suggest-auth` to find candidates automatically.

## Runtime / hybrid: host-side gate

`--app` is required for runtime/hybrid; the CLI sets `EXPRESS_RECON_DRY=1`
before requiring it, so gate boot side effects on it:

```js
const DRY = process.env.EXPRESS_RECON_DRY === "1";
if (!DRY) { connectDB(); redis.ping(); }
const app = express();
// …route wiring…
if (!DRY) app.listen(PORT);
module.exports = app;
```

## Static mode: what it resolves

Parses **JavaScript and TypeScript** (`.js/.jsx/.cjs/.mjs/.ts/.tsx/.mts/.cts`)
with oxc — no type-checking, no build step. It proves from the AST:

- `app.METHOD(path, …)` and `.route(path).get().post()` chains.
- `router.use([path], subRouter)` mounts, including across files.
- Cross-file links via **`require` and ESM `import`** (default, named, namespace).
- Module resolution via relative paths, **tsconfig `paths` aliases** + `baseUrl`,
  and **barrel re-exports** (`export { default } from …`, `export * from …`).
- `express.Router()` whether imported by `require`, default, or named `Router`.
- `x as T`, `x!`, and parenthesized expressions are unwrapped.

It does **not** resolve, and marks `pathConfidence: "partial"` rather than
silently dropping a route:

- Dynamically-registered routes (loops, data-driven) — shown as `/<dynamic>`.
  Use `--mode hybrid` to recover them.
- Non-literal mount paths/routers, and routers reached only through a
  bare/node_modules import or a `tsconfig` that isn't found — emitted with an
  unknown prefix. `tsconfig` `extends` chains aren't followed.
- Path-scoped `app.use("/x", mw)` is over-approximated to the whole host (errs
  toward "has middleware", never toward "public").
