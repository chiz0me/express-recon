#!/usr/bin/env node
"use strict";

// Fail when the npm version, the plugin manifest version, and an optional
// expected version (a release tag, passed as argv[2]) disagree. Wired into
// `prepublishOnly` locally and the publish workflow in CI so a release can
// never ship a mismatched set of versions.

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"),
).version;
const expected = (process.argv[2] || "").replace(/^v/, "") || null;

const problems = [];
if (pkg !== manifest)
  problems.push(`package.json (${pkg}) != .claude-plugin/plugin.json (${manifest})`);
if (expected && expected !== pkg) problems.push(`release tag (${expected}) != package.json (${pkg})`);

if (problems.length) {
  process.stderr.write("version check failed:\n  " + problems.join("\n  ") + "\n");
  process.stderr.write("Run `npm version <patch|minor|major>` to bump both in lockstep.\n");
  process.exit(1);
}
process.stdout.write(`versions consistent: ${pkg}\n`);
