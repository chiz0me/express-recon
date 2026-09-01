import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_STATE_BYTES = 256 * 1024 * 1024;
export const MAX_REVIEW_BYTES = 256 * 1024 * 1024;
export const MAX_AGGREGATE_BYTES = 32 * 1024 * 1024;
export const MAX_DELTA_BYTES = 32 * 1024 * 1024;
export const MAX_PROGRESS_BYTES = 16 * 1024 * 1024;
export const MAX_TREE_FILES = 50_000;
const MAX_CONTROL_BYTES = 1024 * 1024;

function integer(value, label, minimum, maximum) {
  if (!/^[0-9]+$/.test(String(value ?? ""))) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function boolean(value, label) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false" || value === undefined || value === "") return false;
  throw new Error(`${label} must be true or false`);
}

function regularFile(file, label, maximum = MAX_CONTROL_BYTES) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (stat.size <= 0 || stat.size > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum} bytes`);
  }
  return stat;
}

function sha256(...values) {
  const hash = crypto.createHash("sha256");
  for (const value of values) {
    hash.update(value);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function parseSettings(input) {
  const organization = String(input.organization ?? "").trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(organization)) {
    throw new Error("organization must be a valid GitHub organization login");
  }
  const maxRepositories = integer(input.maxRepositories, "max repositories", 1, 10_000);
  const concurrency = integer(input.concurrency, "concurrency", 1, 8);
  const fresh = boolean(input.fresh, "fresh");
  regularFile(input.configFile, "organization config");
  regularFile(input.ignoreFile, "organization ignore policy");
  const config = fs.readFileSync(input.configFile);
  const ignore = fs.readFileSync(input.ignoreFile);
  try {
    const parsed = JSON.parse(config.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("top-level value must be an object");
    }
  } catch (error) {
    throw new Error(`organization config must be valid JSON: ${error.message}`);
  }
  const scopeHash = sha256(config, ignore).slice(0, 16);
  return {
    organization,
    maxRepositories,
    concurrency,
    fresh,
    stateArtifactName: `express-recon-org-state-${organization.toLowerCase()}-${maxRepositories}-${scopeHash}`,
  };
}

function timestamp(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function selectRestorableArtifact(payload, options) {
  const artifacts = Array.isArray(payload?.artifacts) ? payload.artifacts : [];
  const candidates = artifacts
    .filter(
      (artifact) =>
        artifact?.name === options.name &&
        artifact.expired === false &&
        artifact.workflow_run?.id !== options.currentRunId &&
        artifact.workflow_run?.head_branch === options.defaultBranch &&
        artifact.workflow_run?.head_repository_id === options.repositoryId,
    )
    .sort(
      (left, right) =>
        timestamp(right.created_at) - timestamp(left.created_at) ||
        (right.id || 0) - (left.id || 0),
    );
  if (candidates.length === 0) return null;
  const artifact = candidates[0];
  if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0) {
    throw new Error("restorable state artifact has an invalid ID");
  }
  if (
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes <= 0 ||
    artifact.size_in_bytes > MAX_STATE_BYTES
  ) {
    throw new Error(`restorable state artifact exceeds the ${MAX_STATE_BYTES}-byte limit`);
  }
  if (!Number.isSafeInteger(artifact.workflow_run.id) || artifact.workflow_run.id <= 0) {
    throw new Error("restorable state artifact has an invalid workflow run ID");
  }
  return {
    artifactId: artifact.id,
    runId: artifact.workflow_run.id,
    bytes: artifact.size_in_bytes,
  };
}

export function inspectTree(root, options = {}) {
  const maximumBytes = options.maximumBytes ?? MAX_STATE_BYTES;
  const maximumFiles = options.maximumFiles ?? MAX_TREE_FILES;
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`${root} must be a regular directory`);
  }
  let files = 0;
  let bytes = 0;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`state contains a symbolic link: ${file}`);
      if (stat.isDirectory()) {
        pending.push(file);
        continue;
      }
      if (!stat.isFile()) throw new Error(`state contains a non-regular file: ${file}`);
      files++;
      bytes += stat.size;
      if (files > maximumFiles) throw new Error(`state exceeds the ${maximumFiles}-file limit`);
      if (bytes > maximumBytes) throw new Error(`state exceeds the ${maximumBytes}-byte limit`);
    }
  }
  return { files, bytes };
}

function workspaceOutput(root, workspace, expectedName = "org-results") {
  const resolvedRoot = path.resolve(root);
  const resolvedWorkspace = path.resolve(workspace);
  const relation = path.relative(resolvedWorkspace, resolvedRoot);
  if (
    path.basename(resolvedRoot) !== expectedName ||
    !relation ||
    relation === ".." ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    throw new Error("state directory must be the org-results child of GITHUB_WORKSPACE");
  }
  return resolvedRoot;
}

export function prepareState(root, options = {}) {
  const fresh = options.fresh === true;
  let checkpoint = false;
  if (fs.existsSync(root)) {
    inspectTree(root);
    const checkpointFile = path.join(root, "organization-checkpoint.json");
    if (fs.existsSync(checkpointFile)) {
      regularFile(checkpointFile, "organization checkpoint", 16 * 1024 * 1024);
      checkpoint = true;
    }
    fs.rmSync(path.join(root, "organization-inventory.json"), { force: true });
  }
  if (fresh || !checkpoint) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    return { scanAction: "--overwrite", resumedState: false };
  }
  return { scanAction: "--resume", resumedState: true };
}

function removeRegularTree(root, label) {
  if (!fs.existsSync(root)) return;
  inspectTree(root);
  fs.rmSync(root, { recursive: true });
  if (fs.existsSync(root)) throw new Error(`${label} could not be reset`);
}

export function prepareWorkflowState(stateRoot, restoredRoot, options = {}) {
  removeRegularTree(stateRoot, "organization state");
  if (options.fresh === true) {
    removeRegularTree(restoredRoot, "restored organization state");
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    return { scanAction: "--overwrite", resumedState: false, baselineInput: "" };
  }
  if (!fs.existsSync(restoredRoot)) {
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    return { scanAction: "--overwrite", resumedState: false, baselineInput: "" };
  }
  inspectTree(restoredRoot);
  const checkpoint = path.join(restoredRoot, "organization-checkpoint.json");
  const inventory = path.join(restoredRoot, "organization-inventory.json");
  if (fs.existsSync(checkpoint)) {
    regularFile(checkpoint, "organization checkpoint", 16 * 1024 * 1024);
    for (const stale of [inventory, path.join(restoredRoot, "organization-delta.json")]) {
      if (!fs.existsSync(stale)) continue;
      regularFile(stale, "stale organization report", MAX_AGGREGATE_BYTES);
      fs.rmSync(stale);
    }
    fs.renameSync(restoredRoot, stateRoot);
    return { scanAction: "--resume", resumedState: true, baselineInput: "" };
  }
  regularFile(inventory, "organization inventory", MAX_AGGREGATE_BYTES);
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  return {
    scanAction: "--overwrite",
    resumedState: false,
    baselineInput: restoredRoot,
  };
}

function readAggregate(file, organization) {
  regularFile(file, "organization inventory", MAX_AGGREGATE_BYTES);
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    report?.kind !== "github-organization-inventory" ||
    report.organization?.login?.toLowerCase() !== organization.toLowerCase() ||
    !Array.isArray(report.repositories)
  ) {
    throw new Error("organization inventory has an unexpected contract or organization");
  }
  return report;
}

function readDelta(file, report, organization) {
  regularFile(file, "organization delta", MAX_DELTA_BYTES);
  const delta = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    delta?.kind !== "github-organization-inventory-delta" ||
    delta.organization?.login?.toLowerCase() !== organization.toLowerCase() ||
    !delta.summary ||
    !Array.isArray(delta.repositories) ||
    (report.scope?.fingerprint &&
      delta.current?.scopeFingerprint &&
      report.scope.fingerprint !== delta.current.scopeFingerprint)
  ) {
    throw new Error("organization delta has an unexpected contract, organization, or scope");
  }
  return delta;
}

export function validateState(root, organization) {
  const tree = inspectTree(root);
  const inventory = path.join(root, "organization-inventory.json");
  const checkpoint = path.join(root, "organization-checkpoint.json");
  const reportReady = fs.existsSync(inventory);
  const checkpointReady = fs.existsSync(checkpoint);
  if (!reportReady && !checkpointReady) {
    throw new Error("organization state contains neither an inventory nor a checkpoint");
  }
  if (reportReady) {
    const report = readAggregate(inventory, organization);
    if (report.delta?.artifact === "organization-delta.json") {
      readDelta(path.join(root, "organization-delta.json"), report, organization);
    }
  }
  if (checkpointReady) regularFile(checkpoint, "organization checkpoint", 16 * 1024 * 1024);
  return { ...tree, reportReady, checkpointReady };
}

export function validateReviewBundle(site, aggregate, progress) {
  const tree = inspectTree(site, { maximumBytes: MAX_REVIEW_BYTES });
  regularFile(path.join(site, "index.html"), "rendered organization index", 4 * 1024 * 1024);
  const aggregateStat = regularFile(aggregate, "organization inventory", MAX_AGGREGATE_BYTES);
  const progressStat = regularFile(progress, "organization progress log", MAX_PROGRESS_BYTES);
  const bytes = tree.bytes + aggregateStat.size + progressStat.size;
  const files = tree.files + 2;
  if (bytes > MAX_REVIEW_BYTES) {
    throw new Error(`review bundle exceeds the ${MAX_REVIEW_BYTES}-byte limit`);
  }
  return { bytes, files };
}

function outputs(values) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) {
    process.stdout.write(`${JSON.stringify(values, null, 2)}\n`);
    return;
  }
  for (const [name, raw] of Object.entries(values)) {
    const value = String(raw);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /[\r\n]/.test(value)) {
      throw new Error("refusing to write an unsafe GitHub Actions output");
    }
    fs.appendFileSync(file, `${name}=${value}\n`);
  }
}

async function resolveStateArtifact(environment, fetchImpl = fetch) {
  if (boolean(environment.FRESH, "fresh")) return null;
  const repository = String(environment.REPOSITORY || "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("REPOSITORY must use the owner/name form");
  }
  const currentRunId = integer(environment.RUN_ID, "run ID", 1, Number.MAX_SAFE_INTEGER);
  const repositoryId = integer(
    environment.REPOSITORY_ID,
    "repository ID",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (!environment.ACTIONS_TOKEN) throw new Error("ACTIONS_TOKEN is required");
  const [owner, name] = repository.split("/");
  const endpoint = new URL(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/artifacts`,
  );
  endpoint.searchParams.set("name", environment.STATE_ARTIFACT_NAME);
  endpoint.searchParams.set("per_page", "100");
  let response;
  try {
    response = await fetchImpl(endpoint, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${environment.ACTIONS_TOKEN}`,
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("state artifact lookup failed before a response was received");
  }
  if (!response.ok) throw new Error(`state artifact lookup returned HTTP ${response.status}`);
  const body = await response.text();
  if (body.length > 2 * 1024 * 1024) throw new Error("state artifact lookup response is too large");
  const payload = JSON.parse(body);
  return selectRestorableArtifact(payload, {
    name: environment.STATE_ARTIFACT_NAME,
    currentRunId,
    defaultBranch: environment.DEFAULT_BRANCH,
    repositoryId,
  });
}

async function main() {
  const command = process.argv[2];
  if (command === "settings") {
    const settings = parseSettings({
      organization: process.env.ORG_VALUE,
      maxRepositories: process.env.MAX_REPOSITORIES_VALUE,
      concurrency: process.env.CONCURRENCY_VALUE,
      fresh: process.env.FRESH_VALUE,
      configFile: process.env.CONFIG_FILE,
      ignoreFile: process.env.IGNORE_FILE,
    });
    outputs({
      organization: settings.organization,
      max_repositories: settings.maxRepositories,
      concurrency: settings.concurrency,
      fresh: settings.fresh,
      state_artifact_name: settings.stateArtifactName,
    });
    return;
  }
  if (command === "resolve-state") {
    const artifact = await resolveStateArtifact(process.env);
    outputs(
      artifact
        ? { found: true, artifact_id: artifact.artifactId, run_id: artifact.runId }
        : { found: false },
    );
    return;
  }
  if (command === "prepare-state") {
    const root = workspaceOutput(process.env.STATE_DIR, process.env.GITHUB_WORKSPACE);
    const restored = workspaceOutput(
      process.env.RESTORED_DIR,
      process.env.GITHUB_WORKSPACE,
      "previous-results",
    );
    const result = prepareWorkflowState(root, restored, {
      fresh: boolean(process.env.FRESH, "fresh"),
    });
    outputs({
      scan_action: result.scanAction,
      resumed_state: result.resumedState,
      baseline_input: result.baselineInput,
    });
    return;
  }
  if (command === "validate-state") {
    const root = workspaceOutput(process.env.STATE_DIR, process.env.GITHUB_WORKSPACE);
    const result = validateState(root, process.env.ORGANIZATION);
    outputs({
      state_ready: true,
      report_ready: result.reportReady,
      checkpoint_ready: result.checkpointReady,
      state_files: result.files,
      state_bytes: result.bytes,
    });
    return;
  }
  if (command === "validate-review") {
    const result = validateReviewBundle(
      process.env.SITE_DIR,
      process.env.AGGREGATE_FILE,
      process.env.PROGRESS_FILE,
    );
    outputs({ review_ready: true, review_files: result.files, review_bytes: result.bytes });
    return;
  }
  throw new Error(
    "usage: organization-ci.mjs <settings|resolve-state|prepare-state|validate-state|validate-review>",
  );
}

const invokedUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedUrl === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`Express Recon organization CI failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
