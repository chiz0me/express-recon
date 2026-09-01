"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const YAML = require("yaml");

const ROOT = path.join(__dirname, "..");
const DIRECTORY = path.join(ROOT, "examples", "github-actions", "scheduled-org-inventory");
const WORKFLOW = path.join(DIRECTORY, "express-recon-org.yml");
const STATE = path.join(DIRECTORY, "organization-ci.mjs");
const NOTIFIER = path.join(DIRECTORY, "notify-slack.mjs");

function actionUses(workflow) {
  return [...workflow.matchAll(/^\s*uses:\s+(actions\/[^@\s]+)@([^\s]+)/gm)];
}

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-org-example-"));
}

test("the scheduled organization workflow is bounded, resumable, and least privilege", () => {
  const source = fs.readFileSync(WORKFLOW, "utf8");
  const workflow = YAML.parse(source);
  assert.deepEqual(workflow.permissions, { actions: "read", contents: "read" });
  assert.deepEqual(workflow.on.schedule, [{ cron: "17 2 * * 1" }]);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.jobs.scan["timeout-minutes"], 180);
  assert.equal(workflow.jobs.notify["timeout-minutes"], 5);
  assert.equal(workflow.jobs.notify.needs, "scan");
  assert.match(workflow.jobs.notify.if, /always\(\)/);

  for (const [, action, revision] of actionUses(source)) {
    assert.match(revision, /^[a-f0-9]{40}$/, `${action} must use a full commit SHA`);
  }
  assert.match(source, /npm ci --ignore-scripts/);
  assert.match(source, /scan-org \\/);
  assert.match(source, /--progress plain/);
  assert.match(source, /2> >\(tee scan-progress\.log >&2\)/);
  assert.match(source, /steps\.state_action\.outputs\.scan_action/);
  assert.match(source, /path: previous-results/);
  assert.match(source, /baseline_args=\(\)/);
  assert.match(source, /--baseline "\$BASELINE_INPUT"/);
  assert.match(source, /digest-mismatch: error/g);
  assert.match(source, /retention-days: 14/g);
  assert.match(source, /retention-days: 1/);
  assert.match(source, /exit "\$scan_exit_code"/);
  assert.doesNotMatch(source, /--include-forks|--include-archived|--mode (?:runtime|hybrid)/);

  assert.equal((source.match(/secrets\.EXPRESS_RECON_GH_TOKEN/g) || []).length, 1);
  assert.equal((source.match(/secrets\.EXPRESS_RECON_SLACK_WEBHOOK_URL/g) || []).length, 1);
  const scanStep = workflow.jobs.scan.steps.find((step) => step.id === "scan_org");
  assert.equal(scanStep.env.GH_TOKEN, "${{ secrets.EXPRESS_RECON_GH_TOKEN || github.token }}");
  const notifyStep = workflow.jobs.notify.steps.find((step) =>
    step.name.startsWith("Notify Slack"),
  );
  assert.equal(notifyStep.env.SLACK_WEBHOOK_URL, "${{ secrets.EXPRESS_RECON_SLACK_WEBHOOK_URL }}");
  assert.equal(notifyStep.env.NOTIFY_CHANGES, "${{ vars.EXPRESS_RECON_NOTIFY_CHANGES || 'true' }}");
  assert.match(notifyStep.env.REPORT_READY, /steps\.summary_download\.outcome == 'success'/);
  const summaryDownload = workflow.jobs.notify.steps.find((step) => step.id === "summary_download");
  assert.equal(summaryDownload["continue-on-error"], true);
});

test("organization settings produce a scope-specific artifact name", async () => {
  const { parseSettings } = await import(pathToFileURL(STATE).href);
  const directory = temporaryDirectory();
  try {
    const config = path.join(directory, "config.json");
    const ignore = path.join(directory, "ignore");
    fs.writeFileSync(config, "{}\n");
    fs.writeFileSync(ignore, "# centrally managed\n");
    const first = parseSettings({
      organization: "example-org",
      maxRepositories: "500",
      concurrency: "2",
      fresh: "false",
      configFile: config,
      ignoreFile: ignore,
    });
    assert.equal(first.organization, "example-org");
    assert.equal(first.maxRepositories, 500);
    assert.equal(first.concurrency, 2);
    assert.equal(first.fresh, false);
    assert.match(first.stateArtifactName, /^express-recon-org-state-example-org-500-[a-f0-9]{16}$/);

    fs.writeFileSync(config, '{"scan":{"maxFiles":100}}\n');
    const changed = parseSettings({
      organization: "example-org",
      maxRepositories: "500",
      concurrency: "4",
      fresh: true,
      configFile: config,
      ignoreFile: ignore,
    });
    assert.notEqual(changed.stateArtifactName, first.stateArtifactName);
    assert.throws(
      () =>
        parseSettings({
          organization: "invalid/name",
          maxRepositories: "500",
          concurrency: "2",
          configFile: config,
          ignoreFile: ignore,
        }),
      /organization/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("restored state resumes only checkpoints and resets completed output", async () => {
  const { prepareState } = await import(pathToFileURL(STATE).href);
  const directory = temporaryDirectory();
  try {
    const root = path.join(directory, "org-results");
    fs.mkdirSync(path.join(root, "repositories", "api"), { recursive: true });
    fs.writeFileSync(path.join(root, "repositories", "api", "routes.json"), "{}\n");
    fs.writeFileSync(path.join(root, "organization-checkpoint.json"), "{}\n");
    fs.writeFileSync(path.join(root, "organization-inventory.json"), "{}\n");
    const resumed = prepareState(root, { fresh: false });
    assert.deepEqual(resumed, { scanAction: "--resume", resumedState: true });
    assert.equal(fs.existsSync(path.join(root, "organization-inventory.json")), false);
    assert.equal(fs.existsSync(path.join(root, "repositories", "api", "routes.json")), true);

    fs.rmSync(path.join(root, "organization-checkpoint.json"));
    fs.writeFileSync(path.join(root, "stale.json"), "{}\n");
    const reset = prepareState(root, { fresh: false });
    assert.deepEqual(reset, { scanAction: "--overwrite", resumedState: false });
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("workflow state keeps a completed inventory as baseline and moves checkpoints to resume", async () => {
  const { prepareWorkflowState } = await import(pathToFileURL(STATE).href);
  const directory = temporaryDirectory();
  try {
    const state = path.join(directory, "org-results");
    const restored = path.join(directory, "previous-results");
    fs.mkdirSync(restored);
    fs.writeFileSync(path.join(restored, "organization-inventory.json"), "{}\n");
    const baseline = prepareWorkflowState(state, restored, { fresh: false });
    assert.deepEqual(baseline, {
      scanAction: "--overwrite",
      resumedState: false,
      baselineInput: restored,
    });
    assert.ok(fs.existsSync(path.join(restored, "organization-inventory.json")));
    assert.deepEqual(fs.readdirSync(state), []);

    fs.rmSync(state, { recursive: true });
    fs.rmSync(restored, { recursive: true });
    fs.mkdirSync(restored);
    fs.writeFileSync(path.join(restored, "organization-checkpoint.json"), "{}\n");
    fs.writeFileSync(path.join(restored, "organization-inventory.json"), "{}\n");
    fs.writeFileSync(path.join(restored, "organization-delta.json"), "{}\n");
    fs.mkdirSync(path.join(restored, "comparison-baseline"));
    fs.writeFileSync(
      path.join(restored, "comparison-baseline", "organization-inventory.json"),
      "{}\n",
    );
    const resumed = prepareWorkflowState(state, restored, { fresh: false });
    assert.deepEqual(resumed, {
      scanAction: "--resume",
      resumedState: true,
      baselineInput: "",
    });
    assert.equal(fs.existsSync(restored), false);
    assert.ok(fs.existsSync(path.join(state, "organization-checkpoint.json")));
    assert.equal(fs.existsSync(path.join(state, "organization-inventory.json")), false);
    assert.equal(fs.existsSync(path.join(state, "organization-delta.json")), false);
    assert.ok(
      fs.existsSync(path.join(state, "comparison-baseline", "organization-inventory.json")),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("state validation rejects links and accepts a matching aggregate", async () => {
  const { inspectTree, validateState, validateReviewBundle } = await import(
    pathToFileURL(STATE).href
  );
  const directory = temporaryDirectory();
  try {
    const root = path.join(directory, "org-results");
    const site = path.join(directory, "org-site");
    fs.mkdirSync(root);
    fs.mkdirSync(site);
    fs.writeFileSync(
      path.join(root, "organization-inventory.json"),
      JSON.stringify({
        kind: "github-organization-inventory",
        organization: { login: "example-org" },
        repositories: [],
        delta: { artifact: "organization-delta.json" },
      }),
    );
    fs.writeFileSync(
      path.join(root, "organization-delta.json"),
      JSON.stringify({
        kind: "github-organization-inventory-delta",
        organization: { login: "example-org" },
        summary: {},
        repositories: [],
      }),
    );
    fs.writeFileSync(path.join(site, "index.html"), "<!doctype html><title>Inventory</title>");
    const progress = path.join(directory, "scan-progress.log");
    fs.writeFileSync(progress, "complete\n");
    const state = validateState(root, "example-org");
    assert.equal(state.reportReady, true);
    assert.equal(state.checkpointReady, false);
    assert.ok(validateReviewBundle(site, path.join(root, "organization-inventory.json"), progress));

    fs.symlinkSync(path.join(root, "organization-inventory.json"), path.join(root, "linked.json"));
    assert.throws(() => inspectTree(root), /symbolic link/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("state restoration selects the newest exact default-branch artifact", async () => {
  const { MAX_STATE_BYTES, selectRestorableArtifact } = await import(pathToFileURL(STATE).href);
  const base = {
    name: "express-recon-org-state-example-org-500-deadbeefdeadbeef",
    expired: false,
    size_in_bytes: 100,
    workflow_run: { head_branch: "main", head_repository_id: 99 },
  };
  const selected = selectRestorableArtifact(
    {
      artifacts: [
        {
          ...base,
          id: 1,
          created_at: "2026-01-01T00:00:00Z",
          workflow_run: { ...base.workflow_run, id: 10 },
        },
        {
          ...base,
          id: 2,
          created_at: "2026-02-01T00:00:00Z",
          workflow_run: { ...base.workflow_run, id: 11 },
        },
        {
          ...base,
          id: 3,
          created_at: "2026-03-01T00:00:00Z",
          workflow_run: { id: 12, head_branch: "feature", head_repository_id: 99 },
        },
      ],
    },
    { name: base.name, currentRunId: 20, defaultBranch: "main", repositoryId: 99 },
  );
  assert.deepEqual(selected, { artifactId: 2, runId: 11, bytes: 100 });
  assert.throws(
    () =>
      selectRestorableArtifact(
        {
          artifacts: [
            {
              ...base,
              id: 4,
              size_in_bytes: MAX_STATE_BYTES + 1,
              created_at: "2026-04-01T00:00:00Z",
              workflow_run: { ...base.workflow_run, id: 13 },
            },
          ],
        },
        { name: base.name, currentRunId: 20, defaultBranch: "main", repositoryId: 99 },
      ),
    /byte limit/,
  );
});

test("organization Slack messages are bounded and skip quiet successes", async () => {
  const { buildOrganizationNotification } = await import(pathToFileURL(NOTIFIER).href);
  const context = {
    repository: "owner/inventory",
    organization: "example-org",
    runId: "123456",
    scanExitCode: "2",
    jobResult: "failure",
    notifySuccess: false,
  };
  const repositories = Array.from({ length: 25 }, (_, index) => ({
    repository: { fullName: index === 0 ? "example-org/<@U123>&api" : `example-org/repo-${index}` },
    status: index % 2 ? "failed" : "inconclusive",
  }));
  const report = {
    kind: "github-organization-inventory",
    organization: { login: "example-org" },
    coverage: { complete: false },
    summary: {
      repositoriesDiscovered: 25,
      repositoriesScanned: 25,
      supportedRepositories: 9,
      expressRepositories: 4,
      fastifyRepositories: 3,
      nestjsRepositories: 2,
      routes: 100,
      failedRepositories: 12,
      inconclusiveRepositories: 13,
    },
    repositories,
  };
  const result = buildOrganizationNotification(report, context);
  const serialized = JSON.stringify(result.payload);
  assert.equal(result.problems, 25);
  assert.equal(result.shown, 20);
  assert.doesNotMatch(serialized, /<@U123>/);
  assert.match(serialized, /&lt;@U123&gt;&amp;api/);
  assert.match(serialized, /20 of 25 incomplete/);
  assert.match(serialized, /\*Supported:\* 9/);
  assert.match(serialized, /\*Fastify:\* 3/);
  assert.match(serialized, /\*NestJS:\* 2/);
  for (const block of result.payload.blocks) {
    if (block.type === "section") assert.ok(block.text.text.length <= 2_800);
  }

  const quiet = buildOrganizationNotification(
    { ...report, coverage: { complete: true }, repositories: [] },
    { ...context, scanExitCode: "0", jobResult: "success" },
  );
  assert.equal(quiet.payload, null);
  const changed = buildOrganizationNotification(
    {
      ...report,
      coverage: { complete: true },
      repositories: [],
      delta: {
        coverage: { complete: true },
        summary: {
          repositoriesChanged: 1,
          repositoriesAdded: 0,
          repositoriesRemoved: 0,
          addedRoutes: 2,
          removedRoutes: 1,
          authRegressions: 1,
        },
        repositories: [
          {
            repository: { fullName: "example-org/api" },
            change: "changed",
            before: { status: "express" },
            after: { status: "express" },
            routeChanges: { addedRoutes: 2, removedRoutes: 1, authRegressions: 1 },
          },
        ],
      },
    },
    { ...context, scanExitCode: "0", jobResult: "success", notifyChanges: true },
  );
  assert.equal(changed.changes, 1);
  assert.match(JSON.stringify(changed.payload), /New paths/);
  assert.match(changed.payload.text, /changed/);
  const comparisonFailed = buildOrganizationNotification(
    {
      ...report,
      coverage: { complete: true },
      repositories: [],
      delta: {
        coverage: {
          complete: false,
          incompleteRepositories: ["example-org/api"],
        },
        summary: { repositoriesChanged: 0 },
        repositories: [],
      },
    },
    { ...context, scanExitCode: "0", jobResult: "success" },
  );
  assert.equal(comparisonFailed.problems, 1);
  assert.match(JSON.stringify(comparisonFailed.payload), /comparison-incomplete/);
  const unresolvedRouteGraph = buildOrganizationNotification(
    {
      ...report,
      repositories: [
        {
          repository: { fullName: "example-org/api" },
          status: "fastify",
          coverageComplete: true,
          routeGraphComplete: false,
        },
      ],
    },
    context,
  );
  assert.equal(unresolvedRouteGraph.problems, 1);
  assert.ok(
    buildOrganizationNotification(null, { ...context, scanExitCode: "1", jobResult: "failure" })
      .payload,
  );
});

test("organization Slack dry-run makes no webhook request", () => {
  const directory = temporaryDirectory();
  try {
    const report = path.join(directory, "organization-inventory.json");
    fs.writeFileSync(
      report,
      JSON.stringify({
        kind: "github-organization-inventory",
        organization: { login: "example-org" },
        coverage: { complete: false },
        summary: { failedRepositories: 1 },
        repositories: [{ repository: { fullName: "example-org/api" }, status: "failed" }],
      }),
    );
    const result = spawnSync(process.execPath, [NOTIFIER, report], {
      encoding: "utf8",
      env: {
        ...process.env,
        EXPRESS_RECON_SLACK_DRY_RUN: "1",
        REPORT_READY: "true",
        REPOSITORY: "owner/inventory",
        ORGANIZATION: "example-org",
        RUN_ID: "123456",
        SCAN_EXIT_CODE: "2",
        SCAN_JOB_RESULT: "failure",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.text, /needs attention/);
    assert.doesNotMatch(result.stdout, /SLACK_WEBHOOK_URL/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
