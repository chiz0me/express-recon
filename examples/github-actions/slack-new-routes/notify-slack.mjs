import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_REPORT_BYTES = 20 * 1024 * 1024;
const MAX_ROUTES = 20;
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

export function escapeMrkdwn(value) {
  return clean(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function inlineCode(value, maximum = 260) {
  const text = clean(value, maximum).replaceAll("`", "'");
  return `\`${escapeMrkdwn(text)}\``;
}

function validateContext(input) {
  const repository = clean(input.repository, 200);
  const prNumber = clean(input.prNumber, 20);
  const headSha = clean(input.headSha, 64).toLowerCase();
  const runId = clean(input.runId, 30);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("REPOSITORY must use the owner/name form");
  }
  if (!/^[1-9][0-9]*$/.test(prNumber)) throw new Error("PR_NUMBER must be a positive integer");
  if (!/^[a-f0-9]{7,64}$/.test(headSha)) throw new Error("HEAD_SHA must be a Git commit SHA");
  if (!/^[1-9][0-9]*$/.test(runId)) throw new Error("RUN_ID must be a positive integer");
  return { repository, prNumber, headSha, runId };
}

function safeSource(source) {
  if (
    !source ||
    typeof source.file !== "string" ||
    source.file.includes("\0") ||
    source.file.includes("\r") ||
    source.file.includes("\n")
  ) {
    return null;
  }
  const slashPath = source.file.replaceAll("\\", "/");
  const normalized = path.posix.normalize(slashPath);
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    return null;
  }
  const line = Number.isSafeInteger(source.line) && source.line > 0 ? source.line : null;
  return { file: normalized, line };
}

function sourceLink(source, context) {
  const safe = safeSource(source);
  if (!safe) return null;
  const encoded = safe.file.split("/").map(encodeURIComponent).join("/");
  const line = safe.line ? `#L${safe.line}` : "";
  const label = escapeMrkdwn(`${safe.file}${safe.line ? `:${safe.line}` : ""}`).replaceAll(
    "|",
    "¦",
  );
  return `<https://github.com/${context.repository}/blob/${context.headSha}/${encoded}${line}|${label}>`;
}

function routeLine(route, context) {
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    return "• *UNKNOWN* `(malformed route entry)`";
  }
  const method = /^[A-Z]+$/.test(route.method) ? route.method.slice(0, 16) : "UNKNOWN";
  const routePath = inlineCode(route.path || "(unknown path)");
  const auth = route.authStatus ? ` · auth: ${inlineCode(route.authStatus, 40)}` : "";
  const location = sourceLink(route.source, context);
  return `• *${method}* ${routePath}${auth}${location ? ` · ${location}` : ""}`;
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

export function buildSlackNotification(report, rawContext) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("report must be a JSON object");
  }
  if (!report.delta || !Array.isArray(report.delta.addedRoutes)) {
    throw new Error("report.delta.addedRoutes is missing; run express-recon with --baseline");
  }
  const context = validateContext(rawContext);
  const total = report.delta.addedRoutes.length;
  if (total === 0) return { total, shown: 0, payload: null };

  const selected = report.delta.addedRoutes.slice(0, MAX_ROUTES);
  const repositoryUrl = `https://github.com/${context.repository}`;
  const pullRequestUrl = `${repositoryUrl}/pull/${context.prNumber}`;
  const workflowUrl = `${repositoryUrl}/actions/runs/${context.runId}`;
  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Express Recon: ${total} new route${total === 1 ? "" : "s"}`,
        emoji: false,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Repository:* <${repositoryUrl}|${escapeMrkdwn(context.repository)}>\n*Pull request:* <${pullRequestUrl}|#${context.prNumber}> · <${workflowUrl}|audit run>`,
      },
    },
    { type: "divider" },
    ...sectionChunks(selected.map((route) => routeLine(route, context))).map((text) => ({
      type: "section",
      text: { type: "mrkdwn", text },
    })),
    {
      type: "context",
      elements: [
        {
          type: "plain_text",
          text:
            total > selected.length
              ? `Showing ${selected.length} of ${total}. Download the audit artifact for the complete result.`
              : "Download the audit artifact for the complete machine-readable result.",
          emoji: false,
        },
      ],
    },
  ];
  return {
    total,
    shown: selected.length,
    payload: {
      text: `Express Recon found ${total} new route${total === 1 ? "" : "s"} in ${context.repository} PR #${context.prNumber}.`,
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

function readReport(file) {
  if (!file) throw new Error("usage: notify-slack.mjs <routes.json>");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("report path must be a regular file");
  if (stat.size <= 0 || stat.size > MAX_REPORT_BYTES) {
    throw new Error(`report must be between 1 byte and ${MAX_REPORT_BYTES} bytes`);
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
  const report = readReport(process.argv[2]);
  const notification = buildSlackNotification(report, {
    repository: process.env.REPOSITORY,
    prNumber: process.env.PR_NUMBER,
    headSha: process.env.HEAD_SHA,
    runId: process.env.RUN_ID,
  });
  if (!notification.payload) {
    process.stdout.write("Express Recon found no added routes; Slack notification skipped.\n");
    return;
  }
  if (process.env.EXPRESS_RECON_SLACK_DRY_RUN === "1") {
    process.stdout.write(`${JSON.stringify(notification.payload, null, 2)}\n`);
    return;
  }
  const webhook = validateSlackWebhookUrl(process.env.SLACK_WEBHOOK_URL);
  await postToSlack(webhook, notification.payload);
  process.stdout.write(
    `Sent ${notification.shown} of ${notification.total} added routes to Slack.\n`,
  );
}

const invokedUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedUrl === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`Express Recon Slack notification failed: ${clean(error.message, 300)}\n`);
    process.exitCode = 1;
  });
}
