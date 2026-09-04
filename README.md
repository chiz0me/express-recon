<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/lockup-dark.svg">
    <img src="assets/logo/lockup-light.svg" alt="express-recon" width="300">
  </picture>
</p>

# express-recon

Fast, offline-first route scanner, authentication auditor, and OpenAPI generator for **Express**, **Fastify**, and **NestJS**.

It statically inspects supported JavaScript and TypeScript route patterns, authentication middleware, and schema evidence to generate an OpenAPI (Swagger) inventory — **without executing your code or running your server** (with optional worker execution available for runtime Express inspection). Unresolved paths and incomplete route graphs remain visible for review instead of being presented as confirmed coverage.

> 💡 **In Simple Words**:
>
> - **Route Inventory**: Recovers supported endpoints (`GET /users`, `POST /login`, etc.) and attached middleware, while reporting analysis gaps explicitly.
> - **`public`**: Means no recognized authentication middleware was found by your audit configuration on this route. (This is relative to your configuration and does not prove the endpoint is reachable from the public internet).
> - **`proven`**: Means a recognized authentication guard or middleware configured in your allowlist was located on the route (it does not prove the internal logic inside that guard is bug-free).
> - **`unknown`**: Means the route has an inline function or custom logic that needs a quick manual review by a developer.
> - **OpenAPI / Swagger**: Automatically generates or updates an OpenAPI 3.1 contract from your actual routes and validation schemas.

---

## Why express-recon?

- 🔒 **Safe Static-First Analysis**: Static mode analyzes code using Abstract Syntax Tree (AST) parsing without booting your application, connecting to databases, or executing code. For advanced Express inspection, optional runtime and hybrid modes execute trusted code in an isolated worker process.
- 🌐 **Local-First and Private by Default**: Runs entirely on your local machine or CI runner without external cloud dependencies. No source code, routes, or tokens are sent externally unless you explicitly invoke remote features (such as scanning remote Git repositories or sending webhook notifications).
- ⚡ **Multi-Framework Support**: Works seamlessly across Express 4 & 5, Fastify 4 & 5, and NestJS 10 & 11 (including TypeScript DTOs and decorators).
- 🛡️ **CI/CD Quality Gates**: Can block pull requests on configured route, documentation, completeness, or policy findings.
- 🤖 **AI-Ready with MCP**: Comes with a built-in Model Context Protocol (MCP) server so AI coding assistants (like Cursor, Claude Desktop, or Gemini CLI) can understand your backend architecture safely.

---

## Start here

**System Requirements**: Node.js `^20.19.0` or `>=22.12.0`.

Install `express-recon` in your project as a development dependency so your whole team and your CI pipeline use the locked version:

```bash
npm install --save-dev express-recon
npx --no-install express-recon --help
```

The package installs two binaries: `express-recon` for CLI workflows and `express-recon-mcp` for the static local MCP server.

> ℹ️ **Good to know**:
> Local commands like `discover`, `inventory`, `audit`, `docs`, `refresh`, and middleware review do not use the network, do not install packages, and do not import application code. Installing the npm package is the only step that uses the network.

---

## Five-minute quick start tutorial

Follow these four simple steps to scan your project, find all API endpoints, and check your security guards.

### Step 1: Discover your repository structure

Run `discover` to find all applications, frameworks, entry files, and existing Swagger/OpenAPI files in your project:

```bash
npx --no-install express-recon discover --src . --out .express-recon
```

**What happens?**
This creates `.express-recon/discovery.json`. It inspects your project and identifies:

- Which frameworks are in use (Express, Fastify, or NestJS).
- Each distinct application and its unique ID (for example, `app:src/app.js#app`).
- Where your main server file is located.
- Any existing OpenAPI specifications or JSDoc comments.

### Step 2: Build a complete route inventory

Run `inventory` to get a list of every API route without any security judgment:

```bash
npx --no-install express-recon inventory --src . --format json,md --out .express-recon
```

**What happens?**
This writes two files:

1. `routes.json`: A machine-readable catalog of every endpoint, method, and middleware.
2. `routes.md`: A clean, readable Markdown table showing all your routes.

> 💡 **Ignoring files**:
> If you have files you want to skip (such as build outputs, tests, or legacy code), create an `.express-reconignore` file in your project root. It uses standard glob patterns (like `client/**` or `dist/**`).
>
> **Important**: Add `.express-recon/` to your `.gitignore` so generated reports are not accidentally committed, unless you intentionally want to save a baseline.

### Step 3: Identify authentication guards

Run `suggest-auth` to automatically detect functions in your code that look like authentication middleware:

```bash
npx --no-install express-recon suggest-auth --src . > .express-recon/auth-candidates.json
```

**What happens?**
The tool looks for common auth naming patterns (such as `requireAuth`, `authenticate`, `verifyToken`, `jwtGuard`, `requireAdmin`) and ranks them for you.

Check these candidates, then create a simple configuration file named `recon.config.yaml` in your project root:

```yaml
# 1. Tell express-recon which middleware protect your APIs:
authMiddleware:
  requireAuth: authenticated
  requireAdmin:
    tags: [admin]
    roles: [administrator]

# 2. List routes that are intentionally public (so audit will not flag them):
acceptedPublic:
  - applicationId: app:src/app.js#app
    method: GET
    path: /health
  - "POST /login"
  - "POST /register"
```

> 💡 **Tip**: In single-app repositories, simple strings like `"POST /login"` work great. For multi-app monorepos, use the structured form with `applicationId` to target the specific app.

### Step 4: Audit routes and enforce security in CI/CD

Now, run `audit` to check every route against your configuration and fail if any unauthenticated endpoint is exposed:

```bash
npx --no-install express-recon audit --src . --config recon.config.yaml \
  --format json,md --out .express-recon \
  --fail-on public,unknown,incomplete
```

**Understanding Exit Codes**:

- **Exit code `0`**: All checks passed! Every route is either authenticated (`proven`) or explicitly listed in `acceptedPublic`.
- **Exit code `2`**: Security rule matched! One or more routes are unprotected (`public`), need review (`unknown`), or have incomplete static coverage. In CI/CD pipelines (like GitHub Actions), this will intentionally fail the build to stop vulnerable code from being deployed.
- **Exit code `1`**: General operational error (such as a missing file or invalid CLI flag).

## Choose the right workflow

Here is a quick cheat sheet to help you pick the right command for your task:

| What do you want to do?                          | Command to run       |   Does code run?    |   Uses network?    | Primary output                                      |
| :----------------------------------------------- | :------------------- | :-----------------: | :----------------: | :-------------------------------------------------- |
| **Understand an unfamiliar repo**                | `discover`           |         No          |         No         | Apps, packages, entry points, and existing docs     |
| **List all routes without security checks**      | `inventory`          | No (in static mode) |         No         | Complete route registry in JSON & Markdown          |
| **Check auth and enforce security rules**        | `audit`              | No (in static mode) |         No         | Security findings, audit summary, and policy checks |
| **Combine OpenAPI, JSDoc, and code routes**      | `docs`               |         No          |         No         | Reconciled OpenAPI 3.1 specification & drift report |
| **Keep an AI-enriched OpenAPI spec up to date**  | `refresh`            |         No          |         No         | Updated OpenAPI spec preserving manual descriptions |
| **Review complex middleware with an AI agent**   | `review-middleware`  | No (in static mode) |         No         | Bounded evidence bundle for human or AI review      |
| **Validate and import review suggestions**       | `import-review`      |         No          |         No         | Validated advisory configuration suggestions        |
| **Scan a single remote Git repository**          | `scan-repo`          |         No          |  Yes (Git fetch)   | Provenance plus complete static inventory/audit     |
| **Scan every repository in a GitHub Org**        | `scan-org`           |         No          |  Yes (GitHub API)  | Multi-repo inventory with progress and HTML sites   |
| **View saved reports in a browser (Swagger UI)** | `render`             |         No          |         No         | Clean, self-contained offline HTML website          |
| **Send route change alerts to Slack/Webhook**    | `notify`             |         No          | Yes (Webhook POST) | Signed, secure notification events                  |
| **Inspect complex dynamic Express routing**      | `inventory` (hybrid) |       **Yes**       |   App-dependent    | Combined static and runtime route observations      |

---

## Framework support at a glance

`express-recon` understands the unique routing and lifecycle patterns of each framework:

| Framework            | Static route discovery                                                                                      | Lifecycle & Middleware evidence                                     | Runtime / Hybrid mode                  |
| :------------------- | :---------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------ | :------------------------------------- |
| **Express (4 & 5)**  | Apps, routers, nested mounts, route chaining (`app.route()`), input schemas (Zod, Joi, `express-validator`) | `app.use()`, router middleware, and route-level guards              | Fully supported for trusted local code |
| **Fastify (4 & 5)**  | Root instances, plugins, prefixes, encapsulated scopes, direct registrars, and route `schema` options       | Request hooks (`onRequest`, `preHandler`, etc.) and per-route hooks | Static-first (use `--mode static`)     |
| **NestJS (10 & 11)** | Modules, controllers, global prefixes, route mappings, TypeScript DTOs, and `class-validator`               | Guards (`@UseGuards`), interceptors, pipes, and filters             | Static-first (use `--mode static`)     |

> ℹ️ **How it handles unknown patterns**:
> If Fastify or NestJS uses dynamic wiring (such as an unresolved object spread or dynamic module import), `express-recon` does not pretend everything is fine. It marks the affected route as `unknown` or adds an opaque route diagnostic, alerting you that manual review is needed.

---

## Key concepts explained in simple words

`express-recon` follows a strict principle: **separate facts from security decisions**.

1. **`inventory` records facts**: It lists routes, middleware names, source file line numbers, and request/response shapes. It never makes a security judgment on its own.
2. **`audit` applies your security decisions**: It takes the inventory and checks it against your `authMiddleware` rules and `acceptedPublic` list.
3. **The Three Auth Statuses**:
   - 🟢 **`proven`**: The route has a confirmed guard that matched your `authMiddleware` configuration.
   - 🔴 **`public`**: No configured guard matched this route. This indicates that no recognized authentication middleware was found under your current configuration (it is configuration-relative and does not prove reachability or lack of network-level security).
   - 🟡 **`unknown`**: An inline closure or anonymous function is in the middleware chain. It might be checking auth, or it might not. You should inspect it manually.
4. **Stable Application IDs**: In modern projects, a single repository might contain multiple services. `express-recon` gives each detected app a stable identifier (e.g. `app:src/app.js#app`, `fastify:src/server.js#server`, or `nestjs:src/main.ts#app`). Identical paths in separate apps are never accidentally mixed up.

Every JSON report is deterministic and versioned. Run `npx --no-install express-recon schema` to view its JSON Schema. For field-by-field details, see the [CLI and report reference](./docs/reference.md).

## Common workflows

### 1. Working with Monorepos and Multi-App Repositories

If your repository contains multiple services (for example, a public API in `apps/public` and an admin API in `apps/admin`), run `discover` first to see their unique application IDs:

```bash
npx --no-install express-recon discover --src . --out .express-recon
```

Then, target a specific app using `--app-id`:

```bash
npx --no-install express-recon docs --src . \
  --app-id 'app:apps/public/src/app.js#app' \
  --out .express-recon/public-api
```

> 💡 **Why use `--app-id`?**
> In a monorepo, multiple packages might have an `app.js` or `server.ts`. Specifying `--app-id` ensures that `express-recon` audits only the intended application and does not accidentally mix routes from different services.

For trusted hybrid scans on an Express app, you can bind the runtime entry point to that exact app ID:

```bash
npx --no-install express-recon audit --mode hybrid --src . \
  --app ./apps/public/src/app.js \
  --app-id 'app:apps/public/src/app.js#app' \
  --config recon.config.yaml --format json
```

---

### 2. Merging Existing OpenAPI specs and swagger-jsdoc

If your project already has an OpenAPI specification or JSDoc comments (`@openapi` or `@swagger`), run `docs` to reconcile them with your actual code:

```bash
npx --no-install express-recon docs --src . --app-id 'app:src/app.js#app' \
  --out .express-recon/docs \
  --fail-on docs-conflict,docs-incomplete
```

**How conflicts are resolved**:

1. **Authored OpenAPI specification** has the highest priority and is treated as truth.
2. **JSDoc comments** fill in any missing parameter descriptions, summaries, and tags.
3. **Static code analysis** fills in any remaining routes or parameter shapes found in your source code.
4. **Conflict detection**: If code and docs disagree (for example, a route exists in code but is missing from docs, or vice versa), it is clearly flagged in `docs-report.json`.

> 📘 Learn more in the detailed [OpenAPI guide](./docs/openapi.md).

---

### 3. Keeping AI-Enriched OpenAPI Documentation in Sync (`refresh`)

When documenting an API, you or an AI agent might write rich summaries and descriptions in `openapi.json`. When the backend code changes, you don't want those manual descriptions to be wiped out!

The `refresh` command creates a living documentation workspace:

```bash
# 1. Initialize or update the documentation workspace:
npx --no-install express-recon refresh --src . \
  --app-id 'app:src/app.js#app'
```

By default, this writes to `.express-recon/api`. On every run, it performs a fresh static inventory, compares routes with the previous run, and rebuilds an offline Swagger UI site under `api-reference/`.

**How to safely enrich descriptions**:

1. You or an AI agent can edit `summary`, `description`, `parameters`, `requestBody`, `responses`, and `components.schemas` in `.express-recon/api/openapi.json`.
2. Explicitly accept your changes:
   ```bash
   npx --no-install express-recon refresh --src . --accept-enrichment
   ```

**Why this is helpful**:

- Your accepted descriptions are saved in `openapi.enrichment.json`.
- When backend code changes, routes that stayed the same keep their descriptions automatically.
- Only newly added or modified routes are flagged as `unreviewed` or `stale` in `refresh-report.json`.
- If a description depends on delegated code beyond the detected route and handler files, add repository-relative paths to that operation's `x-express-recon.enrichmentSources` before acceptance.
- In CI/CD, you can gate on `--fail-on enrichment-stale,enrichment-unreviewed` to ensure all API changes are properly documented.

---

### 4. Reviewing Complex Middleware with an AI Agent

If your project has complex custom middleware that the static scanner cannot automatically verify, you can bundle the evidence for review:

```bash
# 1. Create a review bundle of all uncertain middleware:
npx --no-install express-recon review-middleware --src . --out .express-recon/review

# 2. Provide middleware-review.json to a teammate or an AI model, then validate their response:
npx --no-install express-recon import-review \
  --review .express-recon/review/middleware-review.json \
  --assessment middleware-assessment.yaml \
  --out .express-recon/review
```

The review bundle extracts exact code snippets, callsites, and routes. The `import-review` command validates the assessment against a strict schema and provides advisory suggestions without granting automatic authority. See the [AI agent guide](./docs/ai-agent-guide.md).

### 5. Scanning Remote Git Repositories and GitHub Organizations

#### Scanning a single Git repository (`scan-repo`)

You can scan a remote repository directly without manually cloning it or running `npm install`:

```bash
npx --no-install express-recon scan-repo --repo owner/project --ref main \
  --out .express-recon/remote
```

**How it works safely**:

- Performs a shallow Git fetch over HTTPS without checking out files, running hooks, installing dependencies, or executing code.
- Generates `repo-scan.json` containing discovery, inventory/audit, documentation status, and commit provenance.
- For private repositories, set the `GH_TOKEN` (recommended) or `GITHUB_TOKEN` environment variable. The token is used in-memory and never saved to disk.
- See [SECURITY.md](./SECURITY.md) for details on the security model.

#### Scanning an entire GitHub organization (`scan-org`)

To get a complete security inventory of every backend service across your company or GitHub organization:

```bash
# 1. Scan all repositories in an organization (skips forks and archived repos by default):
npx --no-install express-recon scan-org --org acme \
  --concurrency 2 --max-repos 500 \
  --fail-on incomplete

# 2. Resume an interrupted scan (picks up right where it left off!):
npx --no-install express-recon scan-org --org acme \
  --concurrency 4 --max-repos 500 \
  --fail-on incomplete --resume

# 3. Update an existing scan (only rescans repos that had new git commits):
npx --no-install express-recon scan-org --org acme \
  --max-repos 500 --concurrency 2 --update

# 4. Compare today's scan with last month's scan to see newly added or removed routes:
npx --no-install express-recon scan-org --org acme \
  --baseline .express-recon/acme-before \
  --out .express-recon/acme-current --concurrency 2 --max-repos 500 \
  --fail-on incomplete
```

Organization scans always use durable output: omitting `--out` derives `.express-recon/<lowercase-organization>` from the current directory.

**Key features for organization scanning**:

- **Framework Detection**: Distinguishes Express, Fastify, and NestJS apps from packages that merely list the framework as a dependency.
- **Checkpoint & Resume (`--resume`)**: If your network disconnects or CI times out, running with `--resume` verifies SHA-256 digests and only scans incomplete or failed repositories.
- **Smart Updates (`--update`)**: Compares GitHub push commit markers and only scans repositories that have changed since the last inventory.
- **Delta Reports (`--baseline`)**: Compares two organization runs and generates `organization-delta.json`, detailing new routes, deleted routes, and auth regressions.
- **Token Efficiency for AI**: Set `EXPRESS_RECON_CONTEXT=agent` so AI assistants inspect the compact aggregate index first without wasting context tokens on massive logs. See the [AI agent guide](./docs/ai-agent-guide.md#keep-organization-scans-token-efficient).

Check out our production-ready [scheduled organization inventory example](./examples/github-actions/scheduled-org-inventory/README.md) for automated GitHub Actions workflows with Slack notifications.

---

### 6. Browsing Saved Reports as an Offline HTML Website (`render`)

Turn your JSON scan reports into a beautiful, static HTML website with an interactive Swagger UI:

```bash
# Render from the default .express-recon/ output directory:
npx --no-install express-recon render

# Render from an organization scan:
npx --no-install express-recon render \
  --input .express-recon/acme \
  --out .express-recon/acme-site

# Render a side-by-side comparison of changes between two scans:
npx --no-install express-recon render \
  --baseline .express-recon/acme-before \
  --input .express-recon/acme-current \
  --out .express-recon/acme-changes-site

# Render a single OpenAPI file with packaged Swagger UI:
npx --no-install express-recon render \
  --input .express-recon/docs/openapi.json \
  --out .express-recon/api-reference
```

With no paths, `render` looks only at the current directory, `.express-recon/`, and its immediate child directories. The default output is a sibling named `<input>-html`.

**Why the offline site is great**:

- **100% Offline**: Embedded CSS and JavaScript. Open `index.html` directly in your browser (`file://`) without running a web server or needing an internet connection.
- **Packaged Swagger UI**: Easily browse and inspect API endpoint contracts without sending live network requests.
- **Privacy & Security**: Built with a strict Content Security Policy (CSP). It disables external network calls, tracking, and remote analytics.

---

### 7. Enforcing Pull-Request Security Gates in CI/CD

Prevent developers from accidentally merging unauthenticated routes or breaking documentation:

```bash
# Step 1: Scan the base branch (e.g. main)
npx --no-install express-recon audit --src ./base --config recon.config.yaml \
  --format json --out ./base-results --fail-on incomplete

# Step 2: Scan the pull request and fail ONLY on newly introduced public routes or regressions:
npx --no-install express-recon audit --src ./current --config recon.config.yaml \
  --baseline ./base-results/routes.json \
  --format json,md --out ./current-results \
  --fail-on new,regression,incomplete
```

- If a developer introduces a new route without auth, `audit` exits with code `2`, blocking the PR.
- Existing accepted routes from the baseline do not cause false alarms.
- See our ready-to-copy [GitHub Actions PR workflow](./examples/github-actions/express-recon-pr.yml) with automated PR comments and annotations.

To send real-time alerts when new routes are merged:

- Use our [trusted Slack notifier example](./examples/github-actions/slack-new-routes/README.md) to post new endpoints directly to your team's Slack channel.
- Or use our [signed webhook example](./examples/github-actions/webhook-new-routes/README.md) for custom webhook listeners.
  The `notify` command emits bounded events for added/removed/semantically changed routes,
  authentication regressions, and incomplete scans from either a repository or
  organization comparison. Delivery uses HMAC-SHA256 Standard Webhooks headers,
  an exact committed hostname allowlist, HTTPS-only/no-redirect requests, current
  plus previous secret rotation, bounded retry, and deterministic event IDs for
  receiver-side deduplication. Secrets are read only from named environment
  variables; `--dry-run` needs neither a URL nor a secret.

```bash
npx --no-install express-recon notify \
  --input current-results/routes.json \
  --events routes.added,routes.changed,auth.regressed,scan.incomplete \
  --dry-run
```

## Runtime and hybrid trust boundary

Static mode is the default and is appropriate for untrusted source. Runtime and
hybrid modes import the app inside a bounded child process. That process contains
crashes, `process.exit()`, leaked timers, and serialized output, but it is **not
an OS sandbox**: trusted target code retains filesystem, process, and network
permissions.

```bash
# Explicit trusted entry:
npx --no-install express-recon inventory --mode hybrid --src . --app ./src/app.js

# Conservative auto-selection; fails unless discovery finds exactly one app and
# one high-confidence entry:
npx --no-install express-recon inventory --mode hybrid --src . \
  --app auto --allow-exec
```

The worker sets `EXPRESS_RECON_DRY=1`, starts with an isolated environment, and
can stub common infrastructure clients. Native ESM dependency imports are not
intercepted by the CommonJS stubbing layer. Full boot configuration and static
resolution details are in the [reference](./docs/reference.md) and
[security model](./SECURITY.md).

## MCP server for AI agents

The stdio MCP server exposes static local tools only. It cannot acquire remote
repositories or execute target code.

```jsonc
{
  "mcpServers": {
    "express-recon": {
      "command": "npx",
      "args": ["--no-install", "express-recon-mcp"],
    },
  },
}
```

Core tools include `discover_repository`, `inventory_routes`, `audit_routes`,
`query_audit`, `finding_by_fingerprint`, `suggest_auth`, `openapi_spec`,
`reconcile_openapi`, token-bounded `refresh_openapi`/`query_refresh`,
`review_middleware`, `import_middleware_review`, `validate_policies`, and
`report_schema`.

Useful requests are precise about the evidence boundary:

> Inventory every supported app in this repository. Group results by framework
> and application ID, and report coverage and partial paths before conclusions.

> Audit routes using `requireAuth` as the only confirmed authentication guard.
> List `public` and `unknown` separately; do not call either internet-reachable.

> Reconcile the selected app's existing OpenAPI document and report code-only,
> docs-only, conflicting, duplicate, and incomplete operations.

See the [AI agent guide](./docs/ai-agent-guide.md) for tool selection and a
required evidence checklist.

The MCP server intentionally has no remote or organization-scanning tool. Run
`scan-org` explicitly in the CLI, then give an agent the generated aggregate and
per-repository reports.

## Library

```js
const {
  inventory,
  audit,
  discover,
  buildReport,
  compareOrganizationReports,
  reconcileDocumentation,
  createMiddlewareReview,
  applyMiddlewareAssessments,
  scanRepository,
  scanOrganization,
  renderHtmlSite,
  buildNotificationEvents,
  deliverWebhook,
  signWebhook,
  validateNotificationEvent,
  verifyWebhookSignature,
  executeRuntime,
  formatters,
} = require("express-recon");

const source = inventory({ mode: "static", src: "." });
const report = buildReport(source, {
  command: "inventory",
  mode: "static",
  sourceRoot: ".",
});

console.log(formatters.markdown.format(report));

async function observeOrganization() {
  return scanOrganization("acme", {
    concurrency: 2,
    onProgress(event) {
      process.stderr.write(`${JSON.stringify(event)}\n`);
    },
  });
}

renderHtmlSite(".express-recon/acme", ".express-recon/acme-site");
```

Static library inventory supports Express, Fastify, and NestJS repositories.
Passing an already loaded Express app to `inventory()`/`audit()` executes it in
the caller's process; runtime and hybrid modes are Express-only. Prefer
`executeRuntime()` when a bounded worker result is needed. The
[library reference](./docs/reference.md#library-api) describes the
shared behavior; the [complete API reference](./docs/api.md) documents every
public export.

## Documentation

- [CLI, configuration, report, policies, modes, and library reference](./docs/reference.md)
- [Complete library API](./docs/api.md)
- [AI agent and middleware-review guide](./docs/ai-agent-guide.md)
- [OpenAPI/JSDoc reconciliation guide](./docs/openapi.md)
- [CI/CD examples](./examples/README.md)
- Bundled AI skills: [`express-recon-audit`](./skills/express-recon-audit/SKILL.md)
  and [`openapi-doc`](./skills/openapi-doc/SKILL.md)
- [Security and execution trust model](./SECURITY.md)
- [Contributing and local development](./CONTRIBUTING.md)
- [Release process](./RELEASING.md)

`npm run docs:coverage` derives the supported CLI, configuration, library, and
example surfaces from the repository and requires 100% documentation and public
API JSDoc coverage.

## Known boundaries

- Static analysis cannot fully recover data-driven route registration, arbitrary
  dependency injection, computed mounts, or every TypeScript resolution pattern.
  It retains partial evidence and diagnostics instead of silently dropping it.
- Documentation-only operations are split into verified and unverified drift
  when unresolved route graphs or opaque route providers prevent a sound stale-
  documentation conclusion.
- Auth classification is only as sound as the reviewed middleware allowlist.
- OpenAPI generation prefers statically resolved framework schemas, validators,
  DTOs, and returned literals over field-name placeholders. Unsupported
  computation and low/medium-confidence fragments remain explicitly unrefined;
  the bundled `openapi-doc` skill provides the deeper AI-assisted pass.
- `scan-repo` is non-executing, but Git protocol parsing and network transfer
  still process untrusted remote data.
- Organization scans are API-visible rather than proof of every repository that
  exists; token permissions define visibility.
- Runtime/hybrid mode is Express-only and for trusted local code only.

## Frequently asked questions (FAQ)

<details>
<summary><b>1. Does express-recon execute my backend code or start the server?</b></summary>

**In static mode (the default), no.** Static analysis parses your code's AST using `oxc-parser`, reading `.js` and `.ts` files as structured text without booting your server, connecting to databases, or executing any code. If you explicitly choose runtime or hybrid mode for advanced Express inspection, it executes trusted code in an isolated worker process.

</details>

<details>
<summary><b>2. Why did my audit command exit with code 2?</b></summary>

Exit code `2` is an intentional policy gate signal, not an application crash. With `--fail-on public,unknown`, `express-recon` returns exit code `2` when a route has no configured guard match (`public`) or has middleware that still requires review (`unknown`). In CI/CD, this stops the job on those configured policy findings; it does not prove that a route is internet-reachable or that a recognized guard is effective at runtime.

</details>

<details>
<summary><b>3. How do I mark an endpoint like /health or /login as public without failing the audit?</b></summary>

Add it to the `acceptedPublic` list in your `recon.config.yaml`:

```yaml
acceptedPublic:
  - "GET /health"
  - "POST /login"
```

Once listed, `audit` knows this route is intentionally open to the public and will not flag it as a violation.

</details>

<details>
<summary><b>4. Does it support TypeScript and path aliases?</b></summary>

**Yes!** `express-recon` parses TypeScript natively, resolves `tsconfig.json` path aliases (such as `@/controllers/*`), handles barrel exports (`index.ts`), and extracts TypeScript DTO validation schemas.

</details>

---

MIT licensed. Security issues should be reported privately as described in
[SECURITY.md](./SECURITY.md).
