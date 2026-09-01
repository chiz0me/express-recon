"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createOrganizationProgressReporter,
  formatPlainProgress,
  resolveProgressMode,
} = require("../src/organization-progress");

function captureStream(isTTY = false) {
  let output = "";
  return {
    isTTY,
    stream: {
      isTTY,
      write(value) {
        output += value;
        return true;
      },
    },
    output: () => output,
  };
}

test("organization progress auto-selects TTY or CI-safe plain output", () => {
  assert.equal(resolveProgressMode("auto", true), "tty");
  assert.equal(resolveProgressMode("auto", false), "plain");
  assert.equal(resolveProgressMode("json", true), "json");
  assert.throws(() => resolveProgressMode("fancy", false), /auto, plain, json, or none/);

  const capture = captureStream(false);
  const reporter = createOrganizationProgressReporter({ mode: "auto", stream: capture.stream });
  reporter.emit({
    event: "enumeration-completed",
    organization: "acme",
    discovered: 12,
    selected: 8,
    skipped: 4,
    resumed: 2,
    pending: 6,
    concurrency: 3,
    total: 8,
  });
  reporter.emit({
    event: "repository-skipped",
    repository: "acme/archived-private-name",
    status: "skipped-archived",
  });
  reporter.emit({
    event: "repository-started",
    repository: "acme/api",
    processed: 2,
    total: 8,
    active: 1,
    concurrency: 3,
  });
  reporter.close();

  assert.equal(reporter.mode, "plain");
  assert.doesNotMatch(capture.output(), /\r/);
  assert.match(capture.output(), /READY 12 discovered · 8 selected · 4 skipped · 2 resumed/);
  assert.match(capture.output(), /\[2\/8\] START acme\/api · active 1\/3/);
  assert.doesNotMatch(capture.output(), /archived-private-name/);
  assert.ok(capture.output().endsWith("\n"));
});

test("JSON progress is one metadata-complete event per stderr line", () => {
  const capture = captureStream(false);
  let clock = Date.parse("2026-08-29T00:00:00.000Z");
  const reporter = createOrganizationProgressReporter({
    mode: "json",
    stream: capture.stream,
    now: () => (clock += 25),
  });
  reporter.emit({ event: "enumeration-started", organization: "acme" });
  reporter.emit({
    event: "repository-failed",
    organization: "acme",
    repository: "acme/api",
    error: "clone failed\nwith details",
    processed: 1,
    total: 1,
    failed: 1,
  });
  reporter.close();

  const events = capture
    .output()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((event) => event.event),
    ["enumeration-started", "repository-failed"],
  );
  assert.ok(events.every((event) => event.schemaVersion === "1.0"));
  assert.ok(events.every((event) => event.kind === "organization-scan-progress"));
  assert.ok(events.every((event) => event.timestamp.startsWith("2026-08-29T")));
  assert.equal(events[1].error, "clone failed\nwith details");
});

test("plain progress renders every organization lifecycle event", () => {
  const cases = [
    [{ event: "enumeration-started", organization: "acme" }, /ENUMERATE acme/],
    [
      {
        event: "enumeration-page",
        page: 2,
        repositoriesDiscovered: 175,
        rateLimit: { remaining: 42 },
      },
      /PAGE 2 · 175 visible · API remaining 42/,
    ],
    [{ event: "enumeration-failed", error: "denied" }, /FAILED enumeration · denied/],
    [{ event: "scan-failed", organization: "acme", error: "offline" }, /FAILED acme scan/],
    [
      { event: "repository-resumed", repository: "acme/api", status: "express" },
      /RESUME acme\/api · express/,
    ],
    [
      { event: "repository-phase", repository: "acme/api", phase: "discovering" },
      /PHASE acme\/api · discovering/,
    ],
    [
      {
        event: "repository-completed",
        repository: "acme/api",
        status: "express",
        routes: 4,
        applications: 1,
        routeGraphComplete: false,
        durationMs: 1_250,
      },
      /COMPLETE acme\/api · express · 4 routes · 1 apps · route graph incomplete · 1\.3s/,
    ],
    [
      {
        event: "repository-failed",
        repository: "acme/api",
        error: "denied",
        durationMs: 61_000,
      },
      /FAILED acme\/api · denied · 1m 1s/,
    ],
    [
      { event: "checkpoint-written", repository: "acme/api", completedRepositories: 3 },
      /CHECKPOINT acme\/api · 3 durable/,
    ],
    [{ event: "resume-warning", message: "retrying damage" }, /WARN resume · retrying damage/],
    [
      { event: "gate-triggered", gate: "incomplete", message: "coverage failed" },
      /GATE incomplete · coverage failed/,
    ],
    [
      {
        event: "scan-finished",
        organization: "acme",
        complete: true,
        completed: 2,
        total: 2,
        expressRepositories: 1,
        failedRepositories: 0,
        durationMs: 12_000,
      },
      /FINISHED acme · 2\/2 processed · 1 express · 0 failed · complete · 12s/,
    ],
    [{ event: "custom-event", fullName: "acme/api" }, /CUSTOM-EVENT acme\/api/],
  ];
  for (const [event, expected] of cases) assert.match(formatPlainProgress(event), expected);
  assert.equal(formatPlainProgress({ event: "repository-skipped" }), null);
});

test("TTY progress keeps active repository phases visible and clears its status", () => {
  const capture = captureStream(true);
  const reporter = createOrganizationProgressReporter({ mode: "auto", stream: capture.stream });
  reporter.emit({
    event: "enumeration-completed",
    organization: "acme",
    discovered: 1,
    selected: 1,
    resumed: 0,
    pending: 1,
    concurrency: 1,
    total: 1,
  });
  reporter.emit({
    event: "repository-started",
    repository: "acme/api",
    processed: 0,
    total: 1,
    active: 1,
    failed: 0,
    concurrency: 1,
  });
  reporter.emit({
    event: "repository-phase",
    repository: "acme/api",
    phase: "inventorying",
    processed: 0,
    total: 1,
    active: 1,
    failed: 0,
  });
  reporter.close();

  assert.equal(reporter.mode, "tty");
  assert.match(capture.output(), /\rexpress-recon .*acme\/api:inventorying/);
  assert.match(capture.output(), /\r +\r$/);

  const terminal = captureStream(true);
  const terminalReporter = createOrganizationProgressReporter({
    mode: "auto",
    stream: terminal.stream,
  });
  terminalReporter.emit({ event: "repository-started", repository: "acme/api", total: 1 });
  terminalReporter.emit({
    event: "repository-completed",
    repository: "acme/api",
    processed: 1,
    total: 1,
    failed: 0,
  });
  terminalReporter.emit({
    event: "scan-finished",
    organization: "acme",
    complete: true,
    processed: 1,
    total: 1,
  });
  terminalReporter.close();
  assert.match(terminal.output(), /FINISHED acme/);
  assert.ok(terminal.output().endsWith("\n"));
});

test("quiet progress writes nothing and plain rendering strips control characters", () => {
  const capture = captureStream(false);
  const reporter = createOrganizationProgressReporter({ mode: "none", stream: capture.stream });
  assert.equal(reporter.emit({ event: "enumeration-started", organization: "acme" }), null);
  reporter.close();
  assert.equal(capture.output(), "");

  const line = formatPlainProgress({
    event: "repository-failed",
    repository: "acme/api\nspoof",
    error: "bad\r\nnext",
    processed: 1,
    total: 2,
  });
  assert.equal(line.split("\n").length, 1);
  assert.match(line, /acme\/api spoof · bad next/);

  const broken = createOrganizationProgressReporter({
    mode: "json",
    stream: {
      write() {
        throw new Error("closed");
      },
    },
  });
  assert.equal(broken.emit({ event: "enumeration-started" }), null);
  assert.equal(broken.emit({ event: "enumeration-started" }), null);
});
