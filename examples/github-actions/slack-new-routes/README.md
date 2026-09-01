# Send new API routes to Slack

This example posts a bounded Slack message when a pull request adds Express,
Fastify, or NestJS routes. It reads the `delta.addedRoutes` array produced by `express-recon`, so a
message contains method, path, authentication classification, and source
location when available. The complete JSON and Markdown reports remain in the
GitHub Actions artifact.

The example uses two workflows:

1. The pull-request audit scans the base and head revisions without secrets and
   uploads their reports.
2. A `workflow_run` notifier from the trusted default branch resolves one exact,
   size-bounded artifact, downloads the report, validates it, and sends only the
   added-route summary to an incoming Slack webhook.

This separation matters for public repositories and forked pull requests:
[GitHub does not pass Actions secrets to fork-triggered pull-request
workflows](https://docs.github.com/en/code-security/reference/secret-security/secret-types),
while a later trusted workflow can receive a secret without executing pull
request code. Do not collapse this into a `pull_request_target` job that checks
out and executes untrusted code; GitHub documents that as a privileged-event
risk.

## Files to commit in the consuming repository

| Destination                                 | Source or purpose                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| `.github/workflows/express-recon.yml`       | Copy [`../express-recon-pr.yml`](../express-recon-pr.yml).                       |
| `.github/workflows/express-recon-slack.yml` | Copy [`express-recon-slack.yml`](./express-recon-slack.yml).                     |
| `.github/scripts/express-recon-slack.mjs`   | Copy [`notify-slack.mjs`](./notify-slack.mjs).                                   |
| `package.json` and `package-lock.json`      | Pin the `express-recon` development dependency used by CI.                       |
| `recon.config.json`                         | Reviewed, data-only authentication and policy configuration.                     |
| `.express-reconignore`                      | Stable repository-specific scan scope.                                           |
| `.gitignore`                                | Ignore `baseline-results/`, `current-results/`, and other generated reports.     |
| `CODEOWNERS`                                | Require review for the workflows, notifier, lockfile, config, and ignore policy. |

No generated route report needs to be committed for this pull-request model.
That avoids putting route/source metadata in Git history and avoids a baseline
that must be advanced after every merge.

## Set up

1. Install and lock the scanner:

   ```bash
   npm install --save-dev --save-exact express-recon
   ```

2. Create `recon.config.json`. Start with an empty mapping if the immediate goal
   is route-change reporting, then replace it with middleware names that you
   have actually reviewed:

   ```json
   {
     "authMiddleware": {}
   }
   ```

   Run `npx --no-install express-recon suggest-auth --src .` to find candidates.
   Authentication labels in Slack are configuration-relative; an empty mapping
   will classify unguarded/unrecognized routes as public.

3. Add a root-relative `.express-reconignore` for generated, vendored, or
   otherwise out-of-scope source. Keep the same rules for both sides of the
   comparison.

4. Copy the three example files to the destinations in the table. Keep the
   audit workflow name `API route security review`; if you rename it, update
   `workflows:` in `express-recon-slack.yml` to the exact same name.
   `workflow_run` workflows must be present on the default branch, so the setup
   pull request itself will not send a notification; later pull requests will.

5. In Slack, create an incoming webhook for the destination channel. Slack
   treats the webhook URL as a secret and says not to commit it. Add it in the
   consuming GitHub repository under **Settings → Secrets and variables →
   Actions** with this name:

   ```text
   EXPRESS_RECON_SLACK_WEBHOOK_URL
   ```

6. Protect the committed control files. A starting `CODEOWNERS` policy is:

   ```text
   /.github/workflows/express-recon*.yml @your-org/platform-team
   /.github/scripts/express-recon-slack.mjs @your-org/platform-team
   /package.json @your-org/platform-team
   /package-lock.json @your-org/platform-team
   /recon.config.json @your-org/platform-team
   /.express-reconignore @your-org/platform-team
   ```

7. Open a pull request that adds a route. The audit workflow uploads an artifact
   named `express-recon-pr-<number>`. The notifier posts only when
   `report.delta.addedRoutes` is non-empty. It posts at most 20 routes and links
   to the pull request, audit run, and safe repository-relative source
   locations.

## See exactly what will be sent

Download the audit artifact and run the notifier without a webhook:

```bash
EXPRESS_RECON_SLACK_DRY_RUN=1 \
REPOSITORY=owner/repository \
PR_NUMBER=123 \
HEAD_SHA=0123456789abcdef0123456789abcdef01234567 \
RUN_ID=123456789 \
node .github/scripts/express-recon-slack.mjs current-results/routes.json
```

Dry-run mode prints the Slack JSON payload and makes no network request. To list
all added paths directly from the report:

```bash
node -e 'const r=require("./current-results/routes.json"); console.table(r.delta.addedRoutes.map(({applicationId,method,path,authStatus,source})=>({applicationId,method,path,authStatus,source:source?.file})))'
```

## Committed-baseline alternative

For scheduled scans or a default-branch job without a base revision, generate a
route-only baseline explicitly:

```bash
npx --no-install express-recon inventory --src . --format json \
  --out .express-recon/baseline

npx --no-install express-recon inventory --src . \
  --baseline .express-recon/baseline/routes.json \
  --format json --out current-results
```

After review, commit `.express-recon/baseline/routes.json` and advance it when a
route change is accepted. A committed report can expose route and source
metadata, so use this model only when that inventory belongs in the repository.
The same notifier can consume `current-results/routes.json` when its GitHub
context environment variables and Slack secret are supplied by the CI system.

## Failure behavior

- No added routes: succeeds without contacting Slack.
- Missing, duplicate, expired, or oversized artifact; malformed or oversized
  report; missing secret; non-Slack webhook host; or a non-2xx Slack response:
  fails visibly.
- More than 20 new routes: Slack receives the first 20 in deterministic report
  order and a truncation notice; the artifact remains the source of truth.
- Canceled PR scan: the notifier does not run.

Incoming webhooks accept JSON and Block Kit messages, return HTTP errors for
invalid requests, and cannot delete a posted message. See Slack's official
[incoming webhook guide](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/).
