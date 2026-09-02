"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const vm = require("node:vm");
const YAML = require("yaml");

const ROOT = path.join(__dirname, "..");
const DIRECTORY = path.join(ROOT, "examples", "github-actions", "webhook-new-routes");
const PRODUCER = path.join(ROOT, "examples", "github-actions", "express-recon-pr.yml");
const WORKFLOW = path.join(DIRECTORY, "express-recon-webhook.yml");
const VERIFIER = path.join(DIRECTORY, "verify-webhook.mjs");
const README = path.join(DIRECTORY, "README.md");

function actionUses(workflow) {
  return [...workflow.matchAll(/^\s*uses:\s+(actions\/[^@\s]+)@([^\s]+)/gm)];
}

test("the signed webhook workflow preserves the privileged trust boundary", () => {
  const source = fs.readFileSync(WORKFLOW, "utf8");
  const workflow = YAML.parse(source);
  assert.deepEqual(workflow.on.workflow_run, {
    workflows: ["API route security review"],
    types: ["completed"],
  });
  assert.equal(YAML.parse(fs.readFileSync(PRODUCER, "utf8")).name, "API route security review");
  assert.deepEqual(workflow.permissions, { actions: "read", contents: "read" });
  assert.equal(workflow.jobs.notify["timeout-minutes"], 5);
  assert.match(workflow.jobs.notify.if, /pull_requests\[0\] != null/);
  assert.match(workflow.jobs.notify.if, /conclusion != 'cancelled'/);
  assert.doesNotMatch(source, /pull_request_target/);

  for (const [, action, revision] of actionUses(source)) {
    assert.match(revision, /^[a-f0-9]{40}$/, `${action} must use a full commit SHA`);
  }
  assert.match(source, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(source, /sparse-checkout: \|\s+package\.json\s+package-lock\.json/);
  assert.match(source, /npm ci --ignore-scripts --prefix trusted/);
  assert.match(source, /const MAX_ARTIFACT_BYTES = 32 \* 1024 \* 1024/);
  assert.match(source, /artifact\.name === process\.env\.ARTIFACT_NAME && !artifact\.expired/);
  assert.match(source, /artifact-ids: \$\{\{ steps\.artifact\.outputs\.artifact_id \}\}/);
  assert.match(source, /reports\/current-results\/routes\.json/);
  assert.match(source, /trusted\/node_modules\/\.bin\/express-recon notify/);
  assert.match(source, /--allow-host events\.example\.com/);
  assert.match(source, /EXPRESS_RECON_REVISION: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);

  for (const secret of [
    "EXPRESS_RECON_WEBHOOK_URL",
    "EXPRESS_RECON_WEBHOOK_SECRET",
    "EXPRESS_RECON_WEBHOOK_PREVIOUS_SECRET",
  ]) {
    assert.equal((source.match(new RegExp(`secrets\\.${secret}`, "g")) || []).length, 1);
  }
  assert.doesNotMatch(source, /--(?:url|secret)\s/);

  const inlineScripts = [...source.matchAll(/node <<'NODE'\n([\s\S]*?)\n\s+NODE/g)];
  assert.equal(inlineScripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(inlineScripts[0][1].replace(/^ {10}/gm, "")));
});

test("the receiver example verifies raw bytes before parsing", () => {
  const source = fs.readFileSync(VERIFIER, "utf8");
  const verification = source.indexOf("verifyWebhookSignature(rawBody");
  const parsing = source.indexOf("JSON.parse(");
  const validation = source.indexOf("validateNotificationEvent(event)");
  assert.ok(verification >= 0 && parsing > verification);
  assert.ok(validation > parsing);
  assert.match(source, /event\.id !== verified\.id/);
  const checked = spawnSync(process.execPath, ["--check", VERIFIER], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
});

test("the signed webhook guide documents rotation, replay defense, and dry-run", () => {
  const source = fs.readFileSync(README, "utf8");
  for (const token of [
    "EXPRESS_RECON_WEBHOOK_URL",
    "EXPRESS_RECON_WEBHOOK_SECRET",
    "EXPRESS_RECON_WEBHOOK_PREVIOUS_SECRET",
    "--allow-host",
    "--dry-run",
    "webhook-id",
    "raw body",
    "deduplicate",
    "CODEOWNERS",
  ]) {
    assert.match(source, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(source, /Do not call `express\.json\(\)` before signature verification/);
  assert.match(source, /Empty selected delta: succeeds without reading secrets/);
});
