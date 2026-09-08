"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  acquireArtifactLock,
  artifactGeneration,
  recoverArtifactTransaction,
  replaceArtifactDirectory,
} = require("../src/artifact-transaction");

function workspace(run) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-artifact-writer-"));
  try {
    return run(parent, path.join(parent, "state"));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function directory(parent, name, contents) {
  const target = path.join(parent, name);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "value.txt"), contents);
  return target;
}

test("artifact outputs admit only one live writer", () =>
  workspace((_parent, output) => {
    const release = acquireArtifactLock(output);
    try {
      assert.throws(() => acquireArtifactLock(output), /locked by writer process/);
    } finally {
      release();
    }
    const releaseAgain = acquireArtifactLock(output);
    releaseAgain();
  }));

test("artifact compare-and-swap preserves intervening user edits", () =>
  workspace((parent, output) => {
    directory(parent, "state", "old");
    const expectedGeneration = artifactGeneration(output);
    const staging = directory(parent, ".state.express-recon-staging-cas", "new");
    assert.throws(
      () =>
        replaceArtifactDirectory({
          staging,
          output,
          expectedGeneration,
          hooks: {
            beforeCompareAndSwap() {
              fs.writeFileSync(path.join(output, "value.txt"), "user edit");
            },
          },
        }),
      /changed after it was read/,
    );
    assert.equal(fs.readFileSync(path.join(output, "value.txt"), "utf8"), "user edit");
  }));

test("artifact replacement restores the prior directory after a move failure", () =>
  workspace((parent, output) => {
    directory(parent, "state", "old");
    const staging = directory(parent, ".state.express-recon-staging-failure", "new");
    assert.throws(
      () =>
        replaceArtifactDirectory({
          staging,
          output,
          expectedGeneration: artifactGeneration(output),
          hooks: { afterOldMoved: () => assert.fail("injected replacement failure") },
        }),
      /injected replacement failure/,
    );
    assert.equal(fs.readFileSync(path.join(output, "value.txt"), "utf8"), "old");
  }));

test("startup recovery restores an interrupted old-moved transaction", () =>
  workspace((parent, output) => {
    directory(parent, "state", "old");
    const staging = directory(parent, ".state.express-recon-staging-crash", "new");
    const backup = path.join(parent, ".state.express-recon-backup-crash");
    fs.renameSync(output, backup);
    const marker = path.join(parent, ".state.express-recon-transaction.json");
    fs.writeFileSync(
      marker,
      JSON.stringify({
        kind: "express-recon-artifact-transaction",
        output,
        staging,
        backup,
        expectedGeneration: "sha256:test",
        phase: "old-moved",
      }),
    );
    assert.deepEqual(recoverArtifactTransaction(output), { recovered: true, phase: "old-moved" });
    assert.equal(fs.readFileSync(path.join(output, "value.txt"), "utf8"), "old");
    assert.equal(fs.existsSync(staging), false);
    assert.equal(fs.existsSync(marker), false);
  }));

test("startup recovery installs an interrupted first artifact write", () =>
  workspace((parent, output) => {
    const staging = directory(parent, ".state.express-recon-staging-first", "new");
    const backup = path.join(parent, ".state.express-recon-backup-first");
    const marker = path.join(parent, ".state.express-recon-transaction.json");
    fs.writeFileSync(
      marker,
      JSON.stringify({
        kind: "express-recon-artifact-transaction",
        output,
        staging,
        backup,
        expectedGeneration: null,
        phase: "prepared",
      }),
    );

    assert.deepEqual(recoverArtifactTransaction(output), { recovered: true, phase: "prepared" });
    assert.equal(fs.readFileSync(path.join(output, "value.txt"), "utf8"), "new");
    assert.equal(fs.existsSync(staging), false);
    assert.equal(fs.existsSync(marker), false);
  }));

test("startup recovery finalizes an installed first artifact write", () =>
  workspace((parent, output) => {
    directory(parent, "state", "new");
    const staging = path.join(parent, ".state.express-recon-staging-installed");
    const backup = path.join(parent, ".state.express-recon-backup-installed");
    const marker = path.join(parent, ".state.express-recon-transaction.json");
    fs.writeFileSync(
      marker,
      JSON.stringify({
        kind: "express-recon-artifact-transaction",
        output,
        staging,
        backup,
        expectedGeneration: null,
        phase: "installed",
      }),
    );

    assert.deepEqual(recoverArtifactTransaction(output), { recovered: true, phase: "installed" });
    assert.equal(fs.readFileSync(path.join(output, "value.txt"), "utf8"), "new");
    assert.equal(fs.existsSync(marker), false);
  }));
