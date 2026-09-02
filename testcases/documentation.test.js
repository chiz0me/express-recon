"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { collectCoverage } = require("../scripts/check-documentation-coverage");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "src", "cli.js");

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(target);
    return entry.isFile() && entry.name.endsWith(".md") ? [path.relative(ROOT, target)] : [];
  });
}

const DOCUMENTS = [
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "RELEASING.md",
  ...markdownFiles(path.join(ROOT, "docs")),
  ...markdownFiles(path.join(ROOT, "examples")),
  ...markdownFiles(path.join(ROOT, "skills")),
].sort();

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

test("supported public surfaces have 100% documentation coverage", () => {
  const report = collectCoverage();
  assert.equal(report.covered, report.total);
  assert.deepEqual(report.diagnostics, []);
  for (const category of report.categories) {
    assert.equal(category.covered, category.total, category.name);
    assert.deepEqual(category.missing, [], category.name);
  }
});

test("CLI help exposes onboarding, trust terminology, and exit codes", () => {
  const result = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  for (const alias of ["help", "-h"]) {
    const alternate = spawnSync(process.execPath, [CLI, alias], { encoding: "utf8" });
    assert.equal(alternate.status, 0, alternate.stderr);
    assert.equal(alternate.stdout, result.stdout);
  }
  const shortVersion = spawnSync(process.execPath, [CLI, "-V"], { encoding: "utf8" });
  assert.equal(shortVersion.status, 0, shortVersion.stderr);
  assert.equal(
    shortVersion.stdout,
    `${JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version}\n`,
  );
  assert.match(result.stdout, /Quick start \(offline; target code is not executed\)/);
  assert.match(result.stdout, /Terminology:/);
  assert.match(result.stdout, /public\s+no configured authentication guard matched/);
  assert.match(result.stdout, /Exit codes:/);
  assert.match(result.stdout, /--resume\s+resume a scan-org run/);
  assert.match(result.stdout, /--overwrite\s+start a fresh scan-org run/);
  assert.match(result.stdout, /--accept-enrichment\s+refresh: capture supported edits/);
  assert.match(result.stdout, /--no-render\s+refresh: update JSON artifacts/);
  assert.match(result.stdout, /--progress <mode>\s+scan-org progress on stderr/);
  assert.match(result.stdout, /--no-progress\s+alias for --progress none/);
  assert.match(result.stdout, /scan-org: compare with a prior organization output folder/);
  assert.match(result.stdout, /--no-ignore-file\s+disable the default\/configured/);
  assert.match(result.stdout, /--input <path>\s+OpenAPI 3 JSON\/YAML/);
  assert.match(result.stdout, /Optional when exactly one input is discoverable/);
  assert.match(result.stdout, /render defaults to a sibling <input>-html directory/);
  assert.match(result.stdout, /scan-org defaults to \.express-recon\/<lowercase-org>/);
  assert.match(result.stdout, /notify\s+Build bounded change events/);
  assert.match(result.stdout, /--dry-run\s+print unsigned notification events/);
  assert.match(result.stdout, /--allow-host <host>\s+exact non-local webhook hostname allowlist/);
  assert.match(result.stdout, /EXPRESS_RECON_WEBHOOK_SECRET/);
  assert.match(result.stdout, /EXPRESS_RECON_CONTEXT=agent/);
  assert.match(result.stdout, /scan-org uses its default output and progress mode none/);
  assert.match(result.stdout, /Existing output requires explicit --resume or --overwrite/);
  assert.match(result.stdout, /--version, -V\s+print the installed express-recon version/);
  assert.match(result.stdout, /--help, -h\s+show this message/);

  for (const command of [
    "discover",
    "inventory",
    "notify",
    "refresh",
    "audit",
    "suggest-auth",
    "docs",
    "help",
    "review-middleware",
    "import-review",
    "render",
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
  assert.ok(pkg.scripts["docs:coverage"], "package.json is missing the docs coverage script");
  assert.ok(pkg.scripts["logo:build"], "package.json is missing the logo build script");
  assert.equal(pkg.scarfSettings?.enabled, false, "installation analytics must remain disabled");
});

test("README npx examples cannot fetch a missing package", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.doesNotMatch(readme, /\bnpx express-recon\b/);
  assert.match(readme, /\bnpx --no-install express-recon\b/);
});

test("the bundled OpenAPI agent skill uses the offline renderer", () => {
  const skill = fs.readFileSync(path.join(ROOT, "skills", "openapi-doc", "SKILL.md"), "utf8");
  assert.match(skill, /express-recon render --input/);
  assert.match(skill, /api-reference\/index\.html/);
  assert.doesNotMatch(skill, /Rendering HTML is optional and outside express-recon/);
  assert.doesNotMatch(skill, /@redocly\/cli build-docs/);
  assert.match(skill, /express-recon refresh --src/);
  assert.match(skill, /--accept-enrichment/);
  assert.match(skill, /unreviewedOperations/);
});

test("persistent OpenAPI refresh and token-efficient review are documented", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const reference = fs.readFileSync(path.join(ROOT, "docs", "reference.md"), "utf8");
  const openapi = fs.readFileSync(path.join(ROOT, "docs", "openapi.md"), "utf8");
  const agentGuide = fs.readFileSync(path.join(ROOT, "docs", "ai-agent-guide.md"), "utf8");
  for (const document of [readme, reference, openapi, agentGuide]) {
    assert.match(document, /openapi\.enrichment\.json/);
    assert.match(document, /enrichmentSources/);
    assert.match(document, /stale/i);
  }
  assert.match(reference, /^### `refresh`$/m);
  assert.match(agentGuide, /Review only\s+`enrichment\.unreviewedOperations`/);
});

test("render path defaults and organization API pages are documented", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const reference = fs.readFileSync(path.join(ROOT, "docs", "reference.md"), "utf8");
  const agentGuide = fs.readFileSync(path.join(ROOT, "docs", "ai-agent-guide.md"), "utf8");
  for (const document of [readme, reference]) {
    assert.match(document, /immediate (?:child directories|\.express-recon\/ child)/);
    assert.match(document, /<input>-html/);
    assert.match(document, /OpenAPI/);
  }
  assert.match(agentGuide, /Agents should still\s+pass `--input` explicitly/);
  assert.match(agentGuide, /one shared local\s+bundle/);
});

test("organization scans document their durable default output", () => {
  const documents = [
    "README.md",
    "SECURITY.md",
    "docs/reference.md",
    "docs/ai-agent-guide.md",
    "skills/express-recon-audit/SKILL.md",
  ].map((file) => fs.readFileSync(path.join(ROOT, file), "utf8"));
  for (const document of documents) {
    assert.match(document, /\.express-recon\/<lowercase-(?:org|organization)>/);
  }
  assert.match(documents[0], /Organization scans always\s+use durable output/);
  assert.match(documents[3], /full\s+per-repository scans are never embedded in stdout/);
  assert.doesNotMatch(documents[3], /requires? `?--out/);
});
