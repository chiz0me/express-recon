"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  buildNotificationEvents,
  deliverWebhook,
  signWebhook,
  validateNotificationEvent,
  verifyWebhookSignature,
} = require("../src");

const CLI = path.join(__dirname, "..", "src", "cli.js");
const SECRET = "current-webhook-secret-material-1234567890";
const PREVIOUS_SECRET = "previous-webhook-secret-material-123456";
const NOW_SECONDS = 1_800_000_000;
const NOW = NOW_SECONDS * 1_000;

function report(overrides = {}) {
  return {
    schemaVersion: "2.0",
    tool: "express-recon",
    target: { name: "example-service" },
    routes: [],
    scanCoverage: { complete: true },
    routeGraph: { complete: true },
    delta: {
      addedRoutes: [
        {
          applicationId: "app:src/app.js#app",
          method: "POST",
          path: "/orders",
          authStatus: "proven",
          source: { file: "src/routes.js", line: 12 },
        },
        { method: "GET", path: "/orders/:id", source: null },
      ],
      removedRoutes: [],
      authRegressions: [
        {
          method: "DELETE",
          path: "/orders/:id",
          from: "proven",
          to: "public",
          source: { file: "src/routes.js", line: 30 },
        },
      ],
    },
    ...overrides,
  };
}

test("notification events are bounded, data-minimized, and deterministically identified", () => {
  const options = {
    maxItems: 1,
    now: NOW,
    context: {
      repository: "owner/repository",
      revision: "0123456789abcdef",
      runId: "42",
      runUrl: "https://github.com/owner/repository/actions/runs/42",
    },
  };
  const events = buildNotificationEvents(report(), options);
  assert.deepEqual(
    events.map((event) => event.type),
    ["express_recon.routes.added", "express_recon.auth.regressed"],
  );
  assert.equal(events[0].data.total, 2);
  assert.equal(events[0].data.shown, 1);
  assert.equal(events[0].data.truncated, true);
  assert.equal(events[0].data.items[0].path, "/orders");
  assert.equal(events[0].data.items[0].source, undefined);
  assert.equal(events[0].subject, "owner/repository");
  assert.equal(events[0].createdAt, new Date(NOW).toISOString());
  assert.match(events[0].id, /^evt_[A-Za-z0-9_-]{36}$/);

  const later = buildNotificationEvents(report(), { ...options, now: NOW + 60_000 });
  assert.equal(later[0].id, events[0].id, "delivery reruns retain the idempotency ID");
  assert.notEqual(later[0].createdAt, events[0].createdAt);

  const withSource = buildNotificationEvents(report(), {
    events: ["routes.added"],
    includeSource: true,
    now: NOW,
  });
  assert.deepEqual(withSource[0].data.items[0].source, { file: "src/routes.js", line: 12 });
});

test("notification event validation fails closed and empty deltas are no-ops", () => {
  assert.deepEqual(
    buildNotificationEvents(
      report({
        delta: { addedRoutes: [], authRegressions: [], removedRoutes: [] },
      }),
      { now: NOW },
    ),
    [],
  );
  assert.throws(() => buildNotificationEvents({}, { now: NOW }), /routes report/);
  assert.throws(
    () =>
      buildNotificationEvents(
        { kind: "github-organization-inventory", organization: { login: "example" } },
        { events: ["scan.incomplete"], now: NOW },
      ),
    /unexpected contract/,
  );
  assert.throws(
    () => buildNotificationEvents(report({ delta: undefined }), { now: NOW }),
    /--baseline/,
  );
  assert.throws(
    () => buildNotificationEvents(report(), { events: ["routes.added", "routes.added"] }),
    /duplicates/,
  );
  assert.throws(
    () => buildNotificationEvents(report(), { events: ["unknown.event"] }),
    /unknown notification event/,
  );
  assert.throws(() => buildNotificationEvents(report(), { maxItems: 0 }), /maxItems/);
  assert.throws(
    () =>
      buildNotificationEvents(report(), {
        context: { runUrl: "http://example.com/run" },
      }),
    /runUrl must use HTTPS/,
  );
});

test("unsafe source paths are omitted even when source metadata is requested", () => {
  const input = report();
  input.delta.addedRoutes[0].source = { file: "../../etc/passwd", line: 1 };
  const [event] = buildNotificationEvents(input, {
    events: ["routes.added"],
    includeSource: true,
    now: NOW,
  });
  assert.equal(event.data.items[0].source, undefined);
});

test("incomplete route and organization evidence emits an explicit event", () => {
  const [routeEvent] = buildNotificationEvents(
    report({
      scanCoverage: { complete: false },
      routeGraph: { complete: false },
      delta: undefined,
    }),
    { events: ["scan.incomplete"], now: NOW },
  );
  assert.equal(routeEvent.type, "express_recon.scan.incomplete");
  assert.deepEqual(
    routeEvent.data.items.map((item) => item.component),
    ["source-scan", "route-graph"],
  );

  const [organizationEvent] = buildNotificationEvents(
    {
      kind: "github-organization-inventory",
      organization: { login: "example" },
      repositories: [],
      coverage: { complete: false },
    },
    { events: ["scan.incomplete"], now: NOW },
  );
  assert.equal(organizationEvent.subject, "example");
  assert.equal(organizationEvent.data.items[0].component, "organization-scan");
});

test("organization deltas retain exact counts and bound route details", () => {
  const organization = {
    kind: "github-organization-inventory-delta",
    organization: { login: "example" },
    coverage: { complete: false },
    summary: { addedRoutes: 3, removedRoutes: 0, authRegressions: 1 },
    repositories: [
      {
        repository: { fullName: "example/service" },
        changes: {
          routes: {
            details: {
              addedRoutes: [
                { method: "GET", path: "/one", source: { file: "src/app.js", line: 1 } },
                { method: "POST", path: "/two", source: null },
              ],
              authRegressions: [{ method: "DELETE", path: "/three", from: "proven", to: "public" }],
            },
          },
        },
      },
    ],
  };
  const events = buildNotificationEvents(organization, {
    maxItems: 1,
    includeSource: true,
    now: NOW,
  });
  assert.deepEqual(
    events.map((event) => event.type),
    ["express_recon.routes.added", "express_recon.auth.regressed", "express_recon.scan.incomplete"],
  );
  assert.equal(events[0].data.total, 3);
  assert.equal(events[0].data.shown, 1);
  assert.equal(events[0].data.items[0].repository, "example/service");
  assert.deepEqual(events[0].data.items[0].source, { file: "src/app.js", line: 1 });
});

test("compact organization inventories produce repository summaries", () => {
  const events = buildNotificationEvents(
    {
      kind: "github-organization-inventory",
      organization: { login: "example" },
      repositories: [],
      coverage: { complete: true },
      delta: {
        coverage: { complete: true },
        summary: { addedRoutes: 4, removedRoutes: 0, authRegressions: 0 },
        repositories: [
          {
            repository: { fullName: "example/service" },
            routeChanges: { addedRoutes: 4 },
          },
        ],
      },
    },
    { events: ["routes.added"], now: NOW },
  );
  assert.equal(events[0].data.detail, "repository-summary");
  assert.deepEqual(events[0].data.items, [{ repository: "example/service", count: 4 }]);
});

test("organization notifications can mix retained routes and repository summaries", () => {
  const [event] = buildNotificationEvents(
    {
      kind: "github-organization-inventory-delta",
      organization: { login: "example" },
      coverage: { complete: true },
      summary: { addedRoutes: 3, removedRoutes: 0, authRegressions: 0 },
      repositories: [
        {
          repository: { fullName: "example/detailed" },
          changes: {
            routes: {
              details: { addedRoutes: [{ method: "GET", path: "/one" }] },
            },
          },
        },
        {
          repository: { fullName: "example/summarized" },
          changes: { routes: { summary: { addedRoutes: 2 } } },
        },
      ],
    },
    { events: ["routes.added"], now: NOW },
  );
  assert.equal(event.data.detail, "mixed");
  assert.deepEqual(event.data.items, [
    { repository: "example/detailed", method: "GET", path: "/one" },
    { repository: "example/summarized", count: 2 },
  ]);
});

test("Standard Webhooks signatures verify the exact body and support rotation", () => {
  const body = JSON.stringify({ id: "evt_example", type: "express_recon.routes.added" });
  const headers = signWebhook(body, {
    id: "evt_example",
    timestamp: NOW_SECONDS,
    secrets: [SECRET, PREVIOUS_SECRET],
  });
  assert.equal(headers["webhook-signature"].split(" ").length, 2);
  const expected = crypto
    .createHmac("sha256", SECRET)
    .update(`evt_example.${NOW_SECONDS}.${body}`)
    .digest("base64");
  assert.match(headers["webhook-signature"], new RegExp(`^v1,${expected.replaceAll("+", "\\+")}`));
  assert.deepEqual(verifyWebhookSignature(body, headers, PREVIOUS_SECRET, { now: NOW_SECONDS }), {
    id: "evt_example",
    timestamp: NOW_SECONDS,
  });
  assert.throws(
    () => verifyWebhookSignature(`${body} `, headers, SECRET, { now: NOW_SECONDS }),
    /signature is invalid/,
  );
  assert.throws(
    () => verifyWebhookSignature(body, headers, SECRET, { now: NOW_SECONDS + 301 }),
    /timestamp/,
  );
  assert.throws(
    () => verifyWebhookSignature(body, {}, SECRET, { now: NOW_SECONDS }),
    /headers are missing/,
  );

  const encoded = `whsec_${Buffer.from(SECRET).toString("base64")}`;
  const encodedHeaders = signWebhook(body, {
    id: "evt_example",
    timestamp: NOW_SECONDS,
    secrets: encoded,
  });
  assert.deepEqual(verifyWebhookSignature(body, encodedHeaders, encoded, { now: NOW_SECONDS }), {
    id: "evt_example",
    timestamp: NOW_SECONDS,
  });
});

test("notification event validation rejects inconsistent or extended envelopes", () => {
  const event = buildNotificationEvents(report(), {
    events: ["routes.added"],
    includeSource: true,
    now: NOW,
  })[0];
  assert.equal(validateNotificationEvent(event), event);

  const extended = structuredClone(event);
  extended.unexpected = true;
  assert.throws(() => validateNotificationEvent(extended), /unsupported field/);

  const inconsistent = structuredClone(event);
  inconsistent.data.shown++;
  assert.throws(() => validateNotificationEvent(inconsistent), /counts, items/);

  const unsafeSource = structuredClone(event);
  unsafeSource.data.items[0].source.file = "../outside.js";
  assert.throws(() => validateNotificationEvent(unsafeSource), /repository-relative/);

  const invalidContext = structuredClone(event);
  invalidContext.context = { ref: "bad\nref" };
  assert.throws(() => validateNotificationEvent(invalidContext), /control characters/);
});

test("webhook delivery retries transient failures and sends verifiable headers", async () => {
  const event = buildNotificationEvents(report(), {
    events: ["routes.added"],
    now: NOW,
  })[0];
  const requests = [];
  const waits = [];
  const result = await deliverWebhook(event, {
    url: "https://events.example.com/express-recon",
    allowHosts: ["events.example.com"],
    secrets: SECRET,
    now: NOW_SECONDS,
    random: () => 0,
    sleep: async (milliseconds) => waits.push(milliseconds),
    fetch: async (_url, request) => {
      requests.push(request);
      return requests.length === 1
        ? { ok: false, status: 503, headers: { get: () => "0.001" } }
        : { ok: true, status: 204, headers: { get: () => null } };
    },
  });
  assert.deepEqual(result, { eventId: event.id, status: 204, attempts: 2 });
  assert.deepEqual(waits, [1]);
  assert.equal(requests[0].redirect, "error");
  assert.equal(requests[0].body, requests[1].body);
  assert.deepEqual(
    verifyWebhookSignature(requests[0].body, requests[0].headers, SECRET, {
      now: NOW_SECONDS,
    }),
    { id: event.id, timestamp: NOW_SECONDS },
  );
});

test("webhook delivery rejects unsafe destinations and non-retryable responses", async () => {
  const event = buildNotificationEvents(report(), {
    events: ["routes.added"],
    now: NOW,
  })[0];
  const base = {
    allowHosts: ["events.example.com"],
    secrets: SECRET,
    attempts: 1,
    now: NOW_SECONDS,
    fetch: async () => ({ ok: false, status: 400, headers: { get: () => null } }),
  };
  await assert.rejects(
    deliverWebhook(event, { ...base, url: "https://events.example.com/hook?token=secret" }),
    /without credentials, query, or fragment/,
  );
  await assert.rejects(
    deliverWebhook(event, { ...base, url: "https://other.example.com/hook" }),
    /explicitly allowed/,
  );
  await assert.rejects(
    deliverWebhook(event, { ...base, url: "https://events.example.com/hook", allowHosts: [] }),
    /--allow-host/,
  );
  await assert.rejects(
    deliverWebhook(event, { ...base, url: "https://events.example.com/hook" }),
    /HTTP 400/,
  );
  await assert.rejects(
    deliverWebhook(event, {
      ...base,
      url: "https://events.example.com/hook",
      secrets: "too-short",
    }),
    /at least 32 bytes/,
  );
});

test("notify CLI dry-run needs no secret and an empty delta is a credential-free no-op", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-notify-"));
  try {
    const input = path.join(directory, "routes.json");
    fs.writeFileSync(input, JSON.stringify(report()));
    const preview = spawnSync(
      process.execPath,
      [
        CLI,
        "notify",
        "--input",
        input,
        "--events",
        "routes.added",
        "--max-items",
        "1",
        "--include-source",
        "--dry-run",
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          GITHUB_REPOSITORY: "owner/repository",
          GITHUB_SHA: "0123456789abcdef",
          GITHUB_RUN_ID: "42",
          GITHUB_SERVER_URL: "https://github.com",
          EXPRESS_RECON_PULL_REQUEST: "7",
        },
      },
    );
    assert.equal(preview.status, 0, preview.stderr);
    const payload = JSON.parse(preview.stdout);
    assert.equal(payload.kind, "webhook-notification-preview");
    assert.equal(payload.eventsEmitted, 1);
    assert.equal(payload.events[0].context.pullRequest, "7");
    assert.deepEqual(payload.events[0].data.items[0].source, {
      file: "src/routes.js",
      line: 12,
    });

    fs.writeFileSync(
      input,
      JSON.stringify(
        report({ delta: { addedRoutes: [], removedRoutes: [], authRegressions: [] } }),
      ),
    );
    const noOp = spawnSync(process.execPath, [CLI, "notify", "--input", input], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    assert.equal(noOp.status, 0, noOp.stderr);
    assert.deepEqual(JSON.parse(noOp.stdout), {
      kind: "webhook-notification-result",
      provider: "webhook",
      eventsEmitted: 0,
      eventsDelivered: 0,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("notify CLI validates command-specific arguments and report files", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-notify-invalid-"));
  try {
    const input = path.join(directory, "routes.json");
    fs.writeFileSync(input, JSON.stringify(report()));
    for (const args of [
      ["notify"],
      ["notify", "--input", input, "--provider", "slack", "--dry-run"],
      ["notify", "--input", input, "--max-items", "0", "--dry-run"],
      ["notify", "--input", input, "--url-env", "lowercase", "--dry-run"],
      ["notify", "--input", input, "--format", "json"],
      ["notify", "--input", input, "--events", "unknown", "--dry-run"],
    ]) {
      const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
      assert.equal(result.status, 1, `${args.join(" ")} unexpectedly succeeded`);
      assert.ok(result.stderr.trim());
    }
    const link = path.join(directory, "linked.json");
    fs.symlinkSync(input, link);
    const linked = spawnSync(process.execPath, [CLI, "notify", "--input", link, "--dry-run"], {
      encoding: "utf8",
    });
    assert.equal(linked.status, 1);
    assert.match(linked.stderr, /regular JSON file/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
