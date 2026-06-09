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
 * Resolve a module's exported router to `{file, var}`, following `export … from`
 * re-exports and `export *` barrels. `exportName` is "default" or a named export.
 */
function resolveExport(filePath, exportName, byPath, resolve, seen) {
  const key = `${filePath}#${exportName}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const tf = byPath.get(filePath);
  if (!tf) return null;
  if (tf.exports.has(exportName)) return { file: filePath, var: tf.exports.get(exportName) };
  for (const re of tf.reExports) {
    if (re.exportName !== exportName) continue;
    const target = resolve(filePath, re.source);
    const found = target && resolveExport(target, re.importedName, byPath, resolve, seen);
    if (found) return found;
  }
  for (const source of tf.reExportAll) {
    const target = resolve(filePath, source);
    const found = target && resolveExport(target, exportName, byPath, resolve, seen);
    if (found) return found;
  }
  return null;
}

/** Build the cross-file router graph from analyzed file models. */
function buildGraph(files, resolve) {
  const byPath = new Map(files.map((f) => [f.filePath, f]));
  const nodes = new Map();
  const ensure = (id, kind) => {
    if (!nodes.has(id)) nodes.set(id, { id, kind, routes: [], globalMw: [], edges: [] });
    return nodes.get(id);
  };
  const resolveHost = (file, name) => {
    if (file.routers.has(name))
      return ensure(`${file.filePath}#${name}`, file.routers.get(name).kind);
    if (file.requires.has(name)) {
      const { source, imported } = file.requires.get(name);
      const target = resolve(file.filePath, source);
      const found = target && resolveExport(target, imported, byPath, resolve, new Set());
      if (found) return ensure(`${found.file}#${found.var}`, "router");
      return ensure(`external:${source}`, "external");
    }
    return ensure(`${file.filePath}#${name}`, "unknown");
  };

  for (const file of files) {
    for (const route of file.routes)
      resolveHost(file, route.host).routes.push({ ...route, file: file.filePath });
    for (const [host, mws] of file.globalMwByHost) resolveHost(file, host).globalMw.push(...mws);
    for (const edge of file.edges) {
      const target = resolveHost(file, edge.targetName);
      resolveHost(file, edge.host).edges.push({
        mountPath: edge.mountPath,
        targetId: target.id,
        edgeMw: edge.edgeMw,
      });
    }
  }
  return nodes;
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
 * Statically scan a repo for Express routes without executing any code.
 *
 * @param {string} rootDir  directory to scan
 * @returns {{routes: object[], globalMiddleware: object[]}}
 */
function scan(rootDir) {
  const files = listSourceFiles(rootDir)
    .map((f) => analyzeFile(fs.readFileSync(f, "utf8"), f))
    .filter(Boolean);
  const resolve = createResolver(loadTsconfig(rootDir));
  const nodes = buildGraph(files, resolve);

  const ctx = { out: [], visited: new Set() };
  for (const node of nodes.values()) {
    if (node.kind !== "app") continue;
    traverse(nodes, node.id, "", [], false, new Set([node.id]), ctx);
  }
  // Routers never reached from an app: emit with unknown mount prefix so an
  // audit never silently drops a route.
  for (const node of nodes.values()) {
    if (ctx.visited.has(node.id) || node.routes.length === 0) continue;
    for (const route of node.routes) emitRoute(route, "", node.globalMw, true, ctx.out);
  }
  const out = ctx.out;

  const seen = new Set();
  const routes = out.filter((r) => !seen.has(dedupeKey(r)) && seen.add(dedupeKey(r)));
  const globalMiddleware = [];
  for (const node of nodes.values())
    if (node.kind === "app") globalMiddleware.push(...node.globalMw);
  return { routes, globalMiddleware };
}

module.exports = { scan, listSourceFiles, buildGraph };
