# Examples

Copy these examples into the repository that you want to scan. They are
kept out of the npm package intentionally: install `express-recon` as a pinned
development dependency in the consuming repository so its lockfile controls the
scanner version used by CI.

## GitHub Actions

- [`github-actions/express-recon-pr.yml`](./github-actions/express-recon-pr.yml)
  compares the pull request with its base revision, adds bounded check output,
  and uploads the complete reports as an artifact.
- [`github-actions/slack-new-routes/`](./github-actions/slack-new-routes/README.md)
  builds on that audit and sends newly discovered method/path pairs to Slack
  without exposing the webhook to the pull-request job.
- [`github-actions/webhook-new-routes/`](./github-actions/webhook-new-routes/README.md)
  sends provider-neutral, HMAC-signed route-change events from a trusted
  `workflow_run` job and includes raw-body receiver verification guidance.
- [`github-actions/scheduled-org-inventory/`](./github-actions/scheduled-org-inventory/README.md)
  resumes interrupted organization scans, compares completed inventories,
  renders offline change views, bounds retained state, and reports changes or
  incomplete coverage to Slack.

The examples use static mode. Repository source is parsed as data; application
code is not imported or executed.

## Persistent OpenAPI state in CI

For a recurring API-documentation job, persist the complete tool-owned
`.express-recon/api` directory in a protected cache or artifact and run:

```bash
npx --no-install express-recon refresh --src . \
  --config recon.config.yaml \
  --fail-on enrichment-stale,routes-added,routes-changed,contract-breaking
```

The first run has no route or OpenAPI baseline. Later runs place route changes
in `.express-recon/api/routes.json` and semantic contract changes in
`.express-recon/api/openapi-delta.json`. The route report can be passed directly
to the existing Slack or signed-webhook notification examples, including the
`routes.changed` event. Upload
`refresh-report.json`, `openapi.json`, and `api-reference/` for review. Keep the
whole state together: its manifest intentionally rejects partial, extra, or
unexpectedly modified files. Never restore a protected default-branch state from an
untrusted pull-request cache, and never put webhook secrets in the refresh job.

AI enrichment should be accepted in a separately authorized documentation job
or developer workflow, not silently by CI. A normal refresh fails if
`openapi.json` was edited without `--accept-enrichment`; this prevents a cache
or workspace modification from being promoted automatically.
