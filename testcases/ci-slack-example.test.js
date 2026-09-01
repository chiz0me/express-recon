"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const vm = require("node:vm");
const YAML = require("yaml");

const ROOT = path.join(__dirname, "..");
const DIRECTORY = path.join(ROOT, "examples", "github-actions", "slack-new-routes");
const PRODUCER = path.join(ROOT, "examples", "github-actions", "express-recon-pr.yml");
const WORKFLOW = path.join(DIRECTORY, "express-recon-slack.yml");
const NOTIFIER = path.join(DIRECTORY, "notify-slack.mjs");

function actionUses(workflow) {
  return [...workflow.matchAll(/^\s*uses:\s+(actions\/[^@\s]+)@([^\s]+)/gm)];
}

test("the Slack notifier workflow has a trusted, least-privilege boundary", () => {
  const source = fs.readFileSync(WORKFLOW, "utf8");
  const workflow = YAML.parse(source);
  assert.deepEqual(workflow.on.workflow_run, {
    workflows: ["API route security review"],
    types: ["completed"],
  });
  const producer = fs.readFileSync(PRODUCER, "utf8");
  assert.equal(YAML.parse(producer).name, workflow.on.workflow_run.workflows[0]);
  assert.match(producer, /name: express-recon-pr-\$\{\{ github\.event\.pull_request\.number \}\}/);
  assert.match(
    source,
    /ARTIFACT_NAME: express-recon-pr-\$\{\{ github\.event\.workflow_run\.pull_requests\[0\]\.number \}\}/,
  );
  assert.deepEqual(workflow.permissions, { actions: "read", contents: "read" });
  assert.equal(workflow.jobs.notify["timeout-minutes"], 5);
  assert.match(workflow.jobs.notify.if, /pull_requests\[0\] != null/);
  assert.match(workflow.jobs.notify.if, /conclusion != 'cancelled'/);
  assert.doesNotMatch(source, /pull_request_target/);

  for (const [, action, revision] of actionUses(source)) {
    assert.match(revision, /^[a-f0-9]{40}$/, `${action} must use a full commit SHA`);
  }
  assert.match(source, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(source, /path: trusted/);
  assert.match(source, /const MAX_ARTIFACT_BYTES = 32 \* 1024 \* 1024/);
  assert.match(source, /artifact\.name === process\.env\.ARTIFACT_NAME && !artifact\.expired/);
  assert.match(source, /artifact-ids: \$\{\{ steps\.artifact\.outputs\.artifact_id \}\}/);
  assert.match(source, /run-id: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(source, /github-token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(source, /trusted\/\.github\/scripts\/express-recon-slack\.mjs/);
  assert.match(source, /secrets\.EXPRESS_RECON_SLACK_WEBHOOK_URL/);
  assert.equal((source.match(/secrets\.EXPRESS_RECON_SLACK_WEBHOOK_URL/g) || []).length, 1);
  assert.doesNotMatch(source, /hooks\.slack(?:-gov)?\.com\/services\//);

  const inlineScripts = [...source.matchAll(/node <<'NODE'\n([\s\S]*?)\n\s+NODE/g)];
  assert.equal(inlineScripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(inlineScripts[0][1].replace(/^ {10}/gm, "")));
});

test("Slack payloads are bounded and neutralize route-controlled markup", async () => {
  const { buildSlackNotification } = await import(pathToFileURL(NOTIFIER).href);
  const addedRoutes = Array.from({ length: 25 }, (_, index) => ({
    applicationId: "app:src/app.js#app",
    method: index === 0 ? "GET*<!channel>" : "GET",
    path: index === 0 ? "/users/<@U123>&`danger`" : `/route-${index}`,
    authStatus: "public",
    source: { file: index === 0 ? "src/routes|unsafe.js" : "src/routes.js", line: index + 1 },
  }));
  const result = buildSlackNotification(
    { delta: { addedRoutes } },
    {
      repository: "owner/repository",
      prNumber: "42",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      runId: "123456",
    },
  );
  const serialized = JSON.stringify(result.payload);
  assert.equal(result.total, 25);
  assert.equal(result.shown, 20);
  assert.doesNotMatch(serialized, /<!channel>|<@U123>/);
  assert.match(serialized, /&lt;@U123&gt;&amp;'danger'/);
  assert.match(serialized, /src\/routes%7Cunsafe\.js#L1/);
  assert.match(serialized, /Showing 20 of 25/);
  for (const block of result.payload.blocks) {
    if (block.type === "section") assert.ok(block.text.text.length <= 2_800);
  }
});

test("Slack notification skips empty deltas and validates webhook destinations", async () => {
  const { buildSlackNotification, validateSlackWebhookUrl } = await import(
    pathToFileURL(NOTIFIER).href
  );
  const context = {
    repository: "owner/repository",
    prNumber: "42",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    runId: "123456",
  };
  assert.equal(buildSlackNotification({ delta: { addedRoutes: [] } }, context).payload, null);
  const webhook = ["https://hooks.slack.com", "services", "T000", "B000", "placeholder"].join("/");
  assert.equal(validateSlackWebhookUrl(webhook), webhook);
  assert.throws(() => validateSlackWebhookUrl("http://hooks.slack.com/services/a/b/c"));
  assert.throws(() => validateSlackWebhookUrl("https://example.com/services/a/b/c"));
  assert.throws(() => buildSlackNotification({}, context), /--baseline/);
});

test("dry-run mode prints the Slack payload without a webhook", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-slack-"));
  try {
    const report = path.join(directory, "routes.json");
    fs.writeFileSync(
      report,
      JSON.stringify({
        delta: {
          addedRoutes: [{ method: "POST", path: "/orders", authStatus: "proven", source: null }],
        },
      }),
    );
    const result = spawnSync(process.execPath, [NOTIFIER, report], {
      encoding: "utf8",
      env: {
        ...process.env,
        EXPRESS_RECON_SLACK_DRY_RUN: "1",
        REPOSITORY: "owner/repository",
        PR_NUMBER: "42",
        HEAD_SHA: "0123456789abcdef0123456789abcdef01234567",
        RUN_ID: "123456",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.text, /1 new route/);
    assert.doesNotMatch(result.stdout, /SLACK_WEBHOOK_URL/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
