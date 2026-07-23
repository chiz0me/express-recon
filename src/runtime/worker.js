#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { instrument, resetCapture, getCapturedRoots, harvestApp } = require("./instrument");
const { installSandbox } = require("./sandbox");
const { walk } = require("../walk");

function instrumentApp(resolved) {
  try {
    instrument(require(require.resolve("express", { paths: [path.dirname(resolved)] })));
  } catch {
    // The app may not use a resolvable Express instance. Mount paths then fall
    // back to the runtime walker's Express 4 regexp recovery.
  }
}

async function loadRegistry(appPath, boot) {
  instrumentApp(appPath);
  resetCapture();
  const sandbox = boot.sandbox === false ? null : installSandbox({ stubModules: boot.stubModules });
  let mod;
  let bootError = null;
  try {
    try {
      mod = require(appPath);
    } catch (err) {
      if (!["ERR_REQUIRE_ESM", "ERR_REQUIRE_ASYNC_MODULE"].includes(err.code)) throw err;
      mod = await import(pathToFileURL(appPath).href);
    }
  } catch (err) {
    bootError = err;
  }

  // Allow promise- and short timer-deferred registration to settle. The parent
  // still enforces the overall timeout and terminates leaked timers.
  await new Promise((resolve) => setImmediate(resolve));
  if (boot.settleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, boot.settleMs));
  }
  const diagnostics = sandbox ? sandbox.diagnostics() : [];
  diagnostics.unshift(
    "boot: target code executed in an isolated worker process; the worker limits process " +
      "side effects but is not an OS security sandbox and retains this user's permissions",
  );
  if (sandbox) sandbox.uninstall();

  const exported = mod && (mod.app || mod.default) ? mod.app || mod.default : mod;
  const usable = exported && (typeof exported === "function" || exported.use);
  let app;
  if (!bootError && usable) {
    app = exported;
  } else {
    const reason = bootError
      ? `threw during require: ${bootError.message}`
      : `did not export an Express app (got ${typeof exported})`;
    const roots = getCapturedRoots();
    if (roots.length === 0) throw new Error(`Failed to load ${appPath}:\n  ${reason}`);
    diagnostics.push(
      `boot: ${appPath} ${reason}; harvested routes from ${roots.length} captured ` +
        "app/router(s) registered before the failure — results may be partial",
    );
    app = harvestApp(roots);
  }

  const registry = walk(app);
  if (diagnostics.length) {
    registry.diagnostics = [...(registry.diagnostics || []), ...diagnostics];
  }
  return registry;
}

function respond(message) {
  if (!process.send) return;
  process.send(message, () => {
    process.disconnect();
    process.exit(message.type === "result" ? 0 : 1);
  });
}

process.once("message", async ({ appPath, boot }) => {
  try {
    const registry = await loadRegistry(appPath, boot || {});
    const bytes = Buffer.byteLength(JSON.stringify(registry));
    if (bytes > boot.maxOutputBytes) {
      throw new Error(
        `Runtime registry exceeded boot.maxOutputBytes (${boot.maxOutputBytes} bytes)`,
      );
    }
    respond({ type: "result", value: registry });
  } catch (err) {
    respond({ type: "error", message: err && err.message ? err.message : String(err) });
  }
});
