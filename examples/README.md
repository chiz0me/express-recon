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
