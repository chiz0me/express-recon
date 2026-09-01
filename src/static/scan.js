"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { analyzeFile } = require("./analyze-file");
const { STATIC_FRAMEWORK_ADAPTERS } = require("./adapters");
const { extractIoHints } = require("./io-hints");
const { createScopedResolver, EXTENSIONS } = require("./resolve");
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
const DECLARATION_FILE = /\.d\.(?:ts|mts|cts)$/;
const DEFAULT_IGNORE_FILE = ".express-reconignore";
const DEFAULT_MAX_FILES = 50_000;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 250 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

function boundedInteger(value, label, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function scanLimits(opts = {}) {
  return {
    maxFiles: boundedInteger(opts.maxFiles, "scan.maxFiles", DEFAULT_MAX_FILES, 1, 1_000_000),
    maxFileBytes: boundedInteger(
      opts.maxFileBytes,
      "scan.maxFileBytes",
      DEFAULT_MAX_FILE_BYTES,
      1024,
      100 * 1024 * 1024,
    ),
    maxTotalBytes: boundedInteger(
      opts.maxTotalBytes,
      "scan.maxTotalBytes",
      DEFAULT_MAX_TOTAL_BYTES,
      1024,
      5 * 1024 * 1024 * 1024,
    ),
    timeoutMs: boundedInteger(opts.timeoutMs, "scan.timeoutMs", DEFAULT_TIMEOUT_MS, 100, 600_000),
  };
}

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
function normalizeGlob(pattern) {
  return pattern.replaceAll("\\", "/").replace(/^\.?\//, "");
}

function canonicalGlob(pattern) {
  const normalized = normalizeGlob(pattern);
  return normalized.endsWith("/") ? `${normalized}**` : normalized;
}

function pathGlob(pattern) {
  const normalized = canonicalGlob(pattern);
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

function portableIgnorePath(root, file) {
  const relative = path.relative(root, file);
  const external =
    path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`);
  return {
    path: external
      ? `<external>/${path.basename(file)}`
      : (relative || path.basename(file)).split(path.sep).join("/"),
    external,
  };
}

function readIgnoreRules(root, ignoreFile) {
  if (ignoreFile === false) {
    return {
      rules: [],
      semanticRules: [],
      evidence: {
        enabled: false,
        path: null,
        external: false,
        found: false,
        rules: 0,
        sha256: null,
      },
    };
  }
  if (ignoreFile !== undefined && typeof ignoreFile !== "string") {
    throw new Error("scan.ignoreFile must be a path string or false");
  }
  const file = path.resolve(root, ignoreFile || DEFAULT_IGNORE_FILE);
  const location = portableIgnorePath(root, file);
  const evidence = {
    enabled: true,
    ...location,
    found: false,
    rules: 0,
    sha256: null,
  };
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT" && ignoreFile === undefined) {
      return { rules: [], semanticRules: [], evidence };
    }
    throw new Error(`Could not read scan ignore file ${file}: ${err.message}`);
  }
  const rules = [];
  const semanticRules = [];
  for (const [index, sourceLine] of text.split(/\r?\n/).entries()) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const include = line.startsWith("!");
    const pattern = include ? line.slice(1).trim() : line;
    if (!pattern) {
      throw new Error(
        `Invalid scan ignore rule at ${file}:${index + 1}: re-inclusion requires a pattern`,
      );
    }
    rules.push({ include, pattern: pathGlob(pattern) });
    semanticRules.push(`${include ? "!" : ""}${canonicalGlob(pattern)}`);
  }
  return {
    rules,
    semanticRules,
    evidence: {
      ...evidence,
      found: true,
      rules: rules.length,
      sha256: crypto.createHash("sha256").update(text).digest("hex"),
    },
  };
}

function createScanScope(root, opts = {}) {
  root = path.resolve(root);
  const includePatterns = stringPatterns(opts.include, "scan.include").map(normalizeGlob);
  const excludePatterns = stringPatterns(opts.exclude, "scan.exclude").map(normalizeGlob);
  const include = includePatterns.map(pathGlob);
  const exclude = excludePatterns.map(pathGlob);
  const ignore = readIgnoreRules(root, opts.ignoreFile);
  const evidence = {
    include: includePatterns,
    exclude: excludePatterns,
    includeTests: Boolean(opts.includeTests),
    ignoreFile: ignore.evidence,
    builtIn: {
      excludedDirectories: [...SKIP_DIRS].sort(),
      hiddenDirectoriesExcluded: !opts.includeHidden,
    },
  };
  evidence.fingerprint = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        include: [...new Set(evidence.include.map(canonicalGlob))].sort(),
        exclude: [...new Set(evidence.exclude.map(canonicalGlob))].sort(),
        includeTests: evidence.includeTests,
        ignoreRules: ignore.semanticRules,
        builtIn: evidence.builtIn,
      }),
    )
    .digest("hex");
  return {
    evidence,
    matches(file) {
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (include.length && !include.some((pattern) => pattern.test(relative))) return false;
      if (exclude.some((pattern) => pattern.test(relative))) return false;
      let ignored = false;
      for (const rule of ignore.rules) {
        if (rule.pattern.test(relative)) ignored = !rule.include;
      }
      return !ignored;
    },
  };
}

/**
 * Recursively collect source files under `dir`, skipping vendored/build dirs.
 * Test files are excluded by default — apps built inside tests/fixtures would
 * otherwise pollute the inventory with routes that never ship.
 */
function listSourceFiles(dir, opts = {}) {
  const includeTests = Boolean(opts.includeTests);
  const scope = createScanScope(path.resolve(dir), opts);
  if (typeof opts.onScope === "function") opts.onScope(scope.evidence);
  const onTraversalError =
    typeof opts.onTraversalError === "function" ? opts.onTraversalError : () => {};
  const onLimit = typeof opts.onLimit === "function" ? opts.onLimit : () => {};
  const onTimeout = typeof opts.onTimeout === "function" ? opts.onTimeout : () => {};
  const maxFiles = opts.maxFiles === undefined ? Number.POSITIVE_INFINITY : opts.maxFiles;
  const deadline = Number.isFinite(opts.deadline)
    ? opts.deadline
    : Number.isFinite(opts.timeoutMs)
      ? Date.now() + opts.timeoutMs
      : Number.POSITIVE_INFINITY;
  const found = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    if (Date.now() >= deadline) {
      onTimeout(current);
      return found.sort();
    }
    let entries;
    try {
      entries = fs
        .readdirSync(current, { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch (err) {
      onTraversalError(current, err);
      continue;
    }
    for (const entry of entries) {
      if (Date.now() >= deadline) {
        onTimeout(current);
        return found.sort();
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || (!opts.includeHidden && entry.name.startsWith("."))) {
          continue;
        }
        if (!includeTests && TEST_DIRS.has(entry.name)) continue;
        stack.push(full);
      } else if (SOURCE_EXT.has(path.extname(entry.name))) {
        // Declaration files describe types, not executable registrations. Some
        // real-world ambient declarations intentionally use syntax that a
        // runtime-oriented parser rejects; they must not make route coverage
        // incomplete or consume the source budget.
        if (DECLARATION_FILE.test(entry.name)) continue;
        if (!includeTests && TEST_FILE.test(entry.name)) continue;
        if (scope.matches(full)) {
          if (found.length >= maxFiles) {
            onLimit(full);
            return found.sort();
          }
          found.push(full);
        }
      }
    }
  }
  return found.sort();
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
          const hints = extractIoHints(fn, {
            file: tf.filePath,
            lineAt: tf.lineAt,
            bindings: tf.valueBindings,
            consts: tf.consts,
            requires: tf.requires,
          });
          route.io.request = hints.request;
          route.io.responses = hints.responses;
          route.io.statusCodes = hints.statusCodes;
          if (hints.schemas) route.io.schemas = hints.schemas;
          route.io.handlerResolved = true;
          route.io.handlerSource = { file: tf.filePath, line: tf.lineAt(fn.start) };
        }
      }
      delete route.__handlerRef;
    }
  }
}

function registrarFromRefValue(file, ref, props, byPath, resolve, seen) {
  if (!ref) return null;
  if (ref.t === "factory") {
    return props.length === 0 ? file.registrars.get(ref.fnStart) || null : null;
  }
  if (ref.t === "local") {
    if (props.length) return null;
    const fn = file.handlerIndex.get(ref.name);
    return fn ? file.registrars.get(fn.start) || null : null;
  }
  if (ref.t === "object") {
    if (!props.length) return null;
    return registrarFromRefValue(
      file,
      ref.props.get(props[0]),
      props.slice(1),
      byPath,
      resolve,
      seen,
    );
  }
  if (ref.t === "module") {
    const target = resolve(file.filePath, ref.source);
    const targetFile = target && byPath.get(target);
    if (!targetFile) return null;
    return resolveRegistrarExport(
      targetFile,
      ref.exportName,
      [...(ref.props || []), ...props],
      byPath,
      resolve,
      seen,
    );
  }
  return null;
}

function resolveRegistrarExport(file, exportName, props, byPath, resolve, seen = new Set()) {
  const key = `${file.filePath}#registrar:${exportName}#${props.join(".")}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const direct = file.exportRefs.get(exportName);
  if (direct) return registrarFromRefValue(file, direct, props, byPath, resolve, seen);
  if (exportName !== "default" && file.exportRefs.has("default")) {
    const found = resolveRegistrarExport(
      file,
      "default",
      [exportName, ...props],
      byPath,
      resolve,
      seen,
    );
    if (found) return found;
  }
  for (const source of file.reExportAll) {
    const target = resolve(file.filePath, source);
    const targetFile = target && byPath.get(target);
    const found =
      targetFile && resolveRegistrarExport(targetFile, exportName, props, byPath, resolve, seen);
    if (found) return found;
  }
  return null;
}

/** Build the cross-file router graph from analyzed file models. */
function buildGraph(files, resolve) {
  const byPath = new Map(files.map((f) => [f.filePath, f]));
  const nodes = new Map();
  const stats = {
    dropped: 0,
    attachedRegistrars: new Set(),
    attachedRegistrarSites: new Set(),
  };
  const ensure = (id, kind, metadata = {}) => {
    if (!nodes.has(id)) {
      nodes.set(id, { id, kind, routes: [], globalMw: [], edges: [], opaqueUses: [], ...metadata });
    }
    return nodes.get(id);
  };

  // A local identifier used as `name.get(...)` / mount host: a router/app var,
  // or a require binding that resolves to a router in another file.
  const resolveLocal = (file, name) => {
    if (file.routers.has(name)) {
      const router = file.routers.get(name);
      return ensure(`${file.filePath}#${name}`, router.kind, {
        file: file.filePath,
        var: name,
        line: file.lineAt(router.start),
      });
    }
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

  // Seed every declared app/router before processing registrations. Without
  // this pass an Express app that only calls `listen()` (or temporarily has no
  // routes) disappears because no route/use edge ever asks the graph for it.
  for (const file of files) {
    for (const name of file.routers.keys()) resolveLocal(file, name);
  }

  for (const file of files) {
    for (const route of file.routes) {
      const node = resolveLocal(file, route.host);
      if (isRouteHost(node)) node.routes.push({ ...route, file: file.filePath });
      else stats.dropped++;
    }
    for (const [host, mws] of file.globalMwByHost) {
      resolveLocal(file, host).globalMw.push(...mws.map((e) => ({ ...e, file: file.filePath })));
    }
    for (const use of file.opaqueUses || []) {
      resolveLocal(file, use.host).opaqueUses.push({ ...use, file: file.filePath });
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
    for (const invocation of file.registrarInvocations || []) {
      const registrar = registrarFromRefValue(
        file,
        invocation.registrarRef,
        [],
        byPath,
        resolve,
        new Set(),
      );
      if (!registrar) continue;
      const host = resolveLocal(file, invocation.host);
      if (!isRouteHost(host)) continue;
      for (const route of registrar.routes) {
        host.routes.push({ ...route, file: registrar.file });
        stats.attachedRegistrars.add(`${registrar.file}\0${route.registrarStart}`);
        stats.attachedRegistrarSites.add(`${registrar.file}\0${route.line || 0}\0${route.method}`);
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
    framework: "express",
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
  for (const use of node.opaqueUses || []) {
    ctx.opaqueUses?.push({
      path:
        use.pathConfidence === "unknown" || use.mountPath === null
          ? null
          : joinPath(prefix, use.mountPath),
      pathConfidence: use.pathConfidence,
      middlewares: use.middlewares,
      source: { file: use.file, line: use.line },
    });
  }
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
  return `${r.applicationId || "<unresolved>"}\0${r.method} ${r.path} @ ${r.source.file}:${r.source.line}`;
}

function applicationId(root, node) {
  const relative = path.relative(root, node.file).split(path.sep).join("/");
  return `app:${relative}#${node.var}`;
}

/**
 * Flag when static resolution likely under- or over-counted routes, so a
 * confident-looking report can't hide a collapsed mount graph.
 */
function diagnose({ appNodes, reachable, orphan, dropped, opaqueMounts }) {
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
  if (opaqueMounts > 0) {
    out.push(
      `${opaqueMounts} opaque route-provider registration(s) could not be inspected; ` +
        "documentation-only operations under those mounts cannot be verified statically.",
    );
  }
  return out;
}

/**
 * Statically scan a repository for supported framework routes without executing code.
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
  const limits = scanLimits(opts);
  const started = Date.now();
  let failed = 0;
  let skipped = 0;
  let limited = false;
  let scope;
  const filePaths = listSourceFiles(root, {
    ...opts,
    maxFiles: limits.maxFiles,
    deadline: started + limits.timeoutMs,
    onScope(evidence) {
      scope = evidence;
    },
    onTraversalError(current, err) {
      failed++;
      diagnostics.push(
        `scan: could not read directory ${current}: ${err && err.message ? err.message : String(err)}`,
      );
    },
    onLimit(file) {
      limited = true;
      skipped++;
      diagnostics.push(
        `scan: stopped source discovery at scan.maxFiles (${limits.maxFiles}); first omitted file: ${file}`,
      );
    },
    onTimeout(current) {
      limited = true;
      skipped++;
      diagnostics.push(
        `scan: stopped source discovery at scan.timeoutMs (${limits.timeoutMs}ms) while reading ${current}`,
      );
    },
  });
  const files = [];
  let totalBytes = 0;
  for (let index = 0; index < filePaths.length; index++) {
    const file = filePaths[index];
    if (Date.now() - started > limits.timeoutMs) {
      limited = true;
      skipped += filePaths.length - index;
      diagnostics.push(`scan: stopped after scan.timeoutMs (${limits.timeoutMs}ms)`);
      break;
    }
    let size;
    try {
      size = fs.statSync(file).size;
    } catch (err) {
      failed++;
      diagnostics.push(`scan: could not stat source file ${file}: ${err.message}`);
      continue;
    }
    if (size > limits.maxFileBytes) {
      failed++;
      skipped++;
      diagnostics.push(
        `scan: skipped ${file}: ${size} bytes exceeds scan.maxFileBytes (${limits.maxFileBytes})`,
      );
      continue;
    }
    if (totalBytes + size > limits.maxTotalBytes) {
      limited = true;
      skipped += filePaths.length - index;
      diagnostics.push(
        `scan: stopped before ${file}: analyzed source would exceed scan.maxTotalBytes (${limits.maxTotalBytes})`,
      );
      break;
    }
    totalBytes += size;
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
    skipped,
    limited,
    totalBytes,
    complete: failed === 0 && !limited,
    scope,
  };
  const resolve = createScopedResolver(root, filePaths);
  resolveImportedHandlers(files, resolve);
  const { nodes, stats } = buildGraph(files, resolve);
  const frameworkRegistries = STATIC_FRAMEWORK_ADAPTERS.map((adapter) => ({
    adapter,
    registry: adapter.build(files, resolve, root, {
      claimedExpressRegistrarSites: stats.attachedRegistrarSites,
    }),
  }));
  const claimedFrameworkSites = new Set(
    frameworkRegistries.flatMap(({ registry }) =>
      registry.routes.map(
        (route) => `${route.source?.file || ""}\0${route.source?.line || 0}\0${route.method}`,
      ),
    ),
  );

  const ctx = { out: [], visited: new Set() };
  const applications = [];
  let appNodes = 0;
  for (const node of nodes.values()) {
    if (node.kind !== "app") continue;
    appNodes++;
    const id = applicationId(root, node);
    const appCtx = { out: [], visited: ctx.visited, opaqueUses: [] };
    traverse(nodes, node.id, "", [], false, new Set([node.id]), appCtx);
    for (const route of appCtx.out) route.applicationId = id;
    ctx.out.push(...appCtx.out);
    for (const use of appCtx.opaqueUses) {
      (ctx.opaqueUses ||= []).push({ ...use, applicationId: id });
    }
    applications.push({
      id,
      name: `${path.relative(root, node.file).split(path.sep).join("/")}#${node.var}`,
      framework: "express",
      adapter: "express",
      source: { file: node.file, line: node.line },
      routeCount: appCtx.out.length,
      globalMiddleware: node.globalMw.map((entry) => entry.mw),
    });
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
      if (stats.attachedRegistrars.has(`${file.filePath}\0${route.registrarStart}`)) continue;
      if (claimedFrameworkSites.has(`${file.filePath}\0${route.line || 0}\0${route.method}`)) {
        continue;
      }
      emitRoute({ ...route, file: file.filePath }, "", [], true, ctx.out);
      const key = `'${route.host}' in ${file.filePath}`;
      registrarHosts.set(key, (registrarHosts.get(key) || 0) + 1);
    }
  }
  const out = ctx.out;

  const seen = new Set();
  const routes = out.filter((r) => !seen.has(dedupeKey(r)) && seen.add(dedupeKey(r)));
  for (const route of routes) {
    if (route.applicationId === undefined) route.applicationId = null;
  }
  const globalMiddleware = [];
  for (const node of nodes.values())
    if (node.kind === "app") globalMiddleware.push(...node.globalMw.map((e) => e.mw));
  const unresolvedOpaqueUses = [];
  for (const node of nodes.values()) {
    if (ctx.visited.has(node.id)) continue;
    for (const use of node.opaqueUses || []) {
      unresolvedOpaqueUses.push({
        applicationId: null,
        path: use.pathConfidence === "full" ? use.mountPath : null,
        pathConfidence: use.pathConfidence,
        middlewares: use.middlewares,
        source: { file: use.file, line: use.line },
      });
    }
  }
  const opaqueSeen = new Set();
  const opaqueMounts = [...(ctx.opaqueUses || []), ...unresolvedOpaqueUses].filter((item) => {
    const key = `${item.applicationId || ""}\0${item.path || ""}\0${item.source.file}:${item.source.line}`;
    if (opaqueSeen.has(key)) return false;
    opaqueSeen.add(key);
    return true;
  });
  for (const { registry } of frameworkRegistries) {
    routes.push(...registry.routes);
    applications.push(...registry.applications);
    globalMiddleware.push(...registry.globalMiddleware);
    diagnostics.push(...registry.diagnostics);
    for (const mount of registry.opaqueMounts || []) {
      const key = `${mount.applicationId || ""}\0${mount.path || ""}\0${mount.source.file}:${mount.source.line}`;
      if (!opaqueSeen.has(key)) {
        opaqueSeen.add(key);
        opaqueMounts.push(mount);
      }
    }
  }
  diagnostics.push(
    ...diagnose({
      appNodes,
      reachable,
      orphan,
      dropped: stats.dropped,
      opaqueMounts: opaqueMounts.length,
    }),
  );
  for (const [host, count] of registrarHosts) {
    diagnostics.push(
      `${count} route(s) registered on unresolved host ${host} — likely a registrar ` +
        "function invoked elsewhere; mount prefixes are unknown. " +
        "Re-run with --mode hybrid --app <entry> to recover them.",
    );
  }
  const registrarRoutes = [...registrarHosts.values()].reduce((total, count) => total + count, 0);
  const orphanRoutes = routes.filter((route) => route.applicationId === null).length;
  const partialRoutes = routes.filter((route) => route.pathConfidence === "partial").length;
  const routeGraph = {
    complete: orphanRoutes === 0 && partialRoutes === 0 && opaqueMounts.length === 0,
    orphanRoutes,
    partialRoutes,
    registrarRoutes,
    opaqueMounts,
  };
  return { routes, globalMiddleware, applications, diagnostics, scanCoverage, routeGraph };
}

module.exports = { scan, scanLimits, createScanScope, listSourceFiles, buildGraph };
