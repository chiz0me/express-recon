---
name: openapi-doc
description: >-
  Generate an AI-documented OpenAPI 3.1 (Swagger) spec for an Express 4/5
  codebase. Use when asked to "generate an OpenAPI/Swagger spec", "document the
  API", "produce API docs from the routes", or "describe each endpoint's request
  and response". Drives express-recon to build a deterministic skeleton, then
  reviews each handler's code to fill in real request/response schemas and notes.
  Triggers: "openapi", "swagger", "api docs", "document the api", "generate a
  spec", "request/response schemas".
---

# OpenAPI/Swagger documentation (express-recon)

Turns an Express codebase into a documented **OpenAPI 3.1** document in two
layers:

1. **Skeleton (deterministic).** `express-recon` emits paths, methods,
   path/query/header parameters, response status codes, per-operation `security`
   (from auth classification), and statically-mined request/response *hints* —
   plus an `x-express-recon` extension per operation carrying the handler
   `source` file:line, `authStatus`, middleware chain, and `handlerResolved`.
2. **Enrichment (AI code review — this skill).** You read each handler at its
   `source`, refine the placeholder schemas into real JSON Schema, and write a
   human `summary`/`description` (notes) per operation.

The skeleton's schemas are placeholders (`x-express-recon-unrefined: true`, and a
top-level `x-express-recon.schemasArePlaceholders: true`). Your job is to replace
them with schemas grounded in the actual handler code.

## 0. Locate the tool

Use whichever resolves first (same as the audit skill):

- `express-recon` on PATH, else
- `node ${CLAUDE_PLUGIN_ROOT}/src/cli.js` (installed plugin; if
  `${CLAUDE_PLUGIN_ROOT}/node_modules` is missing, run
  `npm install --omit=dev --prefix ${CLAUDE_PLUGIN_ROOT}` once first), else
- `node <path-to-express-recon>/src/cli.js` (a local checkout).

If none is available, tell the user how to install it and stop.

## 1. Generate the skeleton

Run over `audit` (not `inventory`) so the `security` section is populated from
the auth classification. Discover the auth allowlist first if you don't have one:

```bash
express-recon suggest-auth --src <repoDir>       # pick genuine auth middleware
# write /tmp/express-recon.config.js: module.exports = { authMiddleware: { requireAuth: "authenticated", ... } }
express-recon audit --src <repoDir> --config /tmp/express-recon.config.js \
  --format openapi --out <outDir>
```

This writes `<outDir>/openapi.json`. If the app registers routes dynamically and
imports cleanly, add `--mode hybrid --app <entry>` to recover them (only on a
repo you trust to import — it executes module-load code). Note: hybrid recovers
real **paths** and dynamic routes, but the request/response **hints stay static**
— it does not mine handler bodies the static pass couldn't reach, so on
dependency-injection apps you still document most bodies by reading controllers.

Read the skeleton. Each operation has:

- `operationId`, `tags`, `parameters`, `requestBody`/`responses` (placeholders),
  `security`.
- `x-express-recon`: `{ source: {file, line}, authStatus, middlewares[],
  pathConfidence, handlerResolved, method }`.

## 2. Document each operation (the AI pass)

For every operation, open the handler at `x-express-recon.source.file:line` (and
any controller/service it delegates to — follow the call). Then produce:

- **Input structure** — refine `requestBody` (JSON body), `parameters` (path,
  query, header) into real JSON Schema: types, `required`, `enum`s, nested
  objects, arrays. The skeleton's mined field names are a starting point, not the
  whole story — add fields the code reads that static analysis missed, and drop
  ones that are dead.
- **Output structure** — refine `responses` per status code with real body
  schemas. Capture every status the handler can return (validation errors, auth
  failures, not-found), not just the happy path.
- **Notes** — set the operation `summary` (one line) and `description` (behavior,
  side effects, auth expectation, and gotchas, e.g. "returns 200 with
  `{ ok: false }` on a validation failure rather than 4xx").

Finding the handler (by `x-express-recon` fields):

- `handlerResolved: true` **with** a `handlerName` → a named/controller function;
  its `handlerSource` is the definition. Read it there.
- `handlerResolved: true` **without** a `handlerName` → an **inline** handler in
  the route file; `handlerSource.line` is the exact line. Read it inline.
- `handlerResolved: false` **with** a `handlerName` → the static pass couldn't
  reach the body (dependency injection, dynamic dispatch). The name still points
  you at the symbol:
  - `controllers.<area>.<method>` → `<area>` controller file, that method. This
    is the common DI shape (`module.exports = (controllers) => { router.get('/x',
    controllers.foo.bar) }`).
  - A non-standard name (`v2Controllers.smallboardController`,
    `depositHandler.getDeposits`) → **grep the repo** for the symbol to find its
    file; the convention above won't locate it.
  - A feature-flag/toggle middleware (`subscriptionLaunchDarklyMiddleware`,
    `subsServiceToggle`) → the registered function only routes by a flag. Find the
    flag's branches to document the real behavior, or leave the placeholder and
    say so in the `description`. Don't guess.
- `handlerResolved: false` **without** a `handlerName` → open `handlerSource` and
  read what's registered.

Schema guidance:

- **Look for a shared response envelope first.** Many Express apps wrap every
  response in a helper (e.g. `createRes(success, errors, data)` /
  `res.json({ success, data, error })`). Model it **once** as a
  `components/schemas` entry and `$ref` it, with the per-endpoint `data` shape as
  the only variable part. This is the single highest-leverage move on a large API.
- Resolve shared DTOs / validators (zod, joi, celebrate, express-validator,
  class-validator, TS interfaces) into reusable `components/schemas` and `$ref`
  them rather than re-inlining. Validator definitions are often a more reliable
  source of the request shape than scattered `req.body.x` reads.
- **Ground every schema in code you actually read.** If a field's type isn't
  visible in the code, keep the property but leave its schema open and note the
  uncertainty in the `description` — do not invent types or fields.
- Preserve `security` and the `x-express-recon` extensions from the skeleton;
  they are the traceback to source and auth posture.

## 3. Merge, validate, render

- Merge your schemas/notes onto the skeleton: the skeleton owns paths, methods,
  `security`, and `x-express-recon`; you own schema bodies, `summary`,
  `description`, and `components/schemas`. Remove the `x-express-recon-unrefined`
  markers from operations you've refined, and drop the top-level
  `schemasArePlaceholders` once the pass is complete.
- Write the result to `<outDir>/openapi.json` (and `openapi.yaml` if the user
  wants YAML).
- Validate it is a well-formed OpenAPI 3.1 document — parse the JSON and confirm
  `openapi: "3.1.0"`, that every operation has at least one response, and that
  every `$ref` resolves against `components/schemas`. If a validator CLI is
  available (e.g. `npx @redocly/cli lint`), run it and fix what it flags.
- **Render a viewable HTML page** next to the spec. The zero-install way is a
  standalone Redoc page with the spec inlined (no server, no CORS):

  ```bash
  node -e 'const fs=require("node:fs");const spec=fs.readFileSync(process.argv[1],"utf8");
  const SRC="https://cdn.jsdelivr.net/npm/redoc@2.1.5/bundles/redoc.standalone.js";
  const SRI="sha384-0GrsyTQc9Oqd8h+b2dbc4XdR2T/DYpy0tLNNstyx+LBMUyiBbcWPbEs9aRmUcaxD";
  fs.writeFileSync(process.argv[2],`<!doctype html><html><head><meta charset="utf-8"/>
  <title>API</title><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
  <body><div id="redoc"></div>
  <script src="${SRC}" integrity="${SRI}" crossorigin="anonymous"></script>
  <script>Redoc.init(${spec},{expandResponses:"200,201"},document.getElementById("redoc"))</script>
  </body></html>`)' <outDir>/openapi.json <outDir>/api.html
  ```

  The CDN script is pinned to a version and carries a Subresource Integrity hash
  (`integrity`/`crossorigin`) so a compromised CDN can't inject code — keep both
  when you bump the version (recompute with `openssl dgst -sha384 -binary <file> |
  openssl base64 -A`). Alternatives: `npx @redocly/cli build-docs openapi.json -o
  api.html`, or Swagger UI. Redoc-inline needs internet only for the CDN script.
- Report coverage to the user: operations documented vs. left as placeholders,
  which controllers/tags are complete, and any handlers that couldn't be resolved
  (so they know where the docs are weakest). Give the paths of `openapi.json` and
  `api.html`.

## Scaling to large APIs

For many routes, document operations in parallel with subagents — give each a
slice of the operation list plus the skeleton path, and have each **return only
its merged fragments** (operation objects + any `components/schemas` it added),
not the whole document, to keep orchestration context small. Merge the fragments
centrally, then validate once. Only fan out this way when the user has opted into
multi-agent orchestration or the route count clearly warrants it.

**Delegating to a sandboxed agent (e.g. Codex):** a delegated agent often runs in
a sandbox that only permits writes inside its own workspace directory — writing
`openapi.json`/`api.html` to an arbitrary scratch path fails with `EROFS:
read-only file system` and the work is lost. Tell the delegate to write its
outputs **inside its workspace root**, then move the files where you want them.
If you split work across agents, a shared response envelope decided up front (see
step 2) keeps their `components/schemas` consistent so the fragments merge cleanly.

## Notes

- The skeleton alone (no AI pass) is already a usable, if under-specified, spec —
  hand it over as-is if the user only wants the structure.
- Never run `--mode runtime`/`hybrid` on a repo you don't trust to import.
- This complements the `express-recon-audit` skill (auth posture) and the
  `api-recon` pipeline (data classification, live traffic) — the OpenAPI doc is
  the structural view; those add the security and data-exposure views.
