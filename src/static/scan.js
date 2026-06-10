"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { analyzeFile } = require("./analyze-file");
const { loadTsconfig, createResolver, EXTENSIONS } = require("./resolve");
const { joinPath } = require("../walk");

const SOURCE_EXT = new Set(EXTENSIONS);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "out"]);

/** Recursively collect source files under `dir`, skipping vendored/build dirs. */
function listSourceFiles(dir) {
  const found = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) stack.push(full);
      } else if (SOURCE_EXT.has(path.extname(entry.name))) {
        found.push(full);
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
    for (const [host, mws] of file.globalMwByHost) resolveLocal(file, host).globalMw.push(...mws);
    for (const edge of file.edges) {
      const target = resolveRef(file, edge.targetRef);
      const hostNode = resolveLocal(file, edge.host);
      if (isRouteHost(target)) {
        hostNode.edges.push({
          mountPath: edge.mountPath,
          targetId: target.id,
          edgeMw: edge.edgeMw,
        });
      } else {
        // Not a router after all — a locally-required middleware (e.g. an auth
        // guard) used in `.use()`. Keep it in the chain instead of dropping it.
        hostNode.globalMw.push(edge.fallbackMw, ...edge.edgeMw);
      }
    }
  }
  return { nodes, stats };
}

function emitRoute(route, prefix, accMw, partial, out) {
  const dynamic = route.path === null;
  const full = dynamic ? joinPath(prefix, "<dynamic>") : joinPath(prefix, route.path);
  out.push({
    method: route.method,
    path: full,
    middlewares: accMw.concat(route.middlewares),
    source: { file: route.file, line: route.line },
    pathConfidence: partial || dynamic ? "partial" : "full",
  });
}

/** Depth-first walk of the router graph from a root, emitting fully-pathed routes. */
function traverse(nodes, nodeId, prefix, inherited, partial, stack, ctx) {
  const node = nodes.get(nodeId);
  if (!node) return;
  ctx.visited.add(nodeId);
  const accMw = inherited.concat(node.globalMw);
  for (const route of node.routes) emitRoute(route, prefix, accMw, partial, ctx.out);
  for (const edge of node.edges) {
    if (stack.has(edge.targetId)) continue;
    const childPrefix = edge.mountPath === null ? prefix : joinPath(prefix, edge.mountPath);
    const nextStack = new Set(stack).add(edge.targetId);
    traverse(nodes, edge.targetId, childPrefix, accMw.concat(edge.edgeMw), partial, nextStack, ctx);
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
 * @returns {{routes: object[], globalMiddleware: object[], diagnostics: string[]}}
 */
function scan(rootDir) {
  const files = listSourceFiles(rootDir)
    .map((f) => analyzeFile(fs.readFileSync(f, "utf8"), f))
    .filter(Boolean);
  const resolve = createResolver(loadTsconfig(rootDir));
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
  // audit never silently drops a route.
  for (const node of nodes.values()) {
    if (ctx.visited.has(node.id) || node.routes.length === 0 || node.kind !== "router") continue;
    for (const route of node.routes) emitRoute(route, "", node.globalMw, true, ctx.out);
  }
  const orphan = ctx.out.length - reachable;
  const out = ctx.out;

  const seen = new Set();
  const routes = out.filter((r) => !seen.has(dedupeKey(r)) && seen.add(dedupeKey(r)));
  const globalMiddleware = [];
  for (const node of nodes.values())
    if (node.kind === "app") globalMiddleware.push(...node.globalMw);
  const diagnostics = diagnose({ appNodes, reachable, orphan, dropped: stats.dropped });
  return { routes, globalMiddleware, diagnostics };
}

module.exports = { scan, listSourceFiles, buildGraph };
