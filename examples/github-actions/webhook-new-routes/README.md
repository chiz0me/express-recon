# Send signed route-change webhooks

This example sends bounded, provider-neutral events for new routes,
authentication regressions, or incomplete scans. It uses the same two-workflow
trust boundary as the Slack example: the pull-request job has no webhook secret,
then a `workflow_run` job on the trusted default branch validates the artifact
and invokes the packaged `notify` command.

Unlike a Slack incoming webhook, a receiver you control can authenticate the
request. express-recon follows the
[Standard Webhooks specification](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)
signing shape:

- `webhook-id` is a deterministic idempotency key for the event;
- `webhook-timestamp` is Unix time in seconds;
- `webhook-signature` contains one or two space-separated
  `v1,<base64-HMAC-SHA256>` values; and
- the signed bytes are `webhook-id + "." + timestamp + "." + raw body`.

The second signature supports current/previous-secret rotation. It is not a
replacement for HTTPS, endpoint authorization, a committed hostname allowlist,
or receiver-side replay protection.

GitHub warns that a `workflow_run` job can access secrets even when the
originating workflow could not, and that running untrusted code in that
privileged job can compromise the repository. This example therefore treats the
downloaded artifact only as bounded data and installs the notifier from the
reviewed default branch. See GitHub's
[`workflow_run` security warning](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run).

## Files to commit in the consuming repository

| Destination                                   | Source or purpose                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `.github/workflows/express-recon.yml`         | Copy [`../express-recon-pr.yml`](../express-recon-pr.yml).                         |
| `.github/workflows/express-recon-webhook.yml` | Copy [`express-recon-webhook.yml`](./express-recon-webhook.yml) and edit the host. |
| `package.json` and `package-lock.json`        | Pin the `express-recon` development dependency used by both workflows.             |
| `recon.config.json`                           | Reviewed, data-only authentication and policy configuration.                       |
| `.express-reconignore`                        | Stable repository-specific scan scope.                                             |
| `CODEOWNERS`                                  | Protect workflows, lockfile, config, and ignore policy.                            |

The receiver can adapt [`verify-webhook.mjs`](./verify-webhook.mjs). Keep the
actual receiver in the service that owns the endpoint; it does not need to be
committed in every scanned repository.

## Configure the sender

1. Install and lock the package:

   ```bash
   npm install --save-dev --save-exact express-recon
   ```

2. Copy the producer and notifier workflows shown above. In
   `express-recon-webhook.yml`, replace `events.example.com` with the exact
   public DNS hostname of your receiver. The CLI rejects HTTP, IP literals,
   localhost/local names, credentials, query strings, fragments, redirects, and
   hosts outside the committed `--allow-host` allowlist.

3. Generate at least 32 random bytes for the HMAC key, store the value at the
   receiver, and add these GitHub Actions repository secrets:

   ```text
   EXPRESS_RECON_WEBHOOK_URL
   EXPRESS_RECON_WEBHOOK_SECRET
   ```

   For example, `openssl rand -base64 32` creates a suitable opaque secret.
   Store the complete HTTPS endpoint in `EXPRESS_RECON_WEBHOOK_URL`; do not put
   a secret in its query string. The URL and key are read only from environment
   variables and never accepted as command arguments.

4. During rotation, deploy the new and old secrets to the receiver, make the new
   value `EXPRESS_RECON_WEBHOOK_SECRET`, and temporarily set
   `EXPRESS_RECON_WEBHOOK_PREVIOUS_SECRET` to the old value. Remove the old value
   after the longest sender retry/replay window has elapsed.

5. Protect `.github/workflows/express-recon*.yml`, `package.json`,
   `package-lock.json`, `recon.config.json`, and `.express-reconignore` with
   CODEOWNERS. A pull request must not choose the notifier, allowed destination,
   scanner version, or evidence policy that receives privileged secrets.

The workflow sends no request when the selected delta is empty. It sends at
most 20 detail objects per event by default; exact totals and complete evidence
remain in the short-retention artifact. Source locations are excluded unless
the trusted invocation adds `--include-source`.

## Verify at the receiver

Capture the exact request bytes before JSON parsing, reject stale timestamps,
then parse and validate the event. With Express, for example:

```js
app.post(
  "/hooks/express-recon",
  express.raw({ type: "application/json", limit: "256kb" }),
  async (req, res) => {
    const { event, id } = verifyExpressReconWebhook(req.body, req.headers, {
      secret: process.env.EXPRESS_RECON_WEBHOOK_SECRET,
      previousSecret: process.env.EXPRESS_RECON_WEBHOOK_PREVIOUS_SECRET,
    });

    // Atomically insert `id` into durable storage with a uniqueness constraint.
    // If it already exists, return 200 without processing the event twice.
    await processEventOnce(id, event);
    res.sendStatus(204);
  },
);
```

Do not call `express.json()` before signature verification on this route: even
equivalent parsed JSON is not the exact signed byte sequence. The library
verifier uses constant-time HMAC comparison and defaults to a five-minute
timestamp tolerance. It returns the event ID but deliberately does not claim
replay protection; the receiver must persist and atomically deduplicate that ID.

Return any 2xx status only after the event is durably accepted. The sender
retries network failures, 408, 425, 429, and selected 5xx statuses up to three
times with bounded backoff. It treats redirects and other non-2xx responses as
failures.

## Preview without a secret or network

```bash
npx --no-install express-recon notify \
  --input current-results/routes.json \
  --events routes.added,auth.regressed,scan.incomplete \
  --dry-run
```

The preview contains the exact unsigned event bodies but no signature, secret,
or endpoint. For an organization comparison, `--input` can instead point to
`organization-inventory.json` or `organization-delta.json`. Exact path details
are used when the full delta retains them; a compact aggregate sends exact
counts plus bounded repository summaries.

## Delivery failures

- Missing or malformed baseline delta: fails before reading endpoint secrets.
- Empty selected delta: succeeds without reading secrets or contacting a host.
- Missing/short secret, unsafe URL, host mismatch, invalid report, oversized
  input/event, timeout, redirect, or non-retryable HTTP response: fails visibly.
- Successful retry: keeps the same event ID and body, so receiver deduplication
  prevents duplicate work when an earlier response was lost.

Slack controls its receiver and does not support this custom signature scheme.
Use the separate [`Slack example`](../slack-new-routes/README.md) for Slack
incoming webhooks rather than treating a Slack URL as a generic endpoint.
