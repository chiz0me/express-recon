# Releasing

The version lives in one place per concern and is kept in lockstep by tooling —
never hand-edit a version number.

- `package.json` — the npm version (source of truth).
- `.claude-plugin/plugin.json` — the Claude Code plugin version. Mirrored from
  `package.json` automatically by the `version` npm hook
  (`scripts/sync-version.js`). This version keys the installed plugin's cache
  directory, so it must match or users keep running stale code.
- The marketplace catalog (`chiz0me/claude-plugins`) mirrors `plugin.json`
  on its own schedule — nothing to do here.

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

Choosing the bump (pre-1.0 semver): `minor` for new behavior or a substantive
change in what the audit reports; `patch` for fixes that don't change output
shape.

## What the guardrails enforce

- `npm version` runs `scripts/sync-version.js`, so `package.json` and
  `plugin.json` can't diverge in a release commit.
- `prepublishOnly` and the publish workflow run `scripts/check-version.js`,
  which fails if `package.json`, `plugin.json`, and the release tag disagree —
  a mismatched release can't publish.
- Check manually any time with `npm run check:version`.

## After publishing

The marketplace catalog updates itself: `chiz0me/claude-plugins` runs a daily
`Sync plugin versions` workflow (also `workflow_dispatch`) that reads this repo's
`plugin.json` version and opens a PR when the catalog is stale. To update it
immediately, run that workflow manually instead of waiting for the schedule.
