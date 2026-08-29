"use strict";

const {
  parse,
  walk,
  unwrap,
  calleeName,
  staticString,
  snippet,
  middlewareFromArg,
  HTTP_METHODS,
} = require("./ast");
const { extractIoHints } = require("./io-hints");

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
    if (isAppInit(node.init)) routers.set(node.id.name, { kind: "app", start: node.start });
    else if (isRouterInit(node.init)) {
      routers.set(node.id.name, { kind: "router", start: node.start });
    }
  });

  return { requires: bindings, routers, factoryNames };
}

/**
 * Same-file `const NAME = <static string>` bindings, in document order so a
 * const may fold earlier ones (`const V1 = "/v1"; const USERS = V1 + "/users"`).
 * `let`/`var` are skipped — they can be reassigned.
 */
function collectStringConsts(program) {
  const consts = new Map();
  walk(program, (node) => {
    if (node.type !== "VariableDeclaration" || node.kind !== "const") return;
    for (const d of node.declarations) {
      if (d.id.type !== "Identifier" || !d.init) continue;
      const value = staticString(d.init, consts);
      if (value !== null && !consts.has(d.id.name)) consts.set(d.id.name, value);
    }
  });
  return consts;
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

/**
 * The terminal (handler) argument of a route registration — the last node after
 * flattening arrays the same way `middlewareArgs` does. `middlewareArgs(…, true)`
 * drops this same node as the handler; here we recover it to mine I/O hints.
 */
function terminalHandler(args) {
  const flat = [];
  for (const arg of args) {
    const node = unwrap(arg);
    if (node.type === "ArrayExpression") flat.push(...node.elements.filter(Boolean));
    else flat.push(node);
  }
  return flat.length ? flat[flat.length - 1] : null;
}

const FN_NODE = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

function emptyIo() {
  return {
    request: { body: [], query: [], params: [], headers: [] },
    responses: [],
    statusCodes: [],
    handlerResolved: false,
    handlerSource: null,
  };
}

/** Mine a resolved handler function into an `io` object stamped with its source. */
function mineFn(fn, lineAt, file) {
  const hints = extractIoHints(fn);
  return {
    request: hints.request,
    responses: hints.responses,
    statusCodes: hints.statusCodes,
    handlerResolved: true,
    handlerSource: { file, line: lineAt(fn.start) },
  };
}

/**
 * Resolve a route's terminal handler node to statically-mined I/O hints. One
 * hop: an inline function or same-file named handler is mined here; a first-party
 * imported controller yields a module `handlerRef` the scan pass follows; a
 * wrapper call (`asyncHandler(fn)`) is unwrapped to its last argument. Anything
 * else degrades to `{ handlerResolved: false }`. `handlerName` captures the
 * handler's identifier/dotted callee (e.g. `controllers.user.getUser`) even when
 * the body can't be mined, so an AI pass knows which symbol to open.
 *
 * @returns {{io: object, handlerRef: object|null, handlerName: string|null}}
 */
function resolveHandler(handlerNode, ctx) {
  const node = handlerNode && unwrap(handlerNode);
  if (!node) return { io: emptyIo(), handlerRef: null, handlerName: null };
  if (FN_NODE.has(node.type))
    return { io: mineFn(node, ctx.lineAt, ctx.filePath), handlerRef: null, handlerName: null };
  if (node.type === "Identifier") {
    const fn = ctx.handlerIndex.get(node.name);
    const io = fn ? mineFn(fn, ctx.lineAt, ctx.filePath) : emptyIo();
    const ref = fn ? null : refFromExpr(node, ctx);
    return { io, handlerRef: ref && ref.t === "module" ? ref : null, handlerName: node.name };
  }
  if (node.type === "MemberExpression") {
    const ref = refFromExpr(node, ctx);
    return {
      io: emptyIo(),
      handlerRef: ref.t === "module" ? ref : null,
      handlerName: calleeName(node),
    };
  }
  if (node.type === "CallExpression") {
    const last = node.arguments[node.arguments.length - 1];
    if (last) {
      const inner = resolveHandler(last, ctx);
      return { ...inner, handlerName: inner.handlerName ?? calleeName(node.callee) };
    }
  }
  return { io: emptyIo(), handlerRef: null, handlerName: null };
}

/** Attach `io` (+ transient `__handlerRef`) for a route's handler to `route`. */
function attachIo(route, handlerNode, ctx) {
  const { io, handlerRef, handlerName } = resolveHandler(handlerNode, ctx);
  if (handlerName) io.handlerName = handlerName;
  route.io = io;
  if (handlerRef) route.__handlerRef = handlerRef;
}

/**
 * Same-file handler functions by name: top-level `function f(){}` declarations
 * and `const f = (req,res) => …`. Lets a route registered as `.get('/x', getFoo)`
 * resolve `getFoo` to its body for I/O mining.
 */
function collectHandlerIndex(program) {
  const index = new Map();
  walk(program, (node) => {
    if (node.type === "FunctionDeclaration" && node.id && !index.has(node.id.name)) {
      index.set(node.id.name, node);
    } else if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init) {
      const init = unwrap(node.init);
      if (FN_NODE.has(init.type) && !index.has(node.id.name)) index.set(node.id.name, init);
    }
  });
  return index;
}

/**
 * Unwrap `host.route('/x').all(...).get(...)` to its base `{host, pathNode}`.
 * `.all(...)` links run for every verb on the route, so their args are
 * collected as middleware for the sibling verbs registered after them.
 */
function routeChainBase(memberObject) {
  let node = unwrap(memberObject);
  const allArgs = [];
  while (node && node.type === "CallExpression" && node.callee.type === "MemberExpression") {
    const prop = !node.callee.computed && node.callee.property.name;
    if (prop === "route") {
      return {
        host: unwrap(node.callee.object),
        pathNode: node.arguments[0],
        allArgs,
        start: node.start,
      };
    }
    if (prop === "all") allArgs.unshift(...node.arguments);
    node = unwrap(node.callee.object);
  }
  return null;
}

/**
 * Root identifier of a fluent chain (`app.use(a).use(b)`, `r.get(...).post(...)`).
 * Only `.use` and HTTP-verb links are unwrapped — those return the host in
 * Express; anything else (`.route()`, arbitrary calls) may not.
 */
function chainRootIdentifier(objectNode) {
  let n = unwrap(objectNode);
  while (n) {
    if (n.type === "Identifier") return n.name;
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression") {
      const prop = n.callee.property.name;
      if (prop === "use" || HTTP_METHODS.has(prop)) {
        n = unwrap(n.callee.object);
        continue;
      }
    }
    return null;
  }
  return null;
}

/** Resolve the `(host, pathNode)` of an HTTP-method call, or null if not a route. */
function routeTarget(node) {
  const object = unwrap(node.callee.object);
  if (object.type === "Identifier") {
    return { host: object.name, pathNode: node.arguments[0], pathArg: true, allArgs: [] };
  }
  if (object.type === "CallExpression") {
    const base = routeChainBase(object);
    if (base && base.host.type === "Identifier") {
      return {
        host: base.host.name,
        pathNode: base.pathNode,
        pathArg: false,
        allArgs: base.allArgs,
        chainStart: base.start,
      };
    }
    const root = chainRootIdentifier(object);
    if (root) return { host: root, pathNode: node.arguments[0], pathArg: true, allArgs: [] };
  }
  return null;
}

function isLocalHost(name, ctx) {
  return ctx.routers.has(name) || ctx.requires.has(name);
}

/**
 * Static path strings a path node denotes: one for a literal/const/concat,
 * several for an array of them, `[null]` when unresolvable (`<dynamic>`).
 */
function pathsFrom(pathNode, consts) {
  if (!pathNode) return [null];
  const single = staticString(pathNode, consts);
  if (single !== null) return [single];
  const n = unwrap(pathNode);
  if (n && n.type === "ArrayExpression") {
    const parts = n.elements.filter(Boolean).map((el) => staticString(el, consts));
    if (parts.length > 0 && parts.every((p) => p !== null)) return parts;
  }
  return [null];
}

/** Collect route registrations (`host.get('/x', ...)`) into `out.routes`. */
function extractRoutes(program, code, ctx, out) {
  const collected = [];
  walk(program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return;
    const method = node.callee.property.name;
    if (!HTTP_METHODS.has(method)) return;
    const target = routeTarget(node);
    if (!target || !isLocalHost(target.host, ctx)) return;
    // `app.get('view engine')` — a lone string on a known app/router var is the
    // settings getter, not a route. Unresolved hosts keep flowing to the graph
    // so non-router calls (HTTP clients, caches) still get their diagnostic.
    if (
      target.pathArg &&
      node.arguments.length === 1 &&
      ctx.routers.has(target.host) &&
      staticString(node.arguments[0], ctx.consts) !== null
    )
      return;
    const mwSource = target.pathArg ? node.arguments.slice(1) : node.arguments;
    const chainMw = middlewareArgs(target.allArgs, code, false);
    const middlewares = chainMw.concat(middlewareArgs(mwSource, code, true));
    const handlerNode = terminalHandler(mwSource);
    for (const path of pathsFrom(target.pathNode, ctx.consts)) {
      const route = {
        host: target.host,
        method: method === "all" ? "ALL" : method.toUpperCase(),
        path,
        pathRaw: snippet(code, target.pathNode || node, 40),
        middlewares,
        // The verb property's line (not the chain start): per-verb precision,
        // and it matches the call-site line V8 reports at runtime, so hybrid
        // reconcile can pair routes by source.
        line: ctx.lineAt(node.callee.property.start),
        chainStart: target.chainStart,
      };
      attachIo(route, handlerNode, ctx);
      collected.push(route);
    }
  });
  // `.route('/x').all(guard).get(h)`: the `.all` link is middleware for the
  // named verbs on the same chain, not an endpoint of its own.
  const namedChains = new Set(
    collected.filter((r) => r.method !== "ALL" && r.chainStart != null).map((r) => r.chainStart),
  );
  for (const { chainStart, ...route } of collected) {
    if (route.method === "ALL" && chainStart != null && namedChains.has(chainStart)) continue;
    out.routes.push(route);
  }
}

/** Relative or path-aliased specifier — i.e. first-party code we can scan. */
function isLocalSource(source) {
  return (
    source.startsWith(".") ||
    source.startsWith("@") ||
    source.startsWith("~") ||
    source.startsWith("#")
  );
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

/**
 * Is a `use()` first argument a path (string/template/regex literal, a string
 * const, or an array of those) rather than a middleware/router layer? Mirrors
 * Express's own argument sniffing so an unresolvable path is never mistaken
 * for a layer.
 */
function isPathLike(node, consts) {
  const n = unwrap(node);
  if (!n) return false;
  if (staticString(n, consts) !== null) return true;
  if (n.type === "Literal") return n.regex != null;
  if (n.type === "TemplateLiteral") return true;
  if (n.type === "ArrayExpression") {
    const elements = n.elements.filter(Boolean);
    return elements.length > 0 && elements.every((el) => isPathLike(el, consts));
  }
  return false;
}

/** Flatten `use()` layer args one level: `use('/x', [a, b])` → `a, b`. */
function flattenLayers(args) {
  const flat = [];
  for (const arg of args) {
    const n = unwrap(arg);
    if (n.type === "ArrayExpression") flat.push(...n.elements.filter(Boolean));
    else flat.push(n);
  }
  return flat;
}

/** Collect `host.use(...)` mounts and host-level middleware into `out`. */
function extractMounts(program, code, ctx, out) {
  walk(program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return;
    if (node.callee.property.name !== "use") return;
    const host = chainRootIdentifier(node.callee.object);
    if (!host || !isLocalHost(host, ctx)) return;
    const hasPath = node.arguments.length > 0 && isPathLike(node.arguments[0], ctx.consts);
    // A path per mount: `null` = no path arg (parent prefix as-is); `"<dynamic>"`
    // = a path exists but couldn't be resolved (regex, computed) — the subtree
    // is marked partial instead of silently landing at the wrong prefix.
    const mountPaths = hasPath
      ? pathsFrom(node.arguments[0], ctx.consts).map((p) => p ?? "<dynamic>")
      : [null];
    const layers = flattenLayers(hasPath ? node.arguments.slice(1) : node.arguments);
    const line = ctx.lineAt(node.start);
    const tagged = layers.map((l) => ({
      node: l,
      ref: refFromExpr(l, ctx),
      mw: middlewareFromArg(l, code),
    }));
    const refs = tagged.filter((t) => isMountRef(t.node, t.ref, ctx));
    const mws = tagged.filter((t) => !isMountRef(t.node, t.ref, ctx)).map((t) => t.mw);
    for (const mountPath of mountPaths) {
      if (refs.length === 0) {
        // Path-scoped middleware keeps its scope so it can be applied only to
        // routes under that prefix, and its line so registration order holds.
        const entries = mws.map((mw) => ({ mw, scope: mountPath, line }));
        out.globalMwByHost.set(host, (out.globalMwByHost.get(host) || []).concat(entries));
        continue;
      }
      // Each candidate is a sub-router *or* a locally-required middleware that
      // shares its shape; `buildGraph` decides once it sees what it resolves to.
      for (const ref of refs) {
        out.edges.push({
          host,
          mountPath,
          partial: mountPath === "<dynamic>",
          targetRef: ref.ref,
          fallbackMw: { mw: ref.mw, scope: mountPath, line },
          edgeMw: mws.map((mw) => ({ mw, scope: null, line })),
          line,
        });
      }
    }
  });
}

const FN_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/**
 * Routes registered on a function parameter — the registrar pattern
 * (`module.exports = (app) => { app.get('/x', h) }`). The host can't be
 * resolved statically (it's bound at the call site), so instead of vanishing,
 * these surface as partial-confidence orphans plus a diagnostic. A static
 * `/`-path and at least one handler arg are required, which filters out
 * HTTP-client/ORM `.get(url)` lookalikes.
 */
function extractRegistrarRoutes(program, code, ctx, out) {
  const seen = new Set();
  walk(program, (fn) => {
    if (!FN_TYPES.has(fn.type) || !fn.body) return;
    const params = new Set(fn.params.filter((p) => p.type === "Identifier").map((p) => p.name));
    if (params.size === 0) return;
    walk(fn.body, (node) => {
      if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return;
      if (seen.has(node.start)) return;
      const method = node.callee.property.name;
      if (!HTTP_METHODS.has(method)) return;
      const obj = unwrap(node.callee.object);
      if (!obj || obj.type !== "Identifier" || !params.has(obj.name)) return;
      if (ctx.routers.has(obj.name) || ctx.requires.has(obj.name)) return;
      if (node.arguments.length < 2) return;
      const paths = pathsFrom(node.arguments[0], ctx.consts);
      if (paths.some((p) => p === null || !p.startsWith("/"))) return;
      seen.add(node.start);
      const mwSource = node.arguments.slice(1);
      const middlewares = middlewareArgs(mwSource, code, true);
      const handlerNode = terminalHandler(mwSource);
      for (const path of paths) {
        const route = {
          host: obj.name,
          method: method === "all" ? "ALL" : method.toUpperCase(),
          path,
          middlewares,
          line: ctx.lineAt(node.callee.property.start),
        };
        attachIo(route, handlerNode, ctx);
        out.registrarRoutes.push(route);
      }
    });
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
 * @param {(message: string) => void} [onParseError]
 * @returns {object|null} file model, or null if the file doesn't parse.
 */
function analyzeFile(code, filePath, onParseError) {
  const program = parse(code, filePath, onParseError);
  if (!program) return null;
  const { requires, routers } = collectBindings(program);
  const consts = collectStringConsts(program);
  const lineAt = lineCounter(code);
  const handlerIndex = collectHandlerIndex(program);
  const ctx = { requires, routers, consts, lineAt, handlerIndex, filePath };
  const out = {
    filePath,
    requires,
    routers,
    routes: [],
    edges: [],
    registrarRoutes: [],
    globalMwByHost: new Map(),
    handlerIndex,
    lineAt,
  };
  extractRoutes(program, code, ctx, out);
  extractMounts(program, code, ctx, out);
  extractRegistrarRoutes(program, code, ctx, out);
  const { exportRefs, reExportAll } = collectExports(program, ctx);
  out.exportRefs = exportRefs;
  out.reExportAll = reExportAll;
  return out;
}

module.exports = { walk, collectBindings, refFromExpr, analyzeFile };
