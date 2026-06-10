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

/**
 * If `node` is a `require()`-rooted expression, describe the module export it
 * reads. Sees through a factory call (`require('x')(deps)`) and trailing
 * property accesses (`require('x').y.z`). CommonJS has no real named exports, so
 * every access is modelled as the module's default value plus a property path.
 *
 * @returns {{source: string, exportName: "default", props: string[]}|null}
 */
function requireInfo(node) {
  let n = unwrap(node);
  const props = [];
  while (n) {
    if (n.type === "MemberExpression" && !n.computed && n.property.type === "Identifier") {
      props.unshift(n.property.name);
      n = unwrap(n.object);
      continue;
    }
    if (n.type === "CallExpression") {
      if (calleeName(n.callee) === "require") {
        const source = staticString(n.arguments[0]);
        return source ? { source, exportName: "default", props } : null;
      }
      const c = unwrap(n.callee);
      // `require('x')(deps)` — calling the module's factory export: see through.
      // `require('x').method()` / `local()` — a method/instance call, not a
      // plain module reference (e.g. `require('express').Router()`): give up.
      if (c.type === "CallExpression") {
        n = c;
        continue;
      }
      return null;
    }
    break;
  }
  return null;
}

/** Record a module binding (`require`/`import`) as local name -> ref descriptor. */
function addBinding(bindings, local, ref) {
  if (local && ref) bindings.set(local, ref);
}

function collectRequireBinding(node, bindings) {
  const init = node.init && unwrap(node.init);
  if (!init) return;
  if (node.id.type === "Identifier") {
    const info = requireInfo(init);
    if (info) addBinding(bindings, node.id.name, info);
    return;
  }
  if (node.id.type === "ObjectPattern") {
    const info = requireInfo(init);
    if (!info) return;
    for (const prop of node.id.properties) {
      if (prop.key && prop.value && prop.value.type === "Identifier") {
        addBinding(bindings, prop.value.name, {
          source: info.source,
          exportName: "default",
          props: info.props.concat(prop.key.name),
        });
      }
    }
  }
}

function collectImportBinding(node, bindings) {
  const source = node.source.value;
  for (const spec of node.specifiers) {
    if (spec.type === "ImportDefaultSpecifier")
      addBinding(bindings, spec.local.name, { source, exportName: "default", props: [] });
    else if (spec.type === "ImportNamespaceSpecifier")
      addBinding(bindings, spec.local.name, { source, exportName: "*", props: [] });
    else if (spec.type === "ImportSpecifier")
      addBinding(bindings, spec.local.name, { source, exportName: spec.imported.name, props: [] });
  }
}

/**
 * First pass: module bindings + router variables. Recognises `require`/`import`
 * (including factory-call and property forms), the local name bound to express,
 * destructured/imported `Router` factories, and every `express()` (app) /
 * `*.Router()` (router) variable.
 */
function collectBindings(program) {
  const bindings = new Map();
  walk(program, (node) => {
    if (node.type === "VariableDeclarator") collectRequireBinding(node, bindings);
    else if (node.type === "ImportDeclaration") collectImportBinding(node, bindings);
  });

  let expressVar = null;
  const factoryNames = new Set();
  for (const [local, { source, exportName }] of bindings) {
    if (source !== "express") continue;
    if (exportName === "default" || exportName === "*") expressVar = local;
    if (exportName === "Router") factoryNames.add(local);
  }

  const callee = (init) => {
    const n = init && unwrap(init);
    if (!n || (n.type !== "CallExpression" && n.type !== "NewExpression")) return null;
    return n.callee;
  };
  const isRouterInit = (init) => {
    const c = callee(init);
    if (!c) return false;
    // `express.Router()`, `require('express').Router()`, any `x.Router()`.
    if (c.type === "MemberExpression" && !c.computed && c.property.name === "Router") return true;
    const name = calleeName(c);
    if (name && name.endsWith(".Router")) return true;
    return c.type === "Identifier" && factoryNames.has(c.name);
  };
  const isAppInit = (init) => {
    const c = callee(init);
    return Boolean(c && c.type === "Identifier" && c.name === expressVar);
  };

  const routers = new Map();
  walk(program, (node) => {
    if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier" || !node.init) return;
    if (isAppInit(node.init)) routers.set(node.id.name, { kind: "app" });
    else if (isRouterInit(node.init)) routers.set(node.id.name, { kind: "router" });
  });

  return { requires: bindings, routers, factoryNames };
}

/** First top-level `return` argument of a function (skips nested fn scopes). */
function factoryReturnNode(fn) {
  if (fn.type === "ArrowFunctionExpression" && fn.expression) return fn.body;
  const body = fn.body && fn.body.body;
  if (!Array.isArray(body)) return null;
  let found = null;
  const visit = (node) => {
    if (!node || found) return;
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "ClassDeclaration" ||
      node.type === "ClassExpression"
    )
      return;
    if (node.type === "ReturnStatement") {
      found = node.argument || null;
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end") continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child.type === "string") visit(child);
    }
  };
  body.forEach(visit);
  return found;
}

/**
 * Describe what an expression resolves to, as a `Ref` the cross-file graph can
 * follow. Refs are: `local` (a router var in this file), `module` (an export of
 * another module, with a property path), `object` (an object literal whose
 * values are themselves Refs), `factory` (a function returning a Ref), or
 * `unknown`.
 *
 * @param {object} node
 * @param {{requires: Map, routers: Map}} ctx
 * @returns {object} Ref
 */
function refFromExpr(node, ctx) {
  const n = unwrap(node);
  if (!n) return { t: "unknown" };

  const info = requireInfo(n);
  if (info)
    return { t: "module", source: info.source, exportName: info.exportName, props: info.props };

  if (n.type === "Identifier") {
    if (ctx.routers.has(n.name)) return { t: "local", name: n.name };
    const b = ctx.requires.get(n.name);
    if (b) return { t: "module", source: b.source, exportName: b.exportName, props: b.props };
    return { t: "local", name: n.name };
  }
  if (n.type === "MemberExpression" && !n.computed && n.object.type === "Identifier") {
    const b = ctx.requires.get(n.object.name);
    if (b)
      return {
        t: "module",
        source: b.source,
        exportName: b.exportName,
        props: b.props.concat(n.property.name),
      };
    return { t: "unknown" };
  }
  if (n.type === "CallExpression") {
    const c = unwrap(n.callee);
    if (c.type === "Identifier" && ctx.requires.has(c.name)) return refFromExpr(c, ctx);
    return { t: "unknown" };
  }
  if (n.type === "ObjectExpression") {
    const props = new Map();
    for (const prop of n.properties) {
      if (prop.type === "Property" && !prop.computed && prop.key.type === "Identifier") {
        props.set(prop.key.name, refFromExpr(prop.value, ctx));
      }
    }
    return { t: "object", props };
  }
  if (n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") {
    const ret = factoryReturnNode(n);
    return { t: "factory", ret: ret ? refFromExpr(ret, ctx) : { t: "unknown" } };
  }
  return { t: "unknown" };
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

function isLocalHost(name, ctx) {
  return ctx.routers.has(name) || ctx.requires.has(name);
}

/** Collect route registrations (`host.get('/x', ...)`) into `out.routes`. */
function extractRoutes(program, code, ctx, out) {
  walk(program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return;
    const method = node.callee.property.name;
    if (!HTTP_METHODS.has(method)) return;
    const target = routeTarget(node);
    if (!target || !isLocalHost(target.host, ctx)) return;
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

/** Relative or path-aliased specifier — i.e. first-party code we can scan. */
function isLocalSource(source) {
  return source.startsWith(".") || source.startsWith("@") || source.startsWith("~");
}

/**
 * Is a `.use()` layer a sub-router mount (vs. plain middleware)? Mounts are
 * passed by reference — a router variable (`admin`) or a barrel property
 * (`routes.auth`) — never as a call. A call argument (`auth()`, `cors()`,
 * `compression()`) is always middleware, so only identifier/member layers
 * referring to first-party modules qualify.
 */
function isMountRef(node, ref, ctx) {
  const n = unwrap(node);
  if (n.type === "Identifier" || (n.type === "MemberExpression" && !n.computed)) {
    if (ref.t === "local") return ctx.routers.has(ref.name);
    if (ref.t === "module") return isLocalSource(ref.source);
    return false;
  }
  // Inline factory mount: `require('./sub')(deps)`. A bare-package or plain
  // call (`cors()`, `auth()`) is middleware, not a mount.
  if (n.type === "CallExpression") {
    const info = requireInfo(n);
    return Boolean(info && isLocalSource(info.source));
  }
  return false;
}

/** Collect `host.use(...)` mounts and host-level middleware into `out`. */
function extractMounts(program, code, ctx, out) {
  walk(program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return;
    if (node.callee.property.name !== "use" || unwrap(node.callee.object).type !== "Identifier")
      return;
    const host = unwrap(node.callee.object).name;
    if (!isLocalHost(host, ctx)) return;
    const mountPath = node.arguments[0] ? staticString(node.arguments[0]) : null;
    const layers = mountPath !== null ? node.arguments.slice(1) : node.arguments;
    const tagged = layers.map((l) => ({
      node: l,
      ref: refFromExpr(l, ctx),
      mw: middlewareFromArg(l, code),
    }));
    const refs = tagged.filter((t) => isMountRef(t.node, t.ref, ctx));
    const mws = tagged.filter((t) => !isMountRef(t.node, t.ref, ctx)).map((t) => t.mw);
    if (refs.length === 0) {
      out.globalMwByHost.set(host, (out.globalMwByHost.get(host) || []).concat(mws));
      return;
    }
    // Each candidate is a sub-router *or* a locally-required middleware that
    // shares its shape; `buildGraph` decides once it sees what it resolves to.
    for (const ref of refs) {
      out.edges.push({
        host,
        mountPath,
        targetRef: ref.ref,
        fallbackMw: ref.mw,
        edgeMw: mws,
        line: ctx.lineAt(node.start),
      });
    }
  });
}

function exportNameFromAssignment(left) {
  const name = calleeName(left);
  if (name === "module.exports" || name === "exports") return "default";
  if (name && (name.startsWith("exports.") || name.startsWith("module.exports."))) {
    return name.split(".").pop();
  }
  return null;
}

/** Build the file's export map (name -> Ref) plus `export *` barrel sources. */
function collectExports(program, ctx) {
  const exportRefs = new Map();
  const reExportAll = [];
  walk(program, (node) => {
    if (node.type === "AssignmentExpression") {
      const name = exportNameFromAssignment(node.left);
      if (name) exportRefs.set(name, refFromExpr(node.right, ctx));
    } else if (node.type === "ExportDefaultDeclaration") {
      exportRefs.set("default", refFromExpr(node.declaration, ctx));
    } else if (node.type === "ExportNamedDeclaration") {
      collectNamedExport(node, exportRefs);
    } else if (node.type === "ExportAllDeclaration" && !node.exported) {
      reExportAll.push(node.source.value);
    }
  });
  return { exportRefs, reExportAll };
}

function collectNamedExport(node, exportRefs) {
  if (node.declaration && node.declaration.declarations) {
    for (const d of node.declaration.declarations) {
      if (d.id.type === "Identifier") exportRefs.set(d.id.name, { t: "local", name: d.id.name });
    }
  }
  for (const spec of node.specifiers || []) {
    if (node.source)
      exportRefs.set(spec.exported.name, {
        t: "module",
        source: node.source.value,
        exportName: spec.local.name,
        props: [],
      });
    else exportRefs.set(spec.exported.name, { t: "local", name: spec.local.name });
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
  const { exportRefs, reExportAll } = collectExports(program, ctx);
  out.exportRefs = exportRefs;
  out.reExportAll = reExportAll;
  return out;
}

module.exports = { walk, collectBindings, refFromExpr, analyzeFile };
