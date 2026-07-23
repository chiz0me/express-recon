"use strict";

const path = require("node:path");
const { fork } = require("node:child_process");

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const DEFAULT_SETTLE_MS = 50;
const LOG_TAIL_BYTES = 8 * 1024;
const BOOT_KEYS = new Set([
  "env",
  "inheritEnv",
  "maxOutputBytes",
  "sandbox",
  "settleMs",
  "stubModules",
  "timeoutMs",
]);

function boundedInteger(value, name, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`boot.${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function runtimeLimits(boot = {}) {
  if (!boot || typeof boot !== "object" || Array.isArray(boot)) {
    throw new Error("boot must be an object");
  }
  const unknown = Object.keys(boot).filter((key) => !BOOT_KEYS.has(key));
  if (unknown.length) throw new Error(`boot contains unknown field(s): ${unknown.join(", ")}`);
  if (boot.inheritEnv !== undefined && typeof boot.inheritEnv !== "boolean") {
    throw new Error("boot.inheritEnv must be a boolean");
  }
  if (boot.sandbox !== undefined && typeof boot.sandbox !== "boolean") {
    throw new Error("boot.sandbox must be a boolean");
  }
  if (
    boot.env !== undefined &&
    (!boot.env || typeof boot.env !== "object" || Array.isArray(boot.env))
  ) {
    throw new Error("boot.env must be an object");
  }
  for (const [key, value] of Object.entries(boot.env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`boot.env contains invalid environment variable name "${key}"`);
    }
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`boot.env.${key} must be a string, number, or boolean`);
    }
  }
  if (
    boot.stubModules !== undefined &&
    (!Array.isArray(boot.stubModules) ||
      boot.stubModules.some((name) => typeof name !== "string" || !name.trim()))
  ) {
    throw new Error("boot.stubModules must be an array of non-empty strings");
  }
  const limits = {
    timeoutMs: boundedInteger(boot.timeoutMs, "timeoutMs", DEFAULT_TIMEOUT_MS, 100, 300_000),
    settleMs: boundedInteger(boot.settleMs, "settleMs", DEFAULT_SETTLE_MS, 0, 5_000),
    maxOutputBytes: boundedInteger(
      boot.maxOutputBytes,
      "maxOutputBytes",
      DEFAULT_MAX_OUTPUT_BYTES,
      1024,
      100 * 1024 * 1024,
    ),
  };
  if (limits.settleMs >= limits.timeoutMs) {
    throw new Error("boot.settleMs must be less than boot.timeoutMs");
  }
  return limits;
}

function childEnvironment(boot) {
  const inherited = boot.inheritEnv === true ? process.env : {};
  const env = { ...inherited, EXPRESS_RECON_DRY: "1" };
  for (const [key, value] of Object.entries(boot.env || {})) env[key] = String(value);
  return env;
}

function errorWithLogs(message, stdout, stderr) {
  const logs = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
  return new Error(logs ? `${message}\nTarget output:\n${logs}` : message);
}

/**
 * Execute and walk an Express application in a disposable child process.
 *
 * The process boundary protects the CLI from process.exit(), crashes, leaked
 * timers, and prototype/module mutations. It is not an OS security sandbox:
 * the child retains the filesystem/network permissions of the invoking user.
 */
function executeRuntime(appPath, boot = {}) {
  if (typeof appPath !== "string" || !appPath) {
    return Promise.reject(new Error("executeRuntime requires an application path"));
  }
  const resolved = path.resolve(appPath);
  const limits = runtimeLimits(boot);
  const worker = path.join(__dirname, "worker.js");

  return new Promise((resolve, reject) => {
    const child = fork(worker, [], {
      cwd: process.cwd(),
      env: childEnvironment(boot),
      execArgv: [],
      serialization: "json",
      silent: true,
    });
    let settled = false;
    let logBytes = 0;
    let stdout = "";
    let stderr = "";

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(result);
    };

    const capture = (kind) => (chunk) => {
      logBytes += chunk.length;
      const text = chunk.toString("utf8");
      if (kind === "stdout") stdout = (stdout + text).slice(-LOG_TAIL_BYTES);
      else stderr = (stderr + text).slice(-LOG_TAIL_BYTES);
      if (logBytes > limits.maxOutputBytes) {
        child.kill("SIGKILL");
        finish(
          errorWithLogs(
            `Runtime worker exceeded boot.maxOutputBytes (${limits.maxOutputBytes} bytes)`,
            stdout,
            stderr,
          ),
        );
      }
    };
    child.stdout.on("data", capture("stdout"));
    child.stderr.on("data", capture("stderr"));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        errorWithLogs(
          `Runtime worker timed out after ${limits.timeoutMs}ms; increase boot.timeoutMs if this boot is expected`,
          stdout,
          stderr,
        ),
      );
    }, limits.timeoutMs);
    timer.unref();

    child.on("message", (message) => {
      if (!message || settled) return;
      if (message.type === "result") {
        const bytes = Buffer.byteLength(JSON.stringify(message.value));
        if (bytes > limits.maxOutputBytes) {
          child.kill("SIGKILL");
          finish(
            new Error(
              `Runtime registry exceeded boot.maxOutputBytes (${limits.maxOutputBytes} bytes)`,
            ),
          );
          return;
        }
        finish(null, message.value);
      } else if (message.type === "error") {
        finish(errorWithLogs(message.message, stdout, stderr));
      }
    });

    child.on("error", (err) =>
      finish(errorWithLogs(`Runtime worker failed: ${err.message}`, stdout, stderr)),
    );
    child.on("exit", (code, signal) => {
      if (settled) return;
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      finish(
        errorWithLogs(
          `Runtime worker exited before producing a route registry (${reason})`,
          stdout,
          stderr,
        ),
      );
    });

    child.send({
      appPath: resolved,
      boot: {
        sandbox: boot.sandbox,
        stubModules: boot.stubModules,
        maxOutputBytes: limits.maxOutputBytes,
        settleMs: limits.settleMs,
      },
    });
  });
}

module.exports = {
  executeRuntime,
  runtimeLimits,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_SETTLE_MS,
};
