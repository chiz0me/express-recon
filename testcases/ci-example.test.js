"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const YAML = require("yaml");

const ROOT = path.join(__dirname, "..");
const WORKFLOW = path.join(ROOT, "examples", "github-actions", "express-recon-pr.yml");

function source() {
  return fs.readFileSync(WORKFLOW, "utf8");
}

function actionUses(workflow) {
  return [...workflow.matchAll(/^\s*uses:\s+(actions\/[^@\s]+)@([^\s]+)/gm)];
}

test("the PR workflow is valid YAML with least-privilege permissions and bounded runtime", () => {
  const workflow = YAML.parse(source());
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.jobs.audit["timeout-minutes"], 10);
  assert.equal(workflow.concurrency["cancel-in-progress"], true);
});

test("the PR cannot replace the scanner, config, lockfile, or ignore policy used by its gate", () => {
  const workflow = source();
  assert.match(workflow, /cache-dependency-path: baseline\/package-lock\.json/);
  assert.match(workflow, /npm ci --ignore-scripts --prefix baseline/);
  assert.match(workflow, /baseline\/node_modules\/\.bin\/express-recon audit/g);
  assert.match(workflow, /--config baseline\/recon\.config\.json/g);
  assert.equal(
    (workflow.match(/--ignore-file "\$RUNNER_TEMP\/express-recon-pr\.ignore"/g) || []).length,
    2,
  );
  assert.match(workflow, /cp -- baseline\/\.express-reconignore/);
  assert.doesNotMatch(workflow, /current\/node_modules\/\.bin\/express-recon/);
  assert.doesNotMatch(workflow, /--config current\/recon\.config\.json/);
});

test("third-party actions are pinned and check output is capped", () => {
  const workflow = source();
  const uses = actionUses(workflow);
  assert.ok(uses.length >= 4);
  for (const [, action, revision] of uses) {
    assert.match(revision, /^[a-f0-9]{40}$/, `${action} must use a full commit SHA`);
  }
  assert.match(workflow, /const MAX_ANNOTATIONS = 50;/);
  assert.match(workflow, /const MAX_SUMMARY_ITEMS = 50;/);
  assert.match(workflow, /path\.isAbsolute\(source\.file\)/);
  assert.doesNotMatch(workflow, /cat current-results\/routes\.md/);
  const script = workflow.match(/node <<'NODE'\n([\s\S]*?)\n\s+NODE/);
  assert.ok(script, "workflow summary script is missing");
  assert.doesNotThrow(() => new vm.Script(script[1].replace(/^ {10}/gm, "")));
});

test("repository CI workflows are valid, time-bounded, least-privilege, and SHA-pinned", () => {
  const directory = path.join(ROOT, ".github", "workflows");
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const text = fs.readFileSync(path.join(directory, name), "utf8");
    const workflow = YAML.parse(text);
    assert.equal(workflow.permissions.contents, "read", `${name} needs read-only default contents`);
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      assert.ok(job["timeout-minutes"], `${name}:${jobName} needs a timeout`);
    }
    for (const [, action, revision] of actionUses(text)) {
      assert.match(revision, /^[a-f0-9]{40}$/, `${name}: ${action} must use a full commit SHA`);
    }
  }
});

test("CI covers docs, package contents, releases, and dependency update automation", () => {
  const ci = fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assert.doesNotMatch(ci, /npm ci(?! --ignore-scripts)/);
  assert.match(ci, /npm run docs:check/);
  assert.match(ci, /npm pack --dry-run/);
  assert.match(ci, /matrix\.node != '22'[\s\S]*npm test/);
  assert.match(ci, /matrix\.node == '22'[\s\S]*npm run test:coverage/);

  const publish = fs.readFileSync(path.join(ROOT, ".github", "workflows", "publish.yml"), "utf8");
  assert.doesNotMatch(publish, /npm ci(?! --ignore-scripts)/);
  assert.match(publish, /npm run check/);
  assert.match(publish, /npm run audit:prod/);
  assert.match(publish, /npm publish --provenance --access public/);

  const dependabot = YAML.parse(
    fs.readFileSync(path.join(ROOT, ".github", "dependabot.yml"), "utf8"),
  );
  assert.deepEqual(dependabot.updates.map((update) => update["package-ecosystem"]).sort(), [
    "github-actions",
    "npm",
  ]);
});

test("a successful npm publish synchronizes the Claude plugin marketplace safely", () => {
  const text = fs.readFileSync(path.join(ROOT, ".github", "workflows", "publish.yml"), "utf8");
  const workflow = YAML.parse(text);
  const sync = workflow.jobs["sync-marketplace"];
  assert.equal(sync.needs, "publish");
  assert.equal(sync["timeout-minutes"], 10);
  assert.deepEqual(sync.permissions, { contents: "read" });

  const checkout = sync.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.repository, "chiz0me/claude-plugins");
  assert.equal(checkout.with["ssh-key"], "${{ secrets.MARKETPLACE_SYNC_KEY }}");
  assert.equal(checkout.with["persist-credentials"], true);
  assert.equal(checkout.with.token, undefined);

  const update = sync.steps.find((step) => step.id === "update");
  assert.match(update.run, /plugin\.name === 'express-recon'/);
  assert.match(update.run, /target\.version === desired/);
  assert.match(update.run, /changed=false/);

  const push = sync.steps.find((step) => step.name === "Commit and push");
  assert.equal(push.if, "steps.update.outputs.changed == 'true'");
  assert.match(push.run, /git add \.claude-plugin\/marketplace\.json/);
  assert.match(push.run, /git@github\.com:chiz0me\/claude-plugins\.git/);
  assert.doesNotMatch(text, /MARKETPLACE_SYNC_TOKEN/);
});
