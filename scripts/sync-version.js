#!/usr/bin/env node
"use strict";

// Mirror package.json's version into the Claude Code plugin manifest, so the
// npm package and the installed plugin can never drift. Run automatically by
// the `version` npm lifecycle hook during `npm version <x>`, which then stages
// the manifest into the same version commit/tag.

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const manifestPath = path.join(root, ".claude-plugin", "plugin.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

if (manifest.version === version) {
  process.stdout.write(`plugin.json already at ${version}\n`);
} else {
  manifest.version = version;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write(`synced plugin.json ${version}\n`);
}
