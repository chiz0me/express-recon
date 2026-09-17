"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

function acquisition(t, { count = 130, changeBatch, advanceAfterBatch = 0, objectId } = {}) {
  const filename = require.resolve("../src/repository");
  const localRequire = createRequire(filename);
  const body = Buffer.from([0, 10, 255, 195, 169]);
  const object = objectId || "b".repeat(40);
  const calls = [];
  const temps = [];
  let now = 0;
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(filename, "utf8"),
    {
      module,
      exports: module.exports,
      process: { once() {} },
      Buffer,
      Date: class extends Date {
        static now() {
          return now;
        }
      },
      require(name) {
        if (name !== "node:child_process") return localRequire(name);
        return {
          spawnSync(command, args, options) {
            assert.equal(command, "git");
            let stdout = "";
            if (args[0] === "init") {
              fs.mkdirSync(args.at(-1), { recursive: true });
              temps.push(path.dirname(args.at(-1)));
            }
            if (args.includes("rev-parse")) stdout = "a".repeat(40) + "\n";
            if (args.includes("ls-tree"))
              stdout = Array.from(
                { length: count },
                (_, i) => `100644 blob ${object} ${body.length}\tfile-${i}.json\0`,
              ).join("");
            if (args.includes("cat-file")) {
              calls.push({ args, options });
              assert.ok(args.includes("--batch"));
              const objects = options.input.trim().split("\n");
              assert.ok(objects.length <= 64);
              stdout = Buffer.concat(
                objects.flatMap((id) => [
                  Buffer.from(`${id} blob ${body.length}\n`),
                  body,
                  Buffer.from("\n"),
                ]),
              );
              if (changeBatch) stdout = changeBatch(stdout);
              assert.ok(stdout.length <= options.maxBuffer);
              now += advanceAfterBatch;
            }
            return { status: 0, stdout, stderr: "" };
          },
        };
      },
    },
    { filename },
  );
  t.after(() => {
    for (const temp of temps) module.exports.releaseRepository(temp);
  });
  return { api: module.exports, calls, body, temps };
}

test("acquisition reads 130 files in three bounded Git batches", (t) => {
  const { api, calls, body } = acquisition(t);
  const result = api.acquireRepository("acme/api");
  assert.equal(calls.length, 3);
  assert.equal(result.provenance.acquisition.materializedFiles, 130);
  assert.equal(result.provenance.acquisition.materializedBytes, 130 * body.length);
  assert.equal(result.provenance.acquisition.complete, true);
  assert.deepEqual(fs.readFileSync(path.join(result.snapshot, "file-129.json")), body);
});

test("batch acquisition retains partial coverage when materialization deadline expires", (t) => {
  const { api, calls } = acquisition(t, { advanceAfterBatch: 1_001 });
  const result = api.acquireRepository("acme/api", { scan: { timeoutMs: 1_000 } });
  assert.equal(calls.length, 1);
  assert.equal(result.provenance.acquisition.materializedFiles, 64);
  assert.equal(result.provenance.acquisition.skippedFiles, 66);
  assert.equal(result.provenance.acquisition.complete, false);
  assert.equal(result.provenance.acquisition.limited, true);
  assert.match(result.provenance.acquisition.diagnostics.join(" "), /scan.timeoutMs/);
});

test("malformed Git batch output is rejected and acquired snapshots are cleaned", (t) => {
  const mutations = [
    (buffer) => Buffer.from(buffer.toString("latin1").replace(" blob ", " tree "), "latin1"),
    (buffer) => buffer.subarray(0, buffer.length - 2),
    (buffer) => Buffer.concat([buffer, Buffer.from("unexpected")]),
    () => Buffer.from("b".repeat(40) + " missing\n"),
    () => Buffer.from("no header newline"),
  ];
  for (const changeBatch of mutations) {
    const { api, temps } = acquisition(t, { count: 1, changeBatch });
    assert.throws(() => api.acquireRepository("acme/api"), /Repository blob batch returned/);
    assert.ok(temps.every((temp) => !fs.existsSync(temp)));
  }
});

test("tree object identifiers cannot inject additional Git batch requests", (t) => {
  const { api, calls } = acquisition(t, { count: 1, objectId: "not-an-object" });
  assert.throws(() => api.acquireRepository("acme/api"), /invalid blob object id/);
  assert.equal(calls.length, 0);
});
