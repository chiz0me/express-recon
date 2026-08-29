"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { scanRepository } = require("./repository");

try {
  const scan = scanRepository(workerData.source, {
    ...workerData.options,
    onProgress(progress) {
      parentPort.postMessage({ type: "progress", progress });
    },
  });
  parentPort.postMessage({ type: "result", ok: true, scan });
} catch (err) {
  parentPort.postMessage({
    type: "result",
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  });
}
