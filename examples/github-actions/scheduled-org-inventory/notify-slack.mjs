import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const MAX_REPOSITORIES = 20;
const MAX_BLOCK_TEXT = 2_800;
const SLACK_HOSTS = new Set(["hooks.slack.com", "hooks.slack-gov.com"]);

function clean(value, maximum = 500) {
  const withoutControls = [...String(value ?? "")]
    .map((character) => {
      const code = character.codePointAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("");
  const normalized = withoutControls.replace(/\s+/g, " ").trim();
  return normalized.length > maximum ? `${normalized.slice(0, maximum - 1)}…` : normalized;
}

function escapeMrkdwn(value) {
  return clean(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function integer(value, label) {
  if (!/^[1-9][0-9]*$/.test(String(value ?? ""))) throw new Error(`${label} must be positive`);
  return String(value);
}

function validateContext(input) {
  const repository = clean(input.repository, 200);
  const organization = clean(input.organization, 100);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("REPOSITORY must use the owner/name form");
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(organization)) {
    throw new Error("ORGANIZATION must be a GitHub organization login");
  }
  const runId = integer(input.runId, "RUN_ID");
  const scanExitCode = /^[012]$/.test(String(input.scanExitCode ?? ""))
    ? String(input.scanExitCode)
    : "1";
  const jobResult = ["success", "failure", "cancelled"].includes(input.jobResult)
    ? input.jobResult
    : "failure";
  return {
    repository,
    organization,
    runId,
    scanExitCode,
    jobResult,
    notifySuccess: input.notifySuccess === true || input.notifySuccess === "true",
    notifyChanges: input.notifyChanges !== false && input.notifyChanges !== "false",
  };
}

function count(summary, name) {
  const value = summary?.[name];
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function problemRepositories(report) {
  if (!report) return [];
  const problems = report.repositories
    .filter(
      (entry) =>
        ["failed", "inconclusive", "skipped-limit"].includes(entry?.status) ||
        entry?.coverageComplete === false ||
        entry?.routeGraphComplete === false,
    )
    .map((entry) => ({
      name: clean(entry.repository?.fullName || entry.repository?.name || "unknown", 200),
      status: clean(entry.status || "incomplete", 40),
    }));
  const known = new Set(problems.map((entry) => entry.name.toLowerCase()));
  const comparisonFailures = Array.isArray(report.delta?.coverage?.incompleteRepositories)
    ? report.delta.coverage.incompleteRepositories
    : [];
  for (const value of comparisonFailures) {
    const name = clean(value, 200);
    if (!name || known.has(name.toLowerCase())) continue;
    known.add(name.toLowerCase());
    problems.push({ name, status: "comparison-incomplete" });
  }
  return problems.sort((left, right) => left.name.localeCompare(right.name));
}

function changedRepositories(report) {
  const repositories = Array.isArray(report?.delta?.repositories) ? report.delta.repositories : [];
  return repositories
    .map((entry) => {
      const before = entry?.before?.status || "not present";
      const after = entry?.after?.status || "not present";
      const routes = entry?.routeChanges || {};
      return {
        name: clean(entry?.repository?.fullName || entry?.repository?.name || "unknown", 200),
        change: clean(entry?.change || "changed", 40),
        status: clean(`${before} → ${after}`, 100),
        addedRoutes: count(routes, "addedRoutes"),
        removedRoutes: count(routes, "removedRoutes"),
        authRegressions: count(routes, "authRegressions"),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function sectionChunks(lines) {
  const chunks = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= MAX_BLOCK_TEXT) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    current = line.slice(0, MAX_BLOCK_TEXT);
  }
  if (current) chunks.push(current);
  return chunks;
}

export function buildOrganizationNotification(report, rawContext) {
  const context = validateContext(rawContext);
  if (report !== null) {
    if (
      !report ||
      report.kind !== "github-organization-inventory" ||
      report.organization?.login?.toLowerCase() !== context.organization.toLowerCase() ||
      !Array.isArray(report.repositories)
    ) {
      throw new Error("organization report has an unexpected contract");
    }
  }
  const comparisonIncomplete = report?.delta ? report.delta.coverage?.complete !== true : false;
  const incomplete = report?.coverage?.complete !== true || comparisonIncomplete;
  const failedJob = context.jobResult !== "success" || context.scanExitCode !== "0";
  const deltaSummary = report?.delta?.summary || {};
  const hasChanges = count(deltaSummary, "repositoriesChanged") > 0;
  const shouldNotify =
    failedJob || incomplete || (context.notifyChanges && hasChanges) || context.notifySuccess;
  if (!shouldNotify) return { payload: null, problems: 0, shown: 0, changes: 0, changesShown: 0 };

  const problems = problemRepositories(report);
  const selected = problems.slice(0, MAX_REPOSITORIES);
  const changes = changedRepositories(report);
  const selectedChanges = changes.slice(0, MAX_REPOSITORIES);
  const summary = report?.summary || {};
  const supported = Object.hasOwn(summary, "supportedRepositories")
    ? count(summary, "supportedRepositories")
    : count(summary, "expressRepositories");
  const state = failedJob || incomplete ? "needs attention" : hasChanges ? "changed" : "complete";
  const runUrl = `https://github.com/${context.repository}/actions/runs/${context.runId}`;
  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Express Recon: ${context.organization} ${state}`,
        emoji: false,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Discovered:* ${count(summary, "repositoriesDiscovered")} · *Scanned:* ${count(summary, "repositoriesScanned")} · *Supported:* ${supported}\n*Express:* ${count(summary, "expressRepositories")} · *Fastify:* ${count(summary, "fastifyRepositories")} · *NestJS:* ${count(summary, "nestjsRepositories")} · *Routes:* ${count(summary, "routes")}\n*Failed:* ${count(summary, "failedRepositories")} · *Inconclusive:* ${count(summary, "inconclusiveRepositories")} · <${runUrl}|workflow run>`,
      },
    },
  ];
  if (selected.length) {
    blocks.push({ type: "divider" });
    blocks.push(
      ...sectionChunks(
        selected.map(
          (entry) => `• ${escapeMrkdwn(entry.name)} · \`${escapeMrkdwn(entry.status)}\``,
        ),
      ).map((text) => ({ type: "section", text: { type: "mrkdwn", text } })),
    );
  }
  if (hasChanges) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Inventory changes:* ${count(deltaSummary, "repositoriesChanged")} repositories · *Added:* ${count(deltaSummary, "repositoriesAdded")} · *Removed:* ${count(deltaSummary, "repositoriesRemoved")} · *New paths:* ${count(deltaSummary, "addedRoutes")} · *Removed paths:* ${count(deltaSummary, "removedRoutes")} · *Auth regressions:* ${count(deltaSummary, "authRegressions")}`,
      },
    });
    blocks.push(
      ...sectionChunks(
        selectedChanges.map(
          (entry) =>
            `• ${escapeMrkdwn(entry.name)} · \`${escapeMrkdwn(entry.change)}\` · ${escapeMrkdwn(entry.status)} · +${entry.addedRoutes}/-${entry.removedRoutes}${entry.authRegressions ? ` · ${entry.authRegressions} auth regression(s)` : ""}`,
        ),
      ).map((text) => ({ type: "section", text: { type: "mrkdwn", text } })),
    );
  }
  blocks.push({
    type: "context",
    elements: [
      {
        type: "plain_text",
        text: !report
          ? "The scan failed before a validated aggregate report was available; inspect the workflow log."
          : problems.length > selected.length || changes.length > selectedChanges.length
            ? `Showing bounded repository lists (${selected.length} of ${problems.length} incomplete; ${selectedChanges.length} of ${changes.length} changed). Download the report artifact for complete evidence.`
            : "Download the report artifact for the offline HTML inventory and complete evidence.",
        emoji: false,
      },
    ],
  });
  return {
    problems: problems.length,
    shown: selected.length,
    changes: changes.length,
    changesShown: selectedChanges.length,
    payload: {
      text: `Express Recon organization scan for ${context.organization} ${state}.`,
      blocks,
    },
  };
}

export function validateSlackWebhookUrl(value) {
  if (!value) throw new Error("SLACK_WEBHOOK_URL is not configured");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("SLACK_WEBHOOK_URL is not a valid URL");
  }
  if (
    parsed.protocol !== "https:" ||
    !SLACK_HOSTS.has(parsed.hostname) ||
    !parsed.pathname.startsWith("/services/") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("SLACK_WEBHOOK_URL must be an HTTPS Slack incoming-webhook URL");
  }
  return parsed.href;
}

function readReport(file, ready) {
  if (!ready) return null;
  if (!file) throw new Error("report path is required when REPORT_READY is true");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("report path must be a regular file");
  if (stat.size <= 0 || stat.size > MAX_REPORT_BYTES) {
    throw new Error(`report must be between 1 and ${MAX_REPORT_BYTES} bytes`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function postToSlack(webhook, payload) {
  let response;
  try {
    response = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Slack webhook request failed before a response was received");
  }
  if (!response.ok) {
    const body = clean((await response.text()).slice(0, 200), 200);
    throw new Error(`Slack webhook returned HTTP ${response.status}${body ? `: ${body}` : ""}`);
  }
}

async function main() {
  const ready = process.env.REPORT_READY === "true";
  const report = readReport(process.argv[2], ready);
  const notification = buildOrganizationNotification(report, {
    repository: process.env.REPOSITORY,
    organization: process.env.ORGANIZATION,
    runId: process.env.RUN_ID,
    scanExitCode: process.env.SCAN_EXIT_CODE,
    jobResult: process.env.SCAN_JOB_RESULT,
    notifySuccess: process.env.NOTIFY_SUCCESS,
    notifyChanges: process.env.NOTIFY_CHANGES,
  });
  if (!notification.payload) {
    process.stdout.write(
      "Express Recon organization scan is complete; Slack notification skipped.\n",
    );
    return;
  }
  if (process.env.EXPRESS_RECON_SLACK_DRY_RUN === "1") {
    process.stdout.write(`${JSON.stringify(notification.payload, null, 2)}\n`);
    return;
  }
  const webhook = validateSlackWebhookUrl(process.env.SLACK_WEBHOOK_URL);
  await postToSlack(webhook, notification.payload);
  process.stdout.write(
    `Sent organization scan status to Slack (${notification.shown} of ${notification.problems} problem and ${notification.changesShown} of ${notification.changes} changed repositories listed).\n`,
  );
}

const invokedUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedUrl === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `Express Recon organization Slack notification failed: ${clean(error.message, 300)}\n`,
    );
    process.exitCode = 1;
  });
}
