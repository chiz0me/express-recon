# Scheduled GitHub organization inventory

This example runs a weekly, static organization scan from a dedicated inventory
repository. It streams repository-level progress into the Actions log, restores
the latest compatible state, resumes incomplete work, renders an offline HTML
inventory, retains bounded artifacts, and sends inventory changes, failures, or
incomplete coverage to Slack.

Target repositories are fetched with a configured concurrency of 1–8; this
example starts conservatively at 2. `express-recon` removes every temporary
source snapshot in a `finally` block. Persisted state contains reports and
checkpoint integrity metadata, not cloned repositories, installed target
dependencies, or source trees.

## Files to commit in the inventory repository

| Destination                                   | Source or purpose                                                                               |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `.github/workflows/express-recon-org.yml`     | Copy [`express-recon-org.yml`](./express-recon-org.yml).                                        |
| `.github/scripts/express-recon-org-state.mjs` | Copy [`organization-ci.mjs`](./organization-ci.mjs).                                            |
| `.github/scripts/express-recon-org-slack.mjs` | Copy [`notify-slack.mjs`](./notify-slack.mjs).                                                  |
| `recon.org.config.json`                       | Copy [`recon.org.config.json`](./recon.org.config.json), then add only genuinely shared policy. |
| `.express-recon-org-ignore`                   | Copy [`express-recon-org-ignore`](./express-recon-org-ignore) and review the central scope.     |
| `package.json` and `package-lock.json`        | Pin the scanner used by the workflow.                                                           |
| `CODEOWNERS`                                  | Protect every control above plus the dependency lockfile.                                       |

Use a private, access-controlled inventory repository when the target
organization or its route metadata is private. Anyone who can read that
repository may be able to download its Actions artifacts.

## Set up

1. In the inventory repository, install and lock the scanner:

   ```bash
   npm install --save-dev --save-exact express-recon
   ```

2. Copy the workflow, both scripts, configuration, and ignore policy to the
   destinations above. The supplied `{}` config produces a judgment-free
   inventory. Add `authMiddleware`, policies, or accepted-public routes only
   when those conventions are genuinely shared across every scanned repository.

3. Configure repository variables as needed:

   | Variable                       |          Default | Purpose                                                                      |
   | ------------------------------ | ---------------: | ---------------------------------------------------------------------------- |
   | `EXPRESS_RECON_ORG`            | Repository owner | Organization login.                                                          |
   | `EXPRESS_RECON_MAX_REPOS`      |            `500` | Eligible repository cap, from 1 to 10,000.                                   |
   | `EXPRESS_RECON_CONCURRENCY`    |              `2` | Simultaneous temporary snapshots, from 1 to 8. Start low.                    |
   | `EXPRESS_RECON_NOTIFY_CHANGES` |           `true` | Send a summary when a completed baseline comparison finds inventory changes. |
   | `EXPRESS_RECON_NOTIFY_SUCCESS` |          `false` | Set `true` to send successful summaries as well as failures.                 |

   Manual runs can override the first three values and have a `fresh` switch.

4. For public repositories, the workflow's scoped `github.token` is enough. To
   inventory private repositories, add a repository or environment secret named
   `EXPRESS_RECON_GH_TOKEN`. Use a dedicated fine-grained, read-only credential
   that can list the target organization repositories and read their contents.
   Do not reuse a broad developer token.

5. To receive inventory changes and failures in Slack, create an incoming
   webhook for the intended channel and store its URL as the Actions secret
   `EXPRESS_RECON_SLACK_WEBHOOK_URL`. The webhook is exposed only to the separate
   notification job, after scanning has finished. Slack documents webhook URLs
   as secrets that must not be committed.

6. Protect the controls. A starting `CODEOWNERS` policy is:

   ```text
   /.github/workflows/express-recon-org.yml @your-org/platform-team
   /.github/scripts/express-recon-org-*.mjs @your-org/platform-team
   /package.json @your-org/platform-team
   /package-lock.json @your-org/platform-team
   /recon.org.config.json @your-org/platform-team
   /.express-recon-org-ignore @your-org/platform-team
   ```

## Resume and refresh behavior

Each run looks up one exact state-artifact name derived from the organization,
repository cap, config, and central ignore-policy content. It accepts only an
unexpired artifact created from this inventory repository's default branch and
checks its immutable artifact digest during download.

- If the restored state contains `organization-checkpoint.json`, the workflow
  uses `--resume`. Completed repositories with verified artifact digests are
  reused; failed, inconclusive, missing, or damaged entries are retried. If the
  interrupted run began with a baseline, its bounded `comparison-baseline/` is
  retained with the checkpoint and discovered automatically by the CLI.
- If the restored state contains a complete aggregate and no checkpoint, the
  restored directory remains read-only baseline evidence. A separate current
  output directory is created and scanned with `--baseline` plus `--overwrite`.
  The resulting `organization-delta.json` contains repository transitions and
  bounded exact path/auth changes.
- A manual run with `fresh: true` skips restoration and baseline comparison and
  uses `--overwrite`.
- If a scanner upgrade rejects an older checkpoint, run once with `fresh: true`
  rather than weakening checkpoint validation.

The workflow streams `--progress plain` through `tee`, so enumeration, active
repository phases, checkpoints, failures, resumes, and the final summary remain
visible in the job log and in `scan-progress.log`.

## Storage bounds and artifacts

The example rejects raw state or the review bundle above 256 MiB, more than
50,000 state files, aggregate or organization-delta JSON above 32 MiB, or
progress logs above 16 MiB.
The weekly schedule and explicit retention produce a small, expiring history:

| Artifact                      | Retention | Contents                                                                  |
| ----------------------------- | --------: | ------------------------------------------------------------------------- |
| `express-recon-org-state-…`   |   14 days | Raw reports, optional delta, and any resumable checkpoint.                |
| `express-recon-org-report-…`  |   14 days | Offline HTML site with change views, compact aggregate, and progress log. |
| `express-recon-org-summary-…` |     1 day | Compact aggregate used by the separate notification job.                  |

GitHub permits per-artifact retention periods and exposes artifact IDs, sizes,
expiry, digests, and originating workflow metadata through its Actions API. The
workflow uses those fields before restoring prior state. If you schedule more
frequently than weekly, shorten retention or lower the caps to match the
inventory repository's storage budget.

## Slack behavior

By default Slack is contacted when a completed baseline comparison finds
inventory changes, the scan job fails, exit code `2` reports incomplete
coverage, or the aggregate itself is incomplete. Set
`EXPRESS_RECON_NOTIFY_CHANGES=false` to keep only failure/incomplete messages.
The message contains aggregate and delta counts plus at most 20 changed and 20
failed, inconclusive, or limit-skipped repository names. It never sends path
names, full route inventories, or raw failure text.

To preview the message without a webhook or network request, download the
one-day summary artifact and run:

```bash
EXPRESS_RECON_SLACK_DRY_RUN=1 \
REPORT_READY=true \
REPOSITORY=owner/inventory-repository \
ORGANIZATION=owner \
RUN_ID=123456789 \
SCAN_EXIT_CODE=2 \
SCAN_JOB_RESULT=failure \
node .github/scripts/express-recon-org-slack.mjs organization-inventory.json
```

## Exit behavior

- `0`: complete inventory; artifacts are published. Slack reports baseline
  changes by default and otherwise stays quiet unless success notifications are
  enabled.
- `2`: expected completeness gate; resumable state, HTML, aggregate, and logs
  are uploaded before the job is marked failed.
- `1`: operational failure. Any valid checkpoint is still uploaded. If no
  aggregate was produced, Slack sends only a generic workflow-failure message.

The scanner job and notification job use separate runners and secrets. The
organization credential is available only to the static scan step; the Slack
webhook is available only to the notifier.
