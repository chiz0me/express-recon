"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { analyzeFile } = require("./analyze-file");
const { extractIoHints } = require("./io-hints");
const { loadTsconfig, loadImports, createResolver, EXTENSIONS } = require("./resolve");
const { joinPath, scopedTo } = require("../walk");

const SOURCE_EXT = new Set(EXTENSIONS);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "out"]);
const TEST_DIRS = new Set([
  "test",
  "tests",
  "testcases",
  "spec",
  "specs",
  "__tests__",
  "__mocks__",
]);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const DEFAULT_IGNORE_FILE = ".express-reconignore";

function stringPatterns(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty glob strings`);
  }
  return value.map((item) => item.trim());
}

function escapeRegex(char) {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

/**
 * Compile a root-relative path glob. `*` and `?` stay inside one segment;
 * `**` crosses directories; a double-star path segment may match zero or more
 * directories.
 */
function pathGlob(pattern) {
  let normalized = pattern.replaceAll("\\", "/").replace(/^\.?\//, "");
  if (normalized.endsWith("/")) normalized += "**";
  let source = "^";
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] === "*" && normalized[i + 1] === "*") {
      if (normalized[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i++;
      }
    } else if (normalized[i] === "*") {
      source += "[^/]*";
    } else if (normalized[i] === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(normalized[i]);
    }
  }
  return new RegExp(`${source}$`);
}

function readIgnoreRules(root, ignoreFile) {
  if (ignoreFile === false) return [];
  if (ignoreFile !== undefined && typeof ignoreFile !== "string") {
    throw new Error("scan.ignoreFile must be a path string or false");
  }
  const file = path.resolve(root, ignoreFile || DEFAULT_IGNORE_FILE);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT" && ignoreFile === undefined) return [];
    throw new Error(`Could not read scan ignore file ${file}: ${err.message}`);
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => ({
      include: line.startsWith("!"),
      pattern: pathGlob(line.startsWith("!") ? line.slice(1) : line),
    }));
}

function scanScope(root, opts) {
  const include = stringPatterns(opts.include, "scan.include").map(pathGlob);
  const exclude = stringPatterns(opts.exclude, "scan.exclude").map(pathGlob);
  const ignoreRules = readIgnoreRules(root, opts.ignoreFile);
  return (file) => {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (include.length && !include.some((pattern) => pattern.test(relative))) return false;
    if (exclude.some((pattern) => pattern.test(relative))) return false;
    let ignored = false;
    for (const rule of ignoreRules) {
      if (rule.pattern.test(relative)) ignored = !rule.include;
    }
    return !ignored;
  };
}

/**
 * Recursively collect source files under `dir`, skipping vendored/build dirs.
 * Test files are excluded by default — apps built inside tests/fixtures would
 * otherwise pollute the inventory with routes that never ship.
 */
function listSourceFiles(dir, opts = {}) {
  const includeTests = Boolean(opts.includeTests);
  const inScope = scanScope(path.resolve(dir), opts);
  const onTraversalError =
    typeof opts.onTraversalError === "function" ? opts.onTraversalError : () => {};
  const found = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      onTraversalError(current, err);
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        if (!includeTests && TEST_DIRS.has(entry.name)) continue;
        stack.push(full);
      } else if (SOURCE_EXT.has(path.extname(entry.name))) {
        if (!includeTests && TEST_FILE.test(entry.name)) continue;
        if (inScope(full)) found.push(full);
      }
    }
  }
  return found;
}

/**
 * Resolve a module export to a concrete router var `{kind: "router", file, var}`
 * or, partway through a barrel, an `{kind: "object", file, props}` to index
 * further. Sees through factory exports and object literals, follows `module`
 * refs across files (and `export *` barrels), and applies a pending property
 * path. Returns null when the chain dead-ends or leaves the analyzed source.
 */
function resolveExport(file, exportName, props, byPath, resolve, seen) {
  const key = `${file.filePath}#${exportName}#${props.join(".")}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const ref = file.exportRefs.get(exportName);
  if (ref) return resolveRefValue(file, ref, props, byPath, resolve, seen);
  // A property of the module's default value (CommonJS object export), or an
  // `export *` barrel that re-exports the name.
  if (exportName !== "default" && file.exportRefs.has("default")) {
    const found = resolveExport(file, "default", [exportName, ...props], byPath, resolve, seen);
    if (found) return found;
  }
  for (const source of file.reExportAll) {
    const target = resolve(file.filePath, source);
    const tf = target && byPath.get(target);
    const found = tf && resolveExport(tf, exportName, props, byPath, resolve, seen);
    if (found) return found;
  }
  return null;
}

function resolveRefValue(file, ref, props, byPath, resolve, seen) {
  switch (ref.t) {
    case "factory":
      return resolveRefValue(file, ref.ret, props, byPath, resolve, seen);
    case "local":
      // Only a genuine router/app var is a mountable router. `module.exports =
      // redisClient` / a config object is a local export but not a router.
      if (props.length !== 0 || !file.routers.has(ref.name)) return null;
      return { kind: "router", file: file.filePath, var: ref.name };
    case "object": {
      if (props.length === 0) return { kind: "object", file: file.filePath, props: ref.props };
      const next = ref.props.get(props[0]);
      return next ? resolveRefValue(file, next, props.slice(1), byPath, resolve, seen) : null;
    }
    case "module": {
      const target = resolve(file.filePath, ref.source);
      const tf = target && byPath.get(target);
      if (!tf) return null;
      return resolveExport(tf, ref.exportName, ref.props.concat(props), byPath, resolve, seen);
    }
    default:
      return null;
  }
}

/** Map an export ref (+ pending property path) to a same-file handler function. */
function refToFn(tf, ref, props) {
  if (!ref) return null;
  if (ref.t === "factory") return refToFn(tf, ref.ret, props);
  if (ref.t === "local") return props.length === 0 ? tf.handlerIndex.get(ref.name) || null : null;
  if (ref.t === "object")
    return props.length === 0 ? null : refToFn(tf, ref.props.get(props[0]), props.slice(1));
  // ref.t === "module" would be a second cross-file hop — capped at one.
  return null;
}

/** Resolve an exported name (honoring the CommonJS default-object form) to a fn node. */
function exportedFnNode(tf, exportName, props) {
  const direct = refToFn(tf, tf.exportRefs.get(exportName), props);
  if (direct) return direct;
  if (exportName !== "default" && tf.exportRefs.has("default"))
    return refToFn(tf, tf.exportRefs.get("default"), [exportName, ...props]);
  return null;
}

/**
 * One-hop cross-file handler resolution: for routes whose handler is a
 * first-party imported controller (`.get('/x', controllers.getUser)`), follow
 * the import to the target file, mine the controller's I/O hints, and fold them
 * back onto `route.io`. Degrades silently for external/unresolved handlers. Runs
 * before `buildGraph` so the mutated `io` propagates through its `{...route}` copy.
 */
function resolveImportedHandlers(files, resolve) {
  const byPath = new Map(files.map((f) => [f.filePath, f]));
  for (const file of files) {
    for (const route of [...file.routes, ...file.registrarRoutes]) {
      const ref = route.__handlerRef;
      if (ref && route.io && !route.io.handlerResolved) {
        const target = resolve(file.filePath, ref.source);
        const tf = target && byPath.get(target);
        const fn = tf && exportedFnNode(tf, ref.exportName, ref.props);
        if (fn) {
          const hints = extractIoHints(fn);
          route.io.request = hints.request;
          route.io.responses = hints.responses;
          route.io.statusCodes = hints.statusCodes;
          route.io.handlerResolved = true;
          route.io.handlerSource = { file: tf.filePath, line: tf.lineAt(fn.start) };
        }
      }
      delete route.__handlerRef;
    }
  }
}

/** Build the cross-file router graph from analyzed file models. */
function buildGraph(files, resolve) {
  const byPath = new Map(files.map((f) => [f.filePath, f]));
  const nodes = new Map();
  const stats = { dropped: 0 };
  const ensure = (id, kind) => {
    if (!nodes.has(id)) nodes.set(id, { id, kind, routes: [], globalMw: [], edges: [] });
    return nodes.get(id);
  };

  // A local identifier used as `name.get(...)` / mount host: a router/app var,
  // or a require binding that resolves to a router in another file.
  const resolveLocal = (file, name) => {
    if (file.routers.has(name))
      return ensure(`${file.filePath}#${name}`, file.routers.get(name).kind);
    const b = file.requires.get(name);
    if (b) {
      const target = resolve(file.filePath, b.source);
      const tf = target && byPath.get(target);
      const found = tf && resolveExport(tf, b.exportName, b.props, byPath, resolve, new Set());
      if (found && found.kind === "router") return ensure(`${found.file}#${found.var}`, "router");
      return ensure(`external:${b.source}`, "external");
    }
    return ensure(`${file.filePath}#${name}`, "unknown");
  };

  // A mount target (sub-router), possibly a property of a barrel module.
  const resolveRef = (file, ref) => {
    if (ref.t === "local") return resolveLocal(file, ref.name);
    if (ref.t === "module") {
      const target = resolve(file.filePath, ref.source);
      const tf = target && byPath.get(target);
      const found = tf && resolveExport(tf, ref.exportName, ref.props, byPath, resolve, new Set());
      if (found && found.kind === "router") return ensure(`${found.file}#${found.var}`, "router");
      return ensure(`external:${ref.source}`, "external");
    }
    return ensure(`unknown:${file.filePath}`, "unknown");
  };

  const isRouteHost = (node) => node.kind === "app" || node.kind === "router";

  for (const file of files) {
    for (const route of file.routes) {
      const node = resolveLocal(file, route.host);
      if (isRouteHost(node)) node.routes.push({ ...route, file: file.filePath });
      else stats.dropped++;
    }
    for (const [host, mws] of file.globalMwByHost) {
      resolveLocal(file, host).globalMw.push(...mws.map((e) => ({ ...e, file: file.filePath })));
    }
    for (const edge of file.edges) {
      const target = resolveRef(file, edge.targetRef);
      const hostNode = resolveLocal(file, edge.host);
      if (isRouteHost(target)) {
        hostNode.edges.push({
          mountPath: edge.mountPath,
          partial: Boolean(edge.partial),
          targetId: target.id,
          edgeMw: edge.edgeMw.map((e) => ({ ...e, file: file.filePath })),
          line: edge.line,
          file: file.filePath,
        });
      } else {
        // Not a router after all — a locally-required middleware (e.g. an auth
        // guard) used in `.use()`. Keep it in the chain instead of dropping it.
        hostNode.globalMw.push(
          { ...edge.fallbackMw, file: file.filePath },
          ...edge.edgeMw.map((e) => ({ ...e, file: file.filePath })),
        );
      }
    }
  }
  return { nodes, stats };
}

/**
 * Does a `use()`-attached middleware apply to a route/edge registered on the
 * same host? Express only runs middleware over registrations that come after
 * it, so within one file the `use()` line must not exceed the target's line.
 * Cross-file attachments (a router `use()`d from another module) keep the
 * conservative include-always behavior.
 */
function appliesInOrder(entry, item) {
  if (entry.file == null || entry.line == null || item.file == null || item.line == null)
    return true;
  if (entry.file !== item.file) return true;
  return entry.line <= item.line;
}

function emitRoute(route, prefix, accMw, partial, out) {
  const dynamic = route.path === null;
  const full = dynamic ? joinPath(prefix, "<dynamic>") : joinPath(prefix, route.path);
  const chain = accMw.filter((e) => scopedTo(full, e.scopeAbs)).map((e) => e.mw);
  out.push({
    method: route.method,
    path: full,
    middlewares: chain.concat(route.middlewares),
    source: { file: route.file, line: route.line },
    pathConfidence: partial || dynamic ? "partial" : "full",
    ...(route.io ? { io: route.io } : {}),
  });
}

/** Absolute guard scope of a `use(path, mw)` entry attached under `prefix`. */
function absScope(prefix, scope) {
  if (scope == null || scope === "" || scope === "/") return null;
  // Wildcard patterns (`*`, `/api/*`) are not literal prefixes; treat them as
  // host-wide rather than dropping the guard from every chain.
  if (scope.includes("*")) return null;
  return joinPath(prefix, scope);
}

/** Depth-first walk of the router graph from a root, emitting fully-pathed routes. */
function traverse(nodes, nodeId, prefix, inherited, partial, stack, ctx) {
  const node = nodes.get(nodeId);
  if (!node) return;
  ctx.visited.add(nodeId);
  const own = node.globalMw.map((e) => ({ ...e, scopeAbs: absScope(prefix, e.scope) }));
  for (const route of node.routes) {
    const accMw = inherited.concat(own.filter((e) => appliesInOrder(e, route)));
    emitRoute(route, prefix, accMw, partial, ctx.out);
  }
  for (const edge of node.edges) {
    if (stack.has(edge.targetId)) continue;
    const childPrefix = edge.mountPath === null ? prefix : joinPath(prefix, edge.mountPath);
    const forChild = inherited
      .concat(own.filter((e) => appliesInOrder(e, edge)))
      .concat(edge.edgeMw.map((e) => ({ ...e, scopeAbs: null })));
    const nextStack = new Set(stack).add(edge.targetId);
    traverse(nodes, edge.targetId, childPrefix, forChild, partial || edge.partial, nextStack, ctx);
  }
}

function dedupeKey(r) {
  return `${r.method} ${r.path} @ ${r.source.file}:${r.source.line}`;
}

/**
 * Flag when static resolution likely under- or over-counted routes, so a
 * confident-looking report can't hide a collapsed mount graph.
 */
function diagnose({ appNodes, reachable, orphan, dropped }) {
  const out = [];
  if (appNodes > 0 && reachable === 0 && orphan + dropped > 0) {
    out.push(
      "No routes were reachable from any Express app: the app→router mount graph " +
        "could not be resolved statically, so route paths and auth status are unreliable. " +
        "This is common with dependency-injection/factory router patterns or dynamic mounts. " +
        "Re-run with --mode hybrid --app <entry> to recover the real routes.",
    );
  }
  if (dropped > 0) {
    out.push(
      `Ignored ${dropped} HTTP-verb call(s) on non-router objects (e.g. HTTP clients or ` +
        "ORM query builders) that are not Express route registrations.",
    );
  }
  if (reachable > 0 && orphan > 0) {
    out.push(
      `${orphan} route(s) belong to routers never mounted on an app and were emitted ` +
        "with an unknown path prefix.",
    );
  }
  return out;
}

/**
 * Statically scan a repo for Express routes without executing any code.
 *
 * @param {string} rootDir  directory to scan
 * @param {{includeTests?: boolean, include?: string[], exclude?: string[], ignoreFile?: string|false}} [opts]
 * @returns {{routes: object[], globalMiddleware: object[], diagnostics: string[]}}
 */
function scan(rootDir, opts = {}) {
  // Absolute so file ids match the resolver's absolute mount targets — a
  // relative rootDir would otherwise orphan every cross-file mount.
  const root = path.resolve(rootDir);
  const diagnostics = [];
  let failed = 0;
  const filePaths = listSourceFiles(root, {
    ...opts,
    onTraversalError(current, err) {
      failed++;
      diagnostics.push(
        `scan: could not read directory ${current}: ${err && err.message ? err.message : String(err)}`,
      );
    },
  });
  const files = [];
  for (const file of filePaths) {
    let code;
    try {
      code = fs.readFileSync(file, "utf8");
    } catch (err) {
      failed++;
      diagnostics.push(`scan: could not read source file ${file}: ${err.message}`);
      continue;
    }
    const model = analyzeFile(code, file, (message) => {
      diagnostics.push(`scan: could not parse ${file}: ${message}`);
    });
    if (model) files.push(model);
    else failed++;
  }
  const scanCoverage = {
    discovered: filePaths.length,
    analyzed: files.length,
    failed,
    complete: failed === 0,
  };
  const resolve = createResolver(loadTsconfig(root), loadImports(root));
  resolveImportedHandlers(files, resolve);
  const { nodes, stats } = buildGraph(files, resolve);

  const ctx = { out: [], visited: new Set() };
  let appNodes = 0;
  for (const node of nodes.values()) {
    if (node.kind !== "app") continue;
    appNodes++;
    traverse(nodes, node.id, "", [], false, new Set([node.id]), ctx);
  }
  const reachable = ctx.out.length;
  // Routers never reached from an app: emit with unknown mount prefix so an
  // audit never silently drops a route. Scope filtering is skipped — the true
  // prefix is unknown, so a scoped guard can't be disproven.
  for (const node of nodes.values()) {
    if (ctx.visited.has(node.id) || node.routes.length === 0 || node.kind !== "router") continue;
    for (const route of node.routes) {
      const accMw = node.globalMw
        .filter((e) => appliesInOrder(e, route))
        .map((e) => ({ ...e, scopeAbs: null }));
      emitRoute(route, "", accMw, true, ctx.out);
    }
  }
  const orphan = ctx.out.length - reachable;

  // Registrar-pattern routes (registered on a function parameter): host and
  // prefix unknown, so they surface as partial orphans with a diagnostic.
  const registrarHosts = new Map();
  for (const file of files) {
    for (const route of file.registrarRoutes) {
      emitRoute({ ...route, file: file.filePath }, "", [], true, ctx.out);
      const key = `'${route.host}' in ${file.filePath}`;
      registrarHosts.set(key, (registrarHosts.get(key) || 0) + 1);
    }
  }
  const out = ctx.out;

  const seen = new Set();
  const routes = out.filter((r) => !seen.has(dedupeKey(r)) && seen.add(dedupeKey(r)));
  const globalMiddleware = [];
  for (const node of nodes.values())
    if (node.kind === "app") globalMiddleware.push(...node.globalMw.map((e) => e.mw));
  diagnostics.push(...diagnose({ appNodes, reachable, orphan, dropped: stats.dropped }));
  for (const [host, count] of registrarHosts) {
    diagnostics.push(
      `${count} route(s) registered on unresolved host ${host} — likely a registrar ` +
        "function invoked elsewhere; mount prefixes are unknown. " +
        "Re-run with --mode hybrid --app <entry> to recover them.",
    );
  }
  return { routes, globalMiddleware, diagnostics, scanCoverage };
}

module.exports = { scan, listSourceFiles, buildGraph };
