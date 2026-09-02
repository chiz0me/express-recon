"use strict";

const crypto = require("node:crypto");
const net = require("node:net");

const DEFAULT_NOTIFICATION_EVENTS = [
  "express_recon.routes.added",
  "express_recon.auth.regressed",
  "express_recon.scan.incomplete",
];
const NOTIFICATION_EVENT_TYPES = new Set([
  "express_recon.routes.added",
  "express_recon.routes.removed",
  "express_recon.auth.regressed",
  "express_recon.scan.incomplete",
]);
const EVENT_NAMES = new Map([
  ["routes.added", "express_recon.routes.added"],
  ["routes.removed", "express_recon.routes.removed"],
  ["auth.regressed", "express_recon.auth.regressed"],
  ["scan.incomplete", "express_recon.scan.incomplete"],
]);
for (const name of NOTIFICATION_EVENT_TYPES) EVENT_NAMES.set(name, name);

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clean(value, maximum = 500) {
  const text = [...String(value ?? "")]
    .map((character) => {
      const code = character.codePointAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return selected;
}

function safeSource(source) {
  const candidate = object(source);
  if (typeof candidate.file !== "string") return null;
  const normalized = candidate.file.replaceAll("\\", "/").split("/");
  if (
    normalized.some((part) => !part || part === "." || part === "..") ||
    candidate.file.includes("\0") ||
    candidate.file.includes("\r") ||
    candidate.file.includes("\n") ||
    candidate.file.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(candidate.file)
  ) {
    return null;
  }
  const file = clean(normalized.join("/"), 1_000);
  const line = Number.isSafeInteger(candidate.line) && candidate.line > 0 ? candidate.line : null;
  return { file, ...(line ? { line } : {}) };
}

function routeItem(route, includeSource, repository) {
  const item = object(route);
  const method = clean(item.method, 40);
  const routePath = clean(item.path, 2_000);
  if (!method || !routePath) throw new Error("notification route entries require method and path");
  const result = {
    ...(repository ? { repository: clean(repository, 200) } : {}),
    ...(item.applicationId ? { applicationId: clean(item.applicationId, 500) } : {}),
    method,
    path: routePath,
    ...(item.authStatus ? { authStatus: clean(item.authStatus, 40) } : {}),
    ...(item.from ? { from: clean(item.from, 40) } : {}),
    ...(item.to ? { to: clean(item.to, 40) } : {}),
  };
  const source = includeSource ? safeSource(item.source) : null;
  if (source) result.source = source;
  return result;
}

function normalizeEventNames(events) {
  const values = events === undefined ? DEFAULT_NOTIFICATION_EVENTS : events;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("notification events must be a non-empty array");
  }
  const normalized = values.map((value) => EVENT_NAMES.get(String(value).trim()));
  const invalid = normalized.findIndex((value) => !value);
  if (invalid >= 0) {
    throw new Error(
      `unknown notification event ${JSON.stringify(String(values[invalid]))}; use routes.added, routes.removed, auth.regressed, or scan.incomplete`,
    );
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("notification events must not contain duplicates");
  }
  return normalized;
}

function notificationContext(value) {
  const input = object(value);
  const context = {};
  for (const [name, maximum] of [
    ["repository", 200],
    ["revision", 128],
    ["ref", 500],
    ["runId", 100],
    ["pullRequest", 40],
  ]) {
    const selected = clean(input[name], maximum);
    if (selected) context[name] = selected;
  }
  if (input.runUrl) {
    let parsed;
    try {
      parsed = new URL(String(input.runUrl));
    } catch {
      throw new Error("notification context runUrl must be a valid URL");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error("notification context runUrl must use HTTPS without credentials");
    }
    context.runUrl = parsed.href;
  }
  return context;
}

function eventIdentity(type, subject, context, evidence) {
  const digest = crypto
    .createHash("sha256")
    .update(type)
    .update("\0")
    .update(subject)
    .update("\0")
    .update(context.revision || "")
    .update("\0")
    .update(JSON.stringify(evidence))
    .digest("base64url");
  return `evt_${digest.slice(0, 36)}`;
}

function makeEvent(type, report, context, data, evidence, now) {
  const subject = clean(
    context.repository || report.organization?.login || report.target?.name || "route-inventory",
    200,
  );
  const created = now === undefined ? new Date() : new Date(now);
  if (Number.isNaN(created.getTime())) throw new Error("notification time is invalid");
  return {
    schemaVersion: "1.0",
    id: eventIdentity(type, subject, context, evidence),
    type,
    source: "express-recon",
    subject,
    createdAt: created.toISOString(),
    ...(Object.keys(context).length ? { context } : {}),
    data,
  };
}

function organizationDetailType(items) {
  if (items.length === 0) return "repository-summary";
  const summaries = items.some((item) => item.count !== undefined);
  const routes = items.some((item) => item.method !== undefined);
  if (summaries && routes) return "mixed";
  return summaries ? "repository-summary" : "route";
}

function routeReportChanges(report, eventName) {
  const delta = object(report.delta);
  const field = {
    "express_recon.routes.added": "addedRoutes",
    "express_recon.routes.removed": "removedRoutes",
    "express_recon.auth.regressed": "authRegressions",
  }[eventName];
  if (!field) return null;
  if (!report.delta || !Array.isArray(delta[field])) {
    throw new Error(
      `report.delta.${field} is missing; create the report with --baseline before notifying`,
    );
  }
  return { total: delta[field].length, entries: delta[field], field };
}

function organizationChanges(report, eventName) {
  const delta =
    report.kind === "github-organization-inventory-delta" ? report : object(report.delta);
  const field = {
    "express_recon.routes.added": "addedRoutes",
    "express_recon.routes.removed": "removedRoutes",
    "express_recon.auth.regressed": "authRegressions",
  }[eventName];
  if (!field) return null;
  if (!delta.summary || !Number.isSafeInteger(delta.summary[field])) {
    throw new Error(
      `organization delta summary.${field} is missing; run scan-org with --baseline before notifying`,
    );
  }
  const entries = [];
  for (const repository of Array.isArray(delta.repositories) ? delta.repositories : []) {
    const fullName = repository.repository?.fullName || repository.repository?.name;
    const routes = repository.changes?.routes || {};
    const details = routes.details?.[field];
    if (Array.isArray(details)) {
      for (const route of details) entries.push({ repository: fullName, route });
      continue;
    }
    const summary = repository.routeChanges || routes.summary;
    const repositoryCount = count(summary?.[field]);
    if (repositoryCount) entries.push({ repository: fullName, count: repositoryCount });
  }
  return { total: count(delta.summary[field]), entries, field, delta };
}

function incompleteEvidence(report) {
  const components = [];
  if (report.kind === "github-organization-inventory-delta") {
    if (report.coverage?.complete === false) {
      components.push({ component: "comparison", complete: false });
    }
    return components;
  }
  if (report.kind === "github-organization-inventory") {
    if (report.coverage?.complete === false) {
      components.push({ component: "organization-scan", complete: false });
    }
    if (report.delta?.coverage?.complete === false) {
      components.push({ component: "comparison", complete: false });
    }
    return components;
  }
  if (report.scanCoverage?.complete === false) {
    components.push({ component: "source-scan", complete: false });
  }
  if (report.routeGraph?.complete === false) {
    components.push({ component: "route-graph", complete: false });
  }
  return components;
}

function isOrganizationReport(report) {
  return (
    report.kind === "github-organization-inventory" ||
    report.kind === "github-organization-inventory-delta"
  );
}

function exactKeys(value, allowed, label) {
  const unexpected = Object.keys(value).find((name) => !allowed.has(name));
  if (unexpected)
    throw new Error(`${label} contains unsupported field ${JSON.stringify(unexpected)}`);
}

function eventText(value, maximum, label) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maximum ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new Error(`${label} must be non-empty bounded text without control characters`);
  }
}

function validateSource(source) {
  exactKeys(source, new Set(["file", "line"]), "notification source");
  const safe = safeSource(source);
  if (!safe || safe.file !== source.file || safe.line !== source.line) {
    throw new Error("notification source must be a normalized repository-relative location");
  }
}

function validateRouteItem(item) {
  exactKeys(
    item,
    new Set([
      "repository",
      "applicationId",
      "method",
      "path",
      "authStatus",
      "from",
      "to",
      "source",
    ]),
    "notification route item",
  );
  eventText(item.method, 40, "notification route method");
  eventText(item.path, 2_000, "notification route path");
  for (const [name, maximum] of [
    ["repository", 200],
    ["applicationId", 500],
    ["authStatus", 40],
    ["from", 40],
    ["to", 40],
  ]) {
    if (item[name] !== undefined) eventText(item[name], maximum, `notification route ${name}`);
  }
  if (item.source !== undefined) {
    if (!item.source || typeof item.source !== "object" || Array.isArray(item.source)) {
      throw new Error("notification route source must be an object");
    }
    validateSource(item.source);
  }
}

function validateSummaryItem(item) {
  exactKeys(item, new Set(["repository", "count"]), "notification repository summary");
  eventText(item.repository, 200, "notification repository name");
  if (!Number.isSafeInteger(item.count) || item.count < 1) {
    throw new Error("notification repository count must be a positive integer");
  }
}

function validateIncompleteItem(item) {
  exactKeys(item, new Set(["component", "complete"]), "notification coverage item");
  if (
    !["source-scan", "route-graph", "organization-scan", "comparison"].includes(item.component) ||
    item.complete !== false
  ) {
    throw new Error("notification coverage item must identify an incomplete component");
  }
}

/**
 * Validate the strict version 1 notification envelope and return it unchanged.
 * This validates shape and bounds; receivers must still treat values as data.
 */
function validateNotificationEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("notification event must be an object");
  }
  exactKeys(
    event,
    new Set(["schemaVersion", "id", "type", "source", "subject", "createdAt", "context", "data"]),
    "notification event",
  );
  if (event.schemaVersion !== "1.0" || event.source !== "express-recon") {
    throw new Error("notification event has an unsupported schema or source");
  }
  if (!/^evt_[A-Za-z0-9_-]{36}$/.test(event.id))
    throw new Error("notification event id is invalid");
  if (!NOTIFICATION_EVENT_TYPES.has(event.type))
    throw new Error("notification event type is invalid");
  eventText(event.subject, 200, "notification event subject");
  if (
    typeof event.createdAt !== "string" ||
    Number.isNaN(Date.parse(event.createdAt)) ||
    new Date(event.createdAt).toISOString() !== event.createdAt
  ) {
    throw new Error("notification event createdAt must be an ISO timestamp");
  }
  if (event.context !== undefined) {
    if (!event.context || typeof event.context !== "object" || Array.isArray(event.context)) {
      throw new Error("notification event context must be an object");
    }
    exactKeys(
      event.context,
      new Set(["repository", "revision", "ref", "runId", "pullRequest", "runUrl"]),
      "notification event context",
    );
    for (const [name, maximum] of [
      ["repository", 200],
      ["revision", 128],
      ["ref", 500],
      ["runId", 100],
      ["pullRequest", 40],
      ["runUrl", 2_000],
    ]) {
      if (event.context[name] !== undefined) {
        eventText(event.context[name], maximum, `notification context ${name}`);
      }
    }
    if (event.context.runUrl !== undefined) {
      let runUrl;
      try {
        runUrl = new URL(event.context.runUrl);
      } catch {
        throw new Error("notification context runUrl must be a valid HTTPS URL");
      }
      if (runUrl.protocol !== "https:" || runUrl.username || runUrl.password) {
        throw new Error("notification context runUrl must be a valid HTTPS URL");
      }
    }
  }
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
    throw new Error("notification event data must be an object");
  }
  exactKeys(
    event.data,
    new Set(["total", "shown", "truncated", "detail", "items"]),
    "notification event data",
  );
  if (
    !Number.isSafeInteger(event.data.total) ||
    event.data.total < 1 ||
    !Number.isSafeInteger(event.data.shown) ||
    event.data.shown < 0 ||
    event.data.shown > event.data.total ||
    !Array.isArray(event.data.items) ||
    event.data.items.length !== event.data.shown ||
    event.data.truncated !== event.data.total > event.data.shown
  ) {
    throw new Error("notification event counts, items, and truncation flag are inconsistent");
  }
  if (event.type === "express_recon.scan.incomplete") {
    if (event.data.detail !== undefined) {
      throw new Error("incomplete notification events must not declare route detail");
    }
    event.data.items.forEach(validateIncompleteItem);
  } else {
    if (!new Set(["route", "repository-summary", "mixed"]).has(event.data.detail)) {
      throw new Error("route-change notification detail type is invalid");
    }
    if (event.data.detail === "mixed") {
      event.data.items.forEach((item) =>
        item.count === undefined ? validateRouteItem(item) : validateSummaryItem(item),
      );
    } else {
      event.data.items.forEach(
        event.data.detail === "route" ? validateRouteItem : validateSummaryItem,
      );
    }
    if (
      event.type === "express_recon.auth.regressed" &&
      event.data.detail !== "repository-summary" &&
      event.data.items.some((item) => item.count === undefined && (!item.from || !item.to))
    ) {
      throw new Error("authentication regression items require from and to states");
    }
  }
  return event;
}

/**
 * Build bounded, provider-neutral webhook events from a baseline-aware route or
 * organization report. Empty selected deltas produce no events.
 */
function buildNotificationEvents(report, options = {}) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("notification input must be an express-recon JSON object");
  }
  const eventNames = normalizeEventNames(options.events);
  const maxItems = boundedInteger(options.maxItems, 20, 1, 100, "maxItems");
  const context = notificationContext(options.context);
  const includeSource = options.includeSource === true;
  const organization = isOrganizationReport(report);
  if (
    organization &&
    (typeof report.organization?.login !== "string" ||
      !report.organization.login ||
      !Array.isArray(report.repositories))
  ) {
    throw new Error("notification organization input has an unexpected contract");
  }
  if (!organization && !Array.isArray(report.routes)) {
    throw new Error("notification input must be a routes report or organization inventory/delta");
  }
  const events = [];
  for (const eventName of eventNames) {
    if (eventName === "express_recon.scan.incomplete") {
      const items = incompleteEvidence(report);
      if (items.length) {
        events.push(
          makeEvent(
            eventName,
            report,
            context,
            { total: items.length, shown: items.length, truncated: false, items },
            items,
            options.now,
          ),
        );
      }
      continue;
    }
    const changes = organization
      ? organizationChanges(report, eventName)
      : routeReportChanges(report, eventName);
    if (!changes.total) continue;
    const selected = changes.entries.slice(0, maxItems).map((entry) => {
      if (!organization) return routeItem(entry, includeSource);
      if (entry.route) return routeItem(entry.route, includeSource, entry.repository);
      return {
        repository: clean(entry.repository || "unknown", 200),
        count: entry.count,
      };
    });
    events.push(
      makeEvent(
        eventName,
        report,
        context,
        {
          total: changes.total,
          shown: selected.length,
          truncated: changes.total > selected.length,
          detail: organization ? organizationDetailType(selected) : "route",
          items: selected,
        },
        organization ? changes.delta : changes.entries,
        options.now,
      ),
    );
  }
  for (const event of events) {
    validateNotificationEvent(event);
    if (Buffer.byteLength(JSON.stringify(event)) > MAX_WEBHOOK_BODY_BYTES) {
      throw new Error(
        `notification event ${event.type} exceeds the ${MAX_WEBHOOK_BODY_BYTES}-byte limit`,
      );
    }
  }
  return events;
}

function rawBody(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value);
  throw new Error("webhook body must be a string or Buffer");
}

function decodeSecret(value) {
  if (typeof value !== "string" || value.length > 4_096) {
    throw new Error("webhook secrets must be strings no longer than 4096 characters");
  }
  let secret;
  if (value.startsWith("whsec_")) {
    const encoded = value.slice("whsec_".length);
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
      throw new Error("whsec_ webhook secrets must contain valid base64");
    }
    secret = Buffer.from(encoded, "base64");
  } else {
    secret = Buffer.from(value);
  }
  if (secret.length < 32) throw new Error("webhook secrets must contain at least 32 bytes");
  return secret;
}

function normalizeSecrets(value) {
  const values = Array.isArray(value) ? value : [value];
  if (values.length < 1 || values.length > 2) {
    throw new Error("provide one current webhook secret and at most one previous secret");
  }
  return values.map(decodeSecret);
}

function signatureInput(id, timestamp, body) {
  if (typeof id !== "string" || !id || id.length > 256 || /[\r\n]/.test(id)) {
    throw new Error("webhook id must be a non-empty single-line string of at most 256 characters");
  }
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error("webhook timestamp must be a non-negative integer");
  }
  return Buffer.concat([Buffer.from(`${id}.${timestamp}.`), rawBody(body)]);
}

/**
 * Sign an exact JSON body with Standard Webhooks HMAC-SHA256 headers. A second
 * secret emits a second v1 signature for rotation.
 */
function signWebhook(body, options) {
  const input = object(options);
  const message = signatureInput(input.id, input.timestamp, body);
  const signatures = normalizeSecrets(input.secrets).map(
    (secret) => `v1,${crypto.createHmac("sha256", secret).update(message).digest("base64")}`,
  );
  return {
    "webhook-id": input.id,
    "webhook-timestamp": String(input.timestamp),
    "webhook-signature": signatures.join(" "),
  };
}

function header(headers, name) {
  if (headers && typeof headers.get === "function") return headers.get(name);
  for (const [key, value] of Object.entries(object(headers))) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? value.join(" ") : String(value);
  }
  return null;
}

function signatureBuffer(value) {
  const match = /^v1,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return null;
  const decoded = Buffer.from(match[1], "base64");
  return decoded.length === 32 ? decoded : null;
}

/**
 * Verify Standard Webhooks headers against the exact raw request body, enforce
 * a timestamp tolerance, and return the event ID for receiver-side deduping.
 */
function verifyWebhookSignature(body, headers, secrets, options = {}) {
  const id = header(headers, "webhook-id");
  const timestampText = header(headers, "webhook-timestamp");
  const signatureText = header(headers, "webhook-signature");
  if (!id || !timestampText || !signatureText)
    throw new Error("required webhook headers are missing");
  if (timestampText.length > 20 || signatureText.length > 8_192) {
    throw new Error("webhook signature headers exceed their size limit");
  }
  if (!/^\d+$/.test(timestampText)) throw new Error("webhook timestamp is invalid");
  const timestamp = Number(timestampText);
  const tolerance = boundedInteger(options.toleranceSeconds, 300, 1, 3_600, "toleranceSeconds");
  const now = options.now === undefined ? Math.floor(Date.now() / 1_000) : options.now;
  if (!Number.isSafeInteger(now) || Math.abs(now - timestamp) > tolerance) {
    throw new Error("webhook timestamp is outside the allowed tolerance");
  }
  const message = signatureInput(id, timestamp, body);
  const candidates = signatureText.split(/\s+/).filter(Boolean).slice(0, 20).map(signatureBuffer);
  const expected = normalizeSecrets(secrets).map((secret) =>
    crypto.createHmac("sha256", secret).update(message).digest(),
  );
  let valid = false;
  for (const candidate of candidates) {
    for (const digest of expected) {
      valid = Boolean(candidate && crypto.timingSafeEqual(candidate, digest)) || valid;
    }
  }
  if (!valid) throw new Error("webhook signature is invalid");
  return { id, timestamp };
}

function webhookUrl(value, allowHosts) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("webhook URL environment variable is not a valid URL");
  }
  const allowed = Array.isArray(allowHosts) ? allowHosts : [];
  const hosts = new Set(
    allowed.map((host) => {
      const normalized = String(host).trim().toLowerCase();
      if (
        !normalized ||
        normalized.length > 253 ||
        normalized.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      ) {
        throw new Error("allowed webhook hosts must be exact DNS hostnames");
      }
      return normalized;
    }),
  );
  if (hosts.size === 0) throw new Error("webhook delivery requires at least one --allow-host");
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.port && parsed.port !== "443") ||
    net.isIP(parsed.hostname) ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "local" ||
    parsed.hostname.endsWith(".localhost") ||
    parsed.hostname.endsWith(".local") ||
    !hosts.has(parsed.hostname.toLowerCase())
  ) {
    throw new Error(
      "webhook URL must use HTTPS on an explicitly allowed non-local hostname, without credentials, query, or fragment",
    );
  }
  return parsed.href;
}

function retryDelay(response, attempt, random) {
  const retryAfter = response?.headers?.get?.("retry-after");
  if (retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)) {
    return Math.min(5_000, Math.ceil(Number(retryAfter) * 1_000));
  }
  return Math.min(5_000, 250 * 2 ** (attempt - 1)) + Math.floor(random() * 100);
}

/**
 * Deliver one event to an exact allowlisted HTTPS destination with signed
 * headers, redirects disabled, bounded retries, and no secret-bearing logs.
 */
async function deliverWebhook(event, options = {}) {
  validateNotificationEvent(event);
  const destination = webhookUrl(options.url, options.allowHosts);
  const body = JSON.stringify(event);
  if (Buffer.byteLength(body) > MAX_WEBHOOK_BODY_BYTES) {
    throw new Error(`webhook body exceeds the ${MAX_WEBHOOK_BODY_BYTES}-byte limit`);
  }
  const attempts = boundedInteger(options.attempts, 3, 1, 3, "attempts");
  const timeoutMs = boundedInteger(options.timeoutMs, 10_000, 1_000, 30_000, "timeoutMs");
  const now = options.now === undefined ? Math.floor(Date.now() / 1_000) : options.now;
  const signed = signWebhook(body, { id: event.id, timestamp: now, secrets: options.secrets });
  const fetcher = options.fetch || globalThis.fetch;
  if (typeof fetcher !== "function") throw new Error("webhook delivery requires fetch support");
  const sleep =
    options.sleep ||
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const random = options.random || Math.random;
  let lastFailure = "Webhook request failed before a response was received";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response;
    try {
      response = await fetcher(destination, {
        method: "POST",
        headers: { "content-type": "application/json", ...signed },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      response = null;
    }
    if (response?.ok && response.status >= 200 && response.status < 300) {
      return { eventId: event.id, status: response.status, attempts: attempt };
    }
    if (response) lastFailure = `Webhook endpoint returned HTTP ${response.status}`;
    const retryable = !response || RETRYABLE_STATUSES.has(response.status);
    if (!retryable || attempt === attempts) throw new Error(lastFailure);
    await sleep(retryDelay(response, attempt, random));
  }
  throw new Error(lastFailure);
}

module.exports = {
  buildNotificationEvents,
  deliverWebhook,
  signWebhook,
  validateNotificationEvent,
  verifyWebhookSignature,
};
