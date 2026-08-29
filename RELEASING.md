# Releasing

The version lives in one place per concern and is kept in lockstep by tooling —
never hand-edit a version number.

- `package.json` — the npm version (source of truth).
- `.claude-plugin/plugin.json` — the Claude Code plugin version. Mirrored from
  `package.json` automatically by the `version` npm hook
  (`scripts/sync-version.js`). This version keys the installed plugin's cache
  directory, so it must match or users keep running stale code.
- The marketplace catalog (`chiz0me/claude-plugins`) is updated by the publish
  workflow after npm publishing succeeds. Its daily sync workflow remains a
  fallback.

## Cut a release

```sh
npm version minor      # patch | minor | major — bumps package.json AND
                       # plugin.json in one commit, tags vX.Y.Z
git push --follow-tags
```

Then create a GitHub Release from the new tag (`gh release create vX.Y.Z
--generate-notes`). Publishing the release triggers `.github/workflows/publish.yml`,
which verifies the versions agree and publishes to npm via OIDC trusted
publishing.

### One-time marketplace setup

The `sync-marketplace` job needs a repository Actions secret named
`MARKETPLACE_SYNC_KEY`. Generate a dedicated SSH key, add its public half to
`chiz0me/claude-plugins` as a write-enabled deploy key, and store the private
half as that secret in `chiz0me/express-recon`. A deploy key is intentionally
scoped to the marketplace repository instead of granting access to the user's
other repositories. Keep the secret outside the `npm-publish` environment: the
marketplace job runs only after the protected publish job succeeds. Checkout
stores the key under the runner's temporary directory and removes it during
post-job cleanup.

Choosing the bump (pre-1.0 semver): `minor` for new behavior or a substantive
change in what the audit reports; `patch` for fixes that don't change output
shape.

## What the guardrails enforce

- `npm version` runs `scripts/sync-version.js`, so `package.json` and
  `plugin.json` can't diverge in a release commit.
- `prepublishOnly` and the publish workflow run `scripts/check-version.js`,
  which fails if `package.json`, `plugin.json`, and the release tag disagree —
  a mismatched release can't publish.
- The publish workflow reruns lint, formatting, coverage, documentation,
  production dependency audit, and a package dry run before an OIDC/provenance
  publish.
- After npm succeeds, `sync-marketplace` changes only the `express-recon`
  version in `.claude-plugin/marketplace.json`. It is idempotent, so rerunning a
  successful release workflow does not create an empty commit.
- Check manually any time with `npm run check:version`.

## After publishing

The publish workflow updates the marketplace immediately after npm succeeds.
Verify the published catalog version with:

```sh
gh api \
  -H "Accept: application/vnd.github.raw+json" \
  repos/chiz0me/claude-plugins/contents/.claude-plugin/marketplace.json \
  --jq '.plugins[] | select(.name == "express-recon") | .version'
```

If the direct sync fails because the deploy key was removed or the marketplace
branch moved concurrently, restore the key or rerun the failed job. The
marketplace's daily `Sync plugin versions` workflow (also available via
`workflow_dispatch`) will still detect and propose a stale version as a
fallback.
