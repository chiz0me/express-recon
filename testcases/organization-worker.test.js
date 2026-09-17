"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");

// Drive the real supervisor with a virtual clock and worker, without network
// requests, target execution, global mocks or multi-minute timeout tests.
function supervisor(options = {}, observer) {
  const filename = require.resolve("../src/organization");
  const localRequire = createRequire(filename);
  const timers = new Set();
  let now = 0;
  let worker;
  class FakeWorker extends EventEmitter {
    constructor() {
      super();
      worker = this;
      this.terminations = 0;
    }
    terminate() {
      this.terminations++;
      return Promise.resolve(0);
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(filename, "utf8"),
    {
      module,
      exports: module.exports,
      __dirname: path.dirname(filename),
      require: (name) =>
        name === "node:worker_threads" ? { Worker: FakeWorker } : localRequire(name),
      Buffer,
      Date: class extends Date {
        static now() {
          return now;
        }
      },
      setTimeout(callback, delay) {
        const timer = { callback, at: now + delay, unref() {} };
        timers.add(timer);
        return timer;
      },
      clearTimeout(timer) {
        timers.delete(timer);
      },
    },
    { filename },
  );
  const result = module.exports.scanRepositoryInWorker("acme/api", options, observer).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  return {
    result,
    get worker() {
      return worker;
    },
    timers,
    phase(phase) {
      worker.emit("message", { type: "progress", progress: { phase } });
    },
    tick(milliseconds) {
      const until = now + milliseconds;
      for (;;) {
        const next = [...timers]
          .filter((timer) => timer.at <= until)
          .sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        timers.delete(next);
        next.callback();
      }
      now = until;
    },
  };
}

test("worker gives analysis a full budget after slow acquisition", async () => {
  const run = supervisor();
  run.phase("acquiring");
  run.tick(83_000);
  run.phase("analyzing");
  run.tick(90_000);
  assert.equal(run.worker.terminations, 0);
  for (const phase of ["discovering", "inventorying", "cataloging", "documenting", "cleaning-up"]) {
    run.phase(phase);
    run.tick(1_000);
  }
  const scan = { kind: "repository-scan" };
  run.worker.emit("message", { type: "result", ok: true, scan });
  assert.equal((await run.result).value, scan);
  assert.equal(run.timers.size, 0);
  assert.equal(run.worker.terminations, 1);
});

test("worker watchdog identifies a genuinely stalled phase and merged timeout", async () => {
  const run = supervisor({ config: { scan: { timeoutMs: 60_000 } }, scan: { timeoutMs: 10_000 } });
  run.phase("acquiring");
  run.tick(9_000);
  run.phase("analyzing");
  run.tick(14_999);
  assert.equal(run.worker.terminations, 0);
  run.tick(1);
  const { error } = await run.result;
  assert.match(error.message, /15000ms.*analyzing/);
  assert.match(error.message, /scan.timeoutMs.*10000/);
  assert.equal(run.timers.size, 0);
  assert.equal(run.worker.terminations, 1);
});

test("repeated, unknown and backward progress cannot keep a stuck worker alive", async () => {
  const run = supervisor();
  run.phase("acquiring");
  run.phase("analyzing");
  run.tick(124_000);
  for (const phase of ["analyzing", "acquiring", "unknown", undefined]) run.phase(phase);
  run.tick(1_000);
  assert.match((await run.result).error.message, /125000ms.*analyzing/);
  run.phase("discovering");
  assert.equal(run.timers.size, 0);
});

test("progress observers cannot prevent phase watchdog transitions", async () => {
  const run = supervisor({}, () => {
    throw new Error("observer failed");
  });
  run.tick(124_000);
  run.phase("analyzing");
  run.tick(124_000);
  assert.equal(run.worker.terminations, 0);
  run.tick(1_000);
  assert.match((await run.result).error.message, /analyzing/);
});

test("worker error, failure result and result-less exit clear the watchdog", async () => {
  for (const send of [
    (worker) => worker.emit("error", new Error("worker error")),
    (worker) => worker.emit("message", { ok: false, error: "scan failed" }),
    (worker) => worker.emit("exit", 0),
    (worker) => worker.emit("exit", 1),
  ]) {
    const run = supervisor();
    send(run.worker);
    assert.ok((await run.result).error);
    assert.equal(run.timers.size, 0);
    assert.equal(run.worker.terminations, 1);
  }
});

test("invalid scan timeout is rejected before starting a worker", async () => {
  const run = supervisor({ scan: { timeoutMs: 1 } });
  assert.match((await run.result).error.message, /scan.timeoutMs/);
  assert.equal(run.worker, undefined);
  assert.equal(run.timers.size, 0);
});
