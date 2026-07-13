"use strict";

const Module = require("node:module");
const net = require("node:net");
const path = require("node:path");

const INSPECT = Symbol.for("nodejs.util.inspect.custom");
const INSTALLED = Symbol.for("express-recon.sandbox");

/**
 * Infra clients commonly constructed (and connected) at app import time.
 * Stubbing them lets runtime/hybrid mode boot an app with no database, broker,
 * or cache reachable — the route wiring itself never needs them.
 */
const DEFAULT_STUB_MODULES = [
  "pg",
  "pg-pool",
  "mysql",
  "mysql2",
  "ioredis",
  "redis",
  "mongoose",
  "mongodb",
  "kafkajs",
  "amqplib",
  "amqp-connection-manager",
  "@prisma/client",
  "knex",
  "sequelize",
  "typeorm",
  "bullmq",
  "bull",
  "nodemailer",
  "@elastic/elasticsearch",
  "cassandra-driver",
  "@grpc/grpc-js",
  "nats",
  "memcached",
];

const DEFAULT_STUB_PREFIXES = ["@aws-sdk/"];

/**
 * An inert stand-in for an infra client: every property access, call, and
 * `new` yields another stub, so arbitrary client code chains without throwing.
 *
 * Awaiting works too: `then` behaves like a resolved promise whose value is a
 * NON-thenable stub — a stub that resolved to itself would send promise
 * adoption into an infinite microtask loop. `onFulfilled` really runs, so an
 * app that registers routes inside `connect().then(...)` still wires them.
 * Function arguments are never invoked (calling app callbacks with stub inputs
 * could run arbitrary logic), and nothing ever rejects — `.catch` teardown
 * like `process.exit(1)` stays inert.
 *
 * @param {string} name  dotted provenance, shown by util.inspect/String().
 * @param {{thenable?: boolean}} [opts]
 * @returns {Function} callable/constructable Proxy
 */
function makeStub(name, opts = {}) {
  const thenable = opts.thenable !== false;
  const children = new Map();
  const target = function reconStub() {};
  // util.inspect reads the target directly (proxy get traps are bypassed to
  // avoid side effects), so the custom-inspect fn must be an own property.
  target[INSPECT] = () => `[express-recon stub: ${name}]`;
  const settle = (onSettled) =>
    Promise.resolve().then(() => {
      const settled = makeStub(name, { thenable: false });
      return onSettled ? onSettled(settled) : settled;
    });
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === "symbol") {
        if (prop === INSPECT) return t[INSPECT];
        return undefined;
      }
      if (thenable && prop === "then") return (onFulfilled) => settle(onFulfilled);
      // `.catch`/`.finally` directly on a pending stub must behave like the
      // promise they mimic: catch never fires (stubs don't reject), finally's
      // callback (which takes no arguments) does run.
      if (thenable && prop === "catch") return () => settle();
      if (thenable && prop === "finally")
        return (fn) =>
          settle((settled) => {
            if (typeof fn === "function") fn();
            return settled;
          });
      // Settled stubs must NOT be thenable — a callable child stub here would
      // make promise adoption hang forever on a `then` that never resolves.
      if (prop === "then") return undefined;
      if (prop === "toString" || prop === "valueOf") return () => `[express-recon stub: ${name}]`;
      if (prop === "toJSON") return () => null;
      // Proxy invariant: `prototype` is a non-configurable own prop on a
      // function target, so the trap must not replace it with a stub.
      if (prop === "prototype") return t.prototype;
      if (!children.has(prop)) children.set(prop, makeStub(`${name}.${prop}`));
      return children.get(prop);
    },
    apply() {
      return makeStub(`${name}()`);
    },
    construct() {
      return makeStub(`new ${name}()`);
    },
    has(t, prop) {
      return typeof prop === "string";
    },
  });
}

/** "mysql2/promise" → "mysql2"; "@scope/pkg/sub" → "@scope/pkg". */
function packageRoot(request) {
  const parts = request.split("/");
  return request.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function shouldStub(request, exact, prefixes) {
  if (request.startsWith(".") || path.isAbsolute(request)) return false;
  if (request.startsWith("node:")) return false;
  if (prefixes.some((p) => request.startsWith(p))) return true;
  return exact.has(packageRoot(request));
}

/**
 * Install the boot sandbox for runtime/hybrid app loading:
 *
 * - `Module._load` returns a stub for any listed infra package (matched on the
 *   package root, so deep imports like `mysql2/promise` count) BEFORE module
 *   resolution — the package doesn't have to be installed. Relative, absolute,
 *   and `node:` specifiers always pass through; `express` must never be listed
 *   (instrumentation depends on the real one).
 * - `net.Server.prototype.listen` never binds: the callback still fires (via a
 *   fake async 'listening') so post-listen wiring runs, but no port opens and
 *   no handle keeps the CLI's event loop alive.
 * - `process.exit` records and ignores — `connect().catch(() => process.exit(1))`
 *   must not kill the recon process.
 *
 * Returns `{ uninstall, diagnostics }`. Callers MUST uninstall before any code
 * path that needs the real `process.exit` (the CLI's `die()`).
 *
 * @param {{stubModules?: string[]}} [opts]  extra packages to stub; an entry
 *   ending in "/" is treated as a prefix (e.g. "@google-cloud/").
 */
function installSandbox(opts = {}) {
  if (globalThis[INSTALLED]) return globalThis[INSTALLED];
  const exact = new Set(DEFAULT_STUB_MODULES);
  const prefixes = DEFAULT_STUB_PREFIXES.slice();
  for (const entry of opts.stubModules || []) {
    if (entry.endsWith("/")) prefixes.push(entry);
    else exact.add(entry);
  }

  const state = { stubbed: new Set(), listens: 0, exitCalls: [] };
  const stubCache = new Map();

  const origLoad = Module._load;
  Module._load = function sandboxedLoad(request, parent, isMain) {
    if (shouldStub(request, exact, prefixes)) {
      state.stubbed.add(packageRoot(request));
      if (!stubCache.has(request)) stubCache.set(request, makeStub(request));
      return stubCache.get(request);
    }
    return origLoad.call(this, request, parent, isMain);
  };

  const origListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function neutralizedListen(...args) {
    state.listens += 1;
    const cb = args.find((a) => typeof a === "function");
    if (cb) this.once("listening", cb);
    this.address = () => ({ address: "127.0.0.1", family: "IPv4", port: 0 });
    setImmediate(() => this.emit("listening"));
    return this;
  };

  const origExit = process.exit;
  process.exit = function neutralizedExit(code) {
    state.exitCalls.push(code === undefined ? 0 : code);
  };

  const handle = {
    uninstall() {
      Module._load = origLoad;
      net.Server.prototype.listen = origListen;
      process.exit = origExit;
      delete globalThis[INSTALLED];
    },
    diagnostics() {
      const out = [];
      if (state.stubbed.size > 0)
        out.push(`boot: sandbox stubbed infra modules: ${[...state.stubbed].sort().join(", ")}`);
      if (state.listens > 0)
        out.push(`boot: neutralized ${state.listens} listen() call(s) — no port was bound`);
      if (state.exitCalls.length > 0)
        out.push(
          `boot: app called process.exit(${state.exitCalls.join(", ")}) during boot — ignored`,
        );
      return out;
    },
  };
  globalThis[INSTALLED] = handle;
  return handle;
}

module.exports = { installSandbox, makeStub, DEFAULT_STUB_MODULES };
