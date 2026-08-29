"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "src", "cli.js");
const DOCUMENTS = [
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "RELEASING.md",
  "docs/reference.md",
  "docs/ai-agent-guide.md",
  "docs/openapi.md",
  "skills/express-recon-audit/SKILL.md",
  "skills/openapi-doc/SKILL.md",
];

function localLinks(markdown) {
  const links = [];
  const pattern = /\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = pattern.exec(markdown))) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    links.push(decodeURIComponent(target.split("#", 1)[0]));
  }
  return links;
}

test("documentation links resolve inside the repository", () => {
  for (const document of DOCUMENTS) {
    const file = path.join(ROOT, document);
    assert.ok(fs.existsSync(file), `missing documentation file ${document}`);
    const markdown = fs.readFileSync(file, "utf8");
    for (const link of localLinks(markdown)) {
      const target = path.resolve(path.dirname(file), link);
      assert.ok(fs.existsSync(target), `${document} has a broken link to ${link}`);
    }
  }
});

test("CLI help exposes onboarding, trust terminology, and exit codes", () => {
  const result = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Quick start \(offline; target code is not executed\)/);
  assert.match(result.stdout, /Terminology:/);
  assert.match(result.stdout, /public\s+no configured authentication guard matched/);
  assert.match(result.stdout, /Exit codes:/);
  assert.match(result.stdout, /--resume\s+resume a scan-org run/);
  assert.match(result.stdout, /--progress <mode>\s+scan-org progress on stderr/);
  assert.match(result.stdout, /--no-progress\s+alias for --progress none/);
  assert.match(result.stdout, /--no-ignore-file\s+disable the default\/configured/);
  assert.match(result.stdout, /EXPRESS_RECON_CONTEXT=agent/);
  assert.match(result.stdout, /scan-org requires --out and defaults progress to none/);

  for (const command of [
    "discover",
    "inventory",
    "audit",
    "suggest-auth",
    "docs",
    "review-middleware",
    "import-review",
    "scan-org",
    "scan-repo",
    "schema",
  ]) {
    assert.match(result.stdout, new RegExp(`\\n\\s+${command}(?:\\s|\\n)`));
  }
});

test("the npm package exposes only the intended runtime and agent surfaces", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(pkg.files, [
    "src",
    "skills",
    "LICENSE",
    "README.md",
    "src/cli.js",
    "src/mcp/server.js",
  ]);
  for (const target of Object.values(pkg.bin)) {
    assert.ok(fs.existsSync(path.join(ROOT, target)), `package bin target is missing ${target}`);
  }
  assert.ok(pkg.scripts.check, "package.json is missing the contributor check script");
  assert.ok(pkg.scripts["docs:check"], "package.json is missing the docs check script");
  assert.ok(pkg.scripts["logo:build"], "package.json is missing the logo build script");
});

test("README npx examples cannot fetch a missing package", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.doesNotMatch(readme, /\bnpx express-recon\b/);
  assert.match(readme, /\bnpx --no-install express-recon\b/);
});
