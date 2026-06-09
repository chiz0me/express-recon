"use strict";

const {
  parse,
  unwrap,
  calleeName,
  staticString,
  snippet,
  middlewareFromArg,
  HTTP_METHODS,
} = require("./ast");

/** Depth-first pre-order visit of every ESTree node, in document order. */
function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) walk(item, visit);
    } else if (child && typeof child.type === "string") {
      walk(child, visit);
    }
  }
}

/** Map a character offset to a 1-based line number via precomputed line starts. */
function lineCounter(code) {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Record a module binding (`require`/`import`) as local name -> {source, imported}. */
function addBinding(bindings, local, source, imported) {
  if (local && source) bindings.set(local, { source, imported });
}

function collectRequireBinding(node, bindings) {
  const init = node.init;
  if (!init || init.type !== "CallExpression" || calleeName(init.callee) !== "require") return;
  const source = staticString(init.arguments[0]);
  if (!source) return;
  if (node.id.type === "Identifier") addBinding(bindings, node.id.name, source, "default");
  else if (node.id.type === "ObjectPattern") {
    for (const prop of node.id.properties) {
      if (prop.key && prop.value && prop.value.type === "Identifier") {
        addBinding(bindings, prop.value.name, source, prop.key.name);
      }
    }
  }
}

function collectImportBinding(node, bindings) {
  const source = node.source.value;
  for (const spec of node.specifiers) {
    if (spec.type === "ImportDefaultSpecifier")
      addBinding(bindings, spec.local.name, source, "default");
    else if (spec.type === "ImportNamespaceSpecifier")
      addBinding(bindings, spec.local.name, source, "*");
    else if (spec.type === "ImportSpecifier")
      addBinding(bindings, spec.local.name, source, spec.imported.name);
  }
}

/**
 * First pass: module bindings + router variables. Recognises `require` and ESM
 * `import`, the local name bound to express, destructured/imported `Router`
 * factories, and every `express()` (app) / `*.Router()` (router) variable.
 */
function collectBindings(program) {
  const bindings = new Map();
  walk(program, (node) => {
    if (node.type === "VariableDeclarator") collectRequireBinding(node, bindings);
    else if (node.type === "ImportDeclaration") collectImportBinding(node, bindings);
  });

  let expressVar = null;
  const factoryNames = new Set();
  for (const [local, { source, imported }] of bindings) {
    if (source !== "express") continue;
    if (imported === "default" || imported === "*") expressVar = local;
    if (imported === "Router") factoryNames.add(local);
  }

  const isRouterInit = (init) => {
    const n = init && unwrap(init);
    if (!n || n.type !== "CallExpression") return false;
    const name = calleeName(n.callee);
    if (name && name.endsWith(".Router")) return true;
    return n.callee.type === "Identifier" && factoryNames.has(n.callee.name);
  };
  const isAppInit = (init) => {
    const n = init && unwrap(init);
    if (!n || n.type !== "CallExpression") return false;
    return n.callee.type === "Identifier" && n.callee.name === expressVar;
  };

  const routers = new Map();
  walk(program, (node) => {
    if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier" || !node.init) return;
    if (isAppInit(node.init)) routers.set(node.id.name, { kind: "app" });
    else if (isRouterInit(node.init)) routers.set(node.id.name, { kind: "router" });
  });

  return { requires: bindings, routers, factoryNames };
}

/** Flatten a call's middleware args (arrays inlined), dropping the final handler. */
function middlewareArgs(args, code, dropLast) {
  const flat = [];
  for (const arg of args) {
    const node = unwrap(arg);
    if (node.type === "ArrayExpression") flat.push(...node.elements.filter(Boolean));
    else flat.push(node);
  }
  const layers = dropLast ? flat.slice(0, Math.max(flat.length - 1, 0)) : flat;
  return layers.map((n) => middlewareFromArg(n, code));
}

/** Unwrap `host.route('/x').get(...).post(...)` to its base `{host, path}`. */
function routeChainBase(memberObject) {
  let node = unwrap(memberObject);
  while (node && node.type === "CallExpression") {
    const name = calleeName(node.callee);
    if (name && name.endsWith(".route")) {
      return { host: unwrap(node.callee.object), path: staticString(node.arguments[0]) };
    }
    node = node.callee.type === "MemberExpression" ? unwrap(node.callee.object) : null;
  }
  return null;
}

/** Resolve the `(host, path)` of an HTTP-method call, or null if not a route. */
function routeTarget(node) {
  const object = unwrap(node.callee.object);
  if (object.type === "Identifier") {
    return { host: object.name, path: staticString(node.arguments[0]), pathArg: true };
  }
  if (object.type === "CallExpression") {
    const base = routeChainBase(object);
    if (base && base.host.type === "Identifier") {
      return { host: base.host.name, path: base.path, pathArg: false };
    }
  }
  return null;
}

function isKnownHost(name, ctx) {
  return ctx.routers.has(name) || ctx.requires.has(name);
}

/** Collect route registrations (`host.get('/x', ...)`) into `out.routes`. */
function extractRoutes(program, code, ctx, out) {
  walk(program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return;
    const method = node.callee.property.name;
    if (!HTTP_METHODS.has(method)) return;
    const target = routeTarget(node);
    if (!target || !isKnownHost(target.host, ctx)) return;
    const mwSource = target.pathArg ? node.arguments.slice(1) : node.arguments;
    out.routes.push({
      host: target.host,
      method: method === "all" ? "ALL" : method.toUpperCase(),
      path: target.path,
      pathRaw: snippet(code, node.arguments[0] || node, 40),
      middlewares: middlewareArgs(mwSource, code, true),
      line: ctx.lineAt(node.start),
    });
  });
}

/** Collect `host.use(...)` mounts and host-level middleware into `out`. */
function extractMounts(program, code, ctx, out) {
  walk(program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return;
    if (node.callee.property.name !== "use" || unwrap(node.callee.object).type !== "Identifier")
      return;
    const host = unwrap(node.callee.object).name;
    if (!isKnownHost(host, ctx)) return;
    const mountPath = node.arguments[0] ? staticString(node.arguments[0]) : null;
    const layers = mountPath !== null ? node.arguments.slice(1) : node.arguments;
    const isRef = (l) => unwrap(l).type === "Identifier" && isKnownHost(unwrap(l).name, ctx);
    const refs = layers.filter(isRef);
    const mws = layers.filter((l) => !isRef(l)).map((l) => middlewareFromArg(l, code));
    if (refs.length === 0) {
      out.globalMwByHost.set(host, (out.globalMwByHost.get(host) || []).concat(mws));
      return;
    }
    for (const ref of refs) {
      out.edges.push({
        host,
        mountPath,
        targetName: unwrap(ref).name,
        edgeMw: mws,
        line: ctx.lineAt(node.start),
      });
    }
  });
}

function exportNameFromAssignment(left) {
  const name = calleeName(left);
  if (name === "module.exports") return "default";
  if (name === "exports") return "default";
  if (name && (name.startsWith("exports.") || name.startsWith("module.exports."))) {
    return name.split(".").pop();
  }
  return null;
}

/** Build the file's export map (name -> local var) plus re-export edges. */
function collectExports(program) {
  const exports = new Map();
  const reExports = [];
  const reExportAll = [];
  walk(program, (node) => {
    if (node.type === "AssignmentExpression") {
      const name = exportNameFromAssignment(node.left);
      if (name && unwrap(node.right).type === "Identifier")
        exports.set(name, unwrap(node.right).name);
    } else if (node.type === "ExportDefaultDeclaration" && node.declaration.type === "Identifier") {
      exports.set("default", node.declaration.name);
    } else if (node.type === "ExportNamedDeclaration") {
      collectNamedExport(node, exports, reExports);
    } else if (node.type === "ExportAllDeclaration" && !node.exported) {
      reExportAll.push(node.source.value);
    }
  });
  return { exports, reExports, reExportAll };
}

function collectNamedExport(node, exports, reExports) {
  if (node.declaration && node.declaration.declarations) {
    for (const d of node.declaration.declarations) {
      if (d.id.type === "Identifier") exports.set(d.id.name, d.id.name);
    }
  }
  for (const spec of node.specifiers || []) {
    if (node.source)
      reExports.push({
        exportName: spec.exported.name,
        source: node.source.value,
        importedName: spec.local.name,
      });
    else exports.set(spec.exported.name, spec.local.name);
  }
}

/**
 * Analyze one JS/TS source file into a router model.
 *
 * @param {string} code
 * @param {string} filePath  absolute path (node-id namespace + dialect hint)
 * @returns {object|null} file model, or null if the file doesn't parse.
 */
function analyzeFile(code, filePath) {
  const program = parse(code, filePath);
  if (!program) return null;
  const { requires, routers } = collectBindings(program);
  const ctx = { requires, routers, lineAt: lineCounter(code) };
  const out = { filePath, requires, routers, routes: [], edges: [], globalMwByHost: new Map() };
  extractRoutes(program, code, ctx, out);
  extractMounts(program, code, ctx, out);
  const { exports, reExports, reExportAll } = collectExports(program);
  out.exports = exports;
  out.reExports = reExports;
  out.reExportAll = reExportAll;
  return out;
}

module.exports = { walk, collectBindings, analyzeFile };
