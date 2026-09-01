# Contributing

Thanks for helping improve express-recon. The project favors deterministic,
fail-visible evidence over optimistic inference. A scanner change is complete
only when its uncertainty, coverage behavior, machine contract, docs, and tests
agree.

## Local setup

Requirements: Node.js `^20.19.0` or `>=22.12.0` and Git.

```bash
git clone https://github.com/chiz0me/express-recon.git
cd express-recon
npm ci
npm test
```

Before opening a pull request, run:

```bash
npm run check
npm run audit:prod
```

`npm run check` runs linting, formatting checks, documentation coverage, the
coverage-gated suite, and the version-consistency guard. `npm run docs:check`
is the focused documentation-coverage and link/help/package-surface check.

Use `npx oxfmt src testcases` to format JavaScript. `npm run fmt` formats the
whole repository, including Markdown and fixtures, so use it only when those
broader changes are intentional.

### Development script index

| Script                   | Purpose                                                                |
| ------------------------ | ---------------------------------------------------------------------- |
| `npm run check`          | Run every required local quality gate.                                 |
| `npm run docs:check`     | Run documentation coverage plus focused documentation tests.           |
| `npm run docs:coverage`  | Measure and require complete supported-surface documentation.          |
| `npm test`               | Run the complete Node test suite without coverage thresholds.          |
| `npm run test:coverage`  | Run tests with enforced line, branch, and function thresholds.         |
| `npm run lint`           | Run `oxlint`.                                                          |
| `npm run fmt`            | Format the repository with `oxfmt`.                                    |
| `npm run fmt:check`      | Check formatting for `src/` and `testcases/`.                          |
| `npm run logo:build`     | Rebuild committed SVG variants; add `-- --social` for the preview PNG. |
| `npm run audit:prod`     | Audit production dependencies at high severity.                        |
| `npm run check:version`  | Verify package, CLI/plugin, and generated version consistency.         |
| `npm run version`        | Synchronize versioned plugin metadata during npm versioning.           |
| `npm run prepublishOnly` | Re-run the version guard immediately before publication.               |

## Repository map

| Area                                | Responsibility                                                          |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `src/static/`                       | Shared AST/resolution limits plus Express, Fastify, and NestJS adapters |
| `src/runtime/`                      | Trusted app boot worker and runtime route observation                   |
| `src/discover.js`                   | Packages, apps, entries, and API-document discovery                     |
| `src/docs.js`                       | OpenAPI/JSDoc/inventory reconciliation and drift evidence               |
| `src/review.js`                     | Bounded middleware evidence and advisory assessment validation          |
| `src/repository.js`                 | Non-executing Git acquisition/materialization                           |
| `src/organization.js`               | GitHub pagination, bounded worker orchestration, aggregate inventory    |
| `src/organization-checkpoint.js`    | Atomic resume checkpoints and artifact integrity validation             |
| `src/organization-progress.js`      | TTY, plain CI, JSONL, and quiet progress rendering                      |
| `src/organization-compare.js`       | Bounded organization baseline and route-change comparison               |
| `src/classify.js`                   | Config-relative auth classification                                     |
| `src/policies.js`                   | Policy validation and deterministic evaluation                          |
| `src/report.js`, `src/schema.js`    | Versioned report contract                                               |
| `src/formatters/`                   | JSON-adjacent, Markdown, terminal, and OpenAPI output                   |
| `src/html.js`, `src/html-assets.js` | Offline report sites, packaged Swagger UI, and output ownership         |
| `src/cli.js`                        | CLI parsing, validation, artifacts, and exit codes                      |
| `src/mcp/server.js`                 | Static local MCP tool surface                                           |
| `testcases/fixtures/`               | Small repositories encoding scanner behavior                            |
| `skills/`                           | Bundled audit and OpenAPI workflows for coding agents                   |

## Design invariants

- Static/offline is the default. Never import target code during discovery,
  static inventory, docs reconciliation, middleware review, or remote scans.
- Rendered sites must remain usable through `file://`: package browser assets
  locally, keep organization OpenAPI pages on one shared bundle, keep request
  execution and browser connections disabled, retain third-party license
  notices, and list every generated file in the manifest.
- Preserve bounded render-input discovery plus sibling output derivation in the
  CLI. Never recurse through source to guess a report or choose among multiple
  saved scans.
- Inventory records evidence; audit applies reviewed security decisions. Do not
  add auth judgment to inventory output.
- `public` and `proven` are relative to explicit configuration. Neither is a
  deployment/reachability claim.
- Keep separate framework/application identities separate across findings,
  baselines, policies, comparison, and OpenAPI metadata.
- Preserve partial and conflicting evidence. Do not silently drop routes that
  cannot be fully resolved.
- Output ordering, paths, fingerprints, and diagnostics must be deterministic
  across machines.
- Limits and parse/read failures must make coverage incomplete and remain
  visible in machine output.
- Runtime/hybrid is an explicit, Express-only trusted-code boundary. The worker
  is not an OS sandbox.
- AI middleware classification is advisory. Only reviewed config may influence
  a deterministic audit.
- Remote acquisition never installs dependencies, checks out a worktree,
  follows symlinks/submodules, or executes target/config code.
- Organization concurrency must retain per-repository cleanup, token redaction,
  failure isolation, and an incomplete rather than negative classification when
  evidence is truncated.
- Organization CLI scans must remain durable by default under
  `.express-recon/<lowercase-organization>`; never restore the unbounded
  aggregate-on-stdout path or weaken existing resume/overwrite conflict checks.
- Organization progress stays on stderr, uses versioned events, reports only
  monotonic terminal counters, and never changes scan evidence when an observer
  or output stream fails.
- Execution context changes organization output/progress defaults only. Explicit
  progress flags take precedence, and context must never change scan evidence or
  scope fingerprints.

## Development workflow

### Change static scanner behavior

Add or reduce a focused fixture under `testcases/fixtures/`, then write a test
that asserts the route, source, middleware order, app identity, path confidence,
and diagnostics that matter. Include a negative or ambiguity case when the new
logic could over-resolve code. Run the full suite because resolver changes often
affect discovery, OpenAPI, and classification together.

### Add or change report fields

Update the report builder and `src/schema.js` together. Decide whether the
change is compatible with schema version `2.0`; change the schema version only
for an intentional contract break. Add deterministic-output and schema tests,
then update [docs/reference.md](./docs/reference.md).

### Add a CLI command or option

Update argument parsing, per-command option validation, `--help`, output/error
handling, and CLI tests. Document artifacts and exit behavior. Unsupported
option combinations should fail with a useful message instead of being ignored.

### Add or change an MCP tool

Keep the MCP surface static/local and use strict input schemas. Tool descriptions
must state the evidence and trust boundary. Test success and structured error
paths, then update [docs/ai-agent-guide.md](./docs/ai-agent-guide.md) and the
README tool list.

### Change middleware review

Assessment schemas are strict and provider-neutral. Preserve source-as-untrusted
notices, exact bundle/candidate fingerprints, fail-closed validation, and the
rule that imports never edit config or alter an audit. New eligible suggestion
types require explicit tests and documentation.

### Change OpenAPI reconciliation

Preserve authored precedence, conflicts, generated-field provenance,
idempotence, multi-app selection, and placeholder markers. Add a round-trip test
and update [docs/openapi.md](./docs/openapi.md).

## Tests and fixtures

Tests use Node's built-in test runner:

```bash
# Full suite
npm test

# One file
node --test testcases/docs.test.js

# Coverage gates
npm run test:coverage

# Public documentation coverage
npm run docs:coverage
```

Prefer minimal text fixtures over mocks for AST/resolution behavior. Temporary
files created by a test must be removed in `finally`. Tests should not require
network access, credentials, user-specific absolute paths, or a live service.

For CLI gates, remember that exit code `2` is a successful scan whose requested
condition matched. Exit code `1` is invalid input or an operational failure.

## Documentation changes

Keep the README focused on first success and workflow choice. Put durable option,
schema, and configuration detail in the reference; AI-specific rules in the
agent guide; and reconciliation detail in the OpenAPI guide. Examples must use
current command names and preserve the offline/trusted-code distinction.

Documentation coverage is an enforced public-surface metric, not a prose line
count. The checker requires coverage for every CLI command and long option,
environment variable exposed in help, package export, validated configuration
field, and example file. Every public function also needs adjacent JSDoc, and
every package export needs an `ExpressReconAPI` property comment in
`src/index.js`. The total must remain 100%; exclusions are not supported.

When behavior changes, update all affected surfaces:

- CLI `--help`;
- README/reference/task guide;
- bundled skill instructions;
- MCP tool description, if applicable;
- package contents and documentation-link tests.

If a public export changes, update [docs/api.md](./docs/api.md) and its JSDoc. If
a validated configuration key changes, update the complete field index in
[docs/reference.md](./docs/reference.md#complete-configuration-field-index).

## Pull requests

Keep changes scoped and explain the evidence boundary they affect. Include:

- the problem and expected behavior;
- tests or fixtures that demonstrate it;
- compatibility/report-schema impact;
- offline, execution, or untrusted-input implications;
- documentation updates.

Do not rewrite unrelated user changes in a dirty worktree. Avoid generated or
vendored fixtures unless they are essential to reproduce the issue.

For versioning and publication, follow [RELEASING.md](./RELEASING.md). Security
issues should be reported privately as described in [SECURITY.md](./SECURITY.md).
