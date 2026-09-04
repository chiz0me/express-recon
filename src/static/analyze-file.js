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
const { enrichExpressValidatorSchemas } = require("./validators");
const { STATIC_FRAMEWORK_ADAPTERS } = require("./adapters");
const { collectHandlerJSDoc, collectHandlerTypes, createTypeResolver } = require("./type-evidence");

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
function requireInfo(node, requireAliases = new Set(["require"])) {
  let n = unwrap(node);
  const props = [];
  while (n) {
    if (n.type === "MemberExpression" && !n.computed && n.property.type === "Identifier") {
      props.unshift(n.property.name);
      n = unwrap(n.object);
      continue;
    }
    if (n.type === "CallExpression") {
      if (n.callee.type === "Identifier" && requireAliases.has(n.callee.name)) {
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

/**
 * Collect immutable local aliases of CommonJS `require`. Small bootstrap files
 * sometimes use `const load = require` to make imports terse; treating only
 * explicit aliases as loaders avoids interpreting arbitrary helper calls as
 * module imports.
 */
function collectRequireAliases(program) {
  const aliases = new Set(["require"]);
  let changed = true;
  while (changed) {
    changed = false;
    walk(program, (node) => {
      if (node.type !== "VariableDeclaration" || node.kind !== "const") return;
      for (const declaration of node.declarations) {
        const init = declaration.init && unwrap(declaration.init);
        if (
          declaration.id.type === "Identifier" &&
          init?.type === "Identifier" &&
          aliases.has(init.name) &&
          !aliases.has(declaration.id.name)
        ) {
          aliases.add(declaration.id.name);
          changed = true;
        }
      }
    });
  }
  return aliases;
}

/** Record a module binding (`require`/`import`) as local name -> ref descriptor. */
function addBinding(bindings, local, ref) {
  if (local && ref) bindings.set(local, ref);
}

function collectRequireBinding(node, bindings, requireAliases) {
  const init = node.init && unwrap(node.init);
  if (!init) return;
  if (node.id.type === "Identifier") {
    const info = requireInfo(init, requireAliases);
    if (info) addBinding(bindings, node.id.name, info);
    return;
  }
  if (node.id.type === "ObjectPattern") {
    const info = requireInfo(init, requireAliases);
    if (!info) return;
    for (const prop of node.id.properties) {
      if (prop.key && prop.value && prop.value.type === "Identifier") {
        const propName = prop.key.type === "Identifier" ? prop.key.name : String(prop.key.value);
        addBinding(bindings, prop.value.name, {
          source: info.source,
          exportName: "default",
          props: info.props.concat(propName),
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
    else if (spec.type === "ImportSpecifier") {
      const importedName =
        spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
      addBinding(bindings, spec.local.name, { source, exportName: importedName, props: [] });
    }
  }
}

function boundNamesFromPattern(pattern, out = []) {
  if (!pattern) return out;
  if (pattern.type === "Identifier") {
    out.push(pattern.name);
  } else if (pattern.type === "AssignmentPattern") {
    boundNamesFromPattern(pattern.left, out);
  } else if (pattern.type === "RestElement") {
    boundNamesFromPattern(pattern.argument, out);
  } else if (pattern.type === "ObjectPattern") {
    for (const prop of pattern.properties || []) {
      if (prop.type === "Property") boundNamesFromPattern(prop.value, out);
      else if (prop.type === "RestElement") boundNamesFromPattern(prop.argument, out);
    }
  } else if (pattern.type === "ArrayPattern") {
    for (const elem of pattern.elements || []) {
      if (elem) boundNamesFromPattern(elem, out);
    }
  }
  return out;
}

function enclosingScopeNode(ancestors, program) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (
      a.type === "BlockStatement" ||
      a.type === "FunctionDeclaration" ||
      a.type === "FunctionExpression" ||
      a.type === "ArrowFunctionExpression" ||
      a.type === "StaticBlock" ||
      a.type === "ForStatement" ||
      a.type === "ForInStatement" ||
      a.type === "ForOfStatement" ||
      a.type === "CatchClause" ||
      a.type === "Program"
    ) {
      return a;
    }
  }
  return program;
}

/** `var` belongs to its nearest function/static/program scope, not an enclosing block. */
function enclosingVarScopeNode(ancestors, program) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const ancestor = ancestors[i];
    if (
      ancestor.type === "FunctionDeclaration" ||
      ancestor.type === "FunctionExpression" ||
      ancestor.type === "ArrowFunctionExpression" ||
      ancestor.type === "StaticBlock" ||
      ancestor.type === "Program"
    ) {
      return ancestor;
    }
  }
  return program;
}

/** Assignments execute in their nearest function/static/program context. */
function enclosingExecutionScopeNode(ancestors, program) {
  return enclosingVarScopeNode(ancestors, program);
}

/** Store only source offsets from an AST scope so binding records stay compact. */
function scopeRange(scope) {
  return { start: scope.start, end: scope.end };
}

/**
 * First pass: module bindings + router variables. Recognises `require`/`import`
 * (including factory-call and property forms), the local name bound to express,
 * destructured/imported `Router` factories, and every `express()` (app) /
 * `*.Router()` (router) variable.
 */
function collectBindings(program) {
  const requireAliases = collectRequireAliases(program);
  const bindings = new Map();
  walk(program, (node) => {
    if (node.type === "VariableDeclarator") {
      collectRequireBinding(node, bindings, requireAliases);
    } else if (node.type === "ImportDeclaration") collectImportBinding(node, bindings);
  });

  const expressVars = new Set();
  const factoryNames = new Set();
  for (const [local, { source, exportName }] of bindings) {
    if (source !== "express") continue;
    if (exportName === "default" || exportName === "*") expressVars.add(local);
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
    if (!c) return false;
    if (c.type === "Identifier" && expressVars.has(c.name)) return true;
    const direct = requireInfo(c, requireAliases);
    return Boolean(
      direct &&
      direct.source === "express" &&
      ["default", "*"].includes(direct.exportName) &&
      direct.props.length === 0,
    );
  };

  const routers = new Map();
  const declarations = new Map();
  let nextBindingId = 1;

  /** Test whether two compact lexical-scope records denote the same scope. */
  function sameScope(left, right) {
    return left.start === right.start && left.end === right.end;
  }

  /** Classify the value currently held by a binding. */
  function bindingState(value, eventStart) {
    if (value && isAppInit(value)) return { kind: "app", start: eventStart };
    if (value && isRouterInit(value)) return { kind: "router", start: eventStart };
    const base = value ? routeChainBase(value) : null;
    if (base && base.host.type === "Identifier") {
      return {
        kind: "route",
        host: base.host.name,
        pathNode: base.pathNode,
        allArgs: base.allArgs,
        start: base.start,
      };
    }
    const candidate = value && unwrap(value);
    if (
      candidate &&
      [
        "Identifier",
        "MemberExpression",
        "CallExpression",
        "NewExpression",
        "AwaitExpression",
        "ConditionalExpression",
        "LogicalExpression",
        "SequenceExpression",
      ].includes(candidate.type)
    ) {
      return { kind: "unknown", start: eventStart };
    }
    return { kind: "other", start: eventStart };
  }

  /** Declare a lexical binding and record its initial value as the first state event. */
  function declareBinding(name, state, scope, declarationKind, declaredAt) {
    if (!name) return;
    const list = declarations.get(name) || [];
    const existingVar =
      declarationKind === "var"
        ? list.find(
            (item) =>
              item.isDeclaration && item.declarationKind === "var" && sameScope(item.scope, scope),
          )
        : null;
    list.push({
      ...state,
      scope,
      activeScope: scope,
      bindingId: existingVar?.bindingId || nextBindingId++,
      declarationKind,
      isDeclaration: true,
      eventStart: declaredAt,
    });
    declarations.set(name, list);
  }

  /** Select the innermost lexical declaration visible at a source location. */
  function lexicalBindingAt(name, node) {
    const list = declarations.get(name) || [];
    const byBinding = new Map();
    for (const item of list) {
      if (!item.isDeclaration || item.scope.start > node.start || node.end > item.scope.end)
        continue;
      if (!byBinding.has(item.bindingId)) byBinding.set(item.bindingId, item);
    }
    const candidates = [...byBinding.values()];
    candidates.sort((left, right) => {
      const leftSize = left.scope.end - left.scope.start;
      const rightSize = right.scope.end - right.scope.start;
      if (leftSize !== rightSize) return leftSize - rightSize;
      if (left.scope.start !== right.scope.start) return right.scope.start - left.scope.start;
      return right.eventStart - left.eventStart;
    });
    return candidates[0] || null;
  }

  walk(program, (node, ancestors) => {
    if (node.type === "VariableDeclarator") {
      const declaration = [...ancestors]
        .reverse()
        .find((ancestor) => ancestor.type === "VariableDeclaration");
      const declarationKind = declaration?.kind || "const";
      const scope = scopeRange(
        declarationKind === "var"
          ? enclosingVarScopeNode(ancestors, program)
          : enclosingScopeNode(ancestors, program),
      );
      if (node.id.type === "Identifier") {
        const state = bindingState(node.init, node.start);
        if (state.kind === "app") {
          routers.set(node.id.name, { kind: "app", start: node.start });
        } else if (state.kind === "router") {
          routers.set(node.id.name, { kind: "router", start: node.start });
        }
        declareBinding(node.id.name, state, scope, declarationKind, node.start);
      } else {
        for (const name of boundNamesFromPattern(node.id)) {
          declareBinding(
            name,
            { kind: "other", start: node.start },
            scope,
            declarationKind,
            node.start,
          );
        }
      }
    } else if (node.type === "FunctionDeclaration") {
      if (node.id?.type === "Identifier") {
        const scope = enclosingScopeNode(ancestors, program);
        declareBinding(
          node.id.name,
          { kind: "other", start: node.start },
          scopeRange(scope),
          "function",
          node.start,
        );
      }
      for (const param of node.params || []) {
        for (const name of boundNamesFromPattern(param)) {
          declareBinding(
            name,
            { kind: "other", start: node.start },
            scopeRange(node),
            "parameter",
            node.start,
          );
        }
      }
    } else if (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      for (const param of node.params || []) {
        for (const name of boundNamesFromPattern(param)) {
          declareBinding(
            name,
            { kind: "other", start: node.start },
            scopeRange(node),
            "parameter",
            node.start,
          );
        }
      }
    } else if (node.type === "CatchClause" && node.param) {
      for (const name of boundNamesFromPattern(node.param)) {
        declareBinding(
          name,
          { kind: "other", start: node.start },
          scopeRange(node),
          "catch",
          node.start,
        );
      }
    }
  });

  // Assignments are collected after declarations so each event can attach to
  // the correct lexical binding, including `var` redeclarations and outer
  // bindings mutated from a nested block.
  walk(program, (node, ancestors) => {
    if (
      node.type !== "AssignmentExpression" ||
      node.operator !== "=" ||
      node.left.type !== "Identifier"
    ) {
      return;
    }
    const binding = lexicalBindingAt(node.left.name, node);
    if (!binding) return;
    const state = bindingState(node.right, node.start);
    const list = declarations.get(node.left.name) || [];
    list.push({
      ...state,
      scope: binding.scope,
      activeScope: scopeRange(enclosingExecutionScopeNode(ancestors, program)),
      bindingId: binding.bindingId,
      declarationKind: binding.declarationKind,
      isDeclaration: false,
      eventStart: node.start,
    });
    declarations.set(node.left.name, list);
    if (state.kind === "app" || state.kind === "router") {
      routers.set(node.left.name, { kind: state.kind, start: node.start });
    }
  });

  return {
    requires: bindings,
    routers,
    declarations,
    routeBindings: declarations,
    factoryNames,
    requireAliases,
  };
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

/**
 * Top-level immutable values available to bounded schema/validator
 * interpreters. Function-local values are added while mining that function so
 * identically named bindings in separate handlers cannot contaminate each
 * other.
 */
function collectValueBindings(program) {
  const bindings = new Map();
  for (const statement of program.body || []) {
    const declaration = ["ExportNamedDeclaration", "ExportDefaultDeclaration"].includes(
      statement.type,
    )
      ? statement.declaration
      : statement;
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;
    for (const item of declaration.declarations) {
      if (item.id.type === "Identifier" && item.init) {
        bindings.set(item.id.name, item.init);
      }
    }
  }
  return bindings;
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

  const info = requireInfo(n, ctx.requireAliases);
  if (info)
    return { t: "module", source: info.source, exportName: info.exportName, props: info.props };

  if (n.type === "Identifier") {
    if (ctx.routers.has(n.name)) return { t: "local", name: n.name };
    const b = ctx.requires.get(n.name);
    if (b) return { t: "module", source: b.source, exportName: b.exportName, props: b.props };
    return { t: "local", name: n.name };
  }
  if (n.type === "MemberExpression" && !n.computed && n.property.type === "Identifier") {
    let target = n;
    const props = [];
    while (
      target &&
      target.type === "MemberExpression" &&
      !target.computed &&
      target.property.type === "Identifier"
    ) {
      props.unshift(target.property.name);
      target = unwrap(target.object);
    }
    if (target?.type === "Identifier") {
      const b = ctx.requires.get(target.name);
      if (b) {
        return {
          t: "module",
          source: b.source,
          exportName: b.exportName,
          props: b.props.concat(props),
        };
      }
    }
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
  if (
    n.type === "FunctionDeclaration" ||
    n.type === "FunctionExpression" ||
    n.type === "ArrowFunctionExpression"
  ) {
    const ret = factoryReturnNode(n);
    return {
      t: "factory",
      fnStart: n.start,
      ret: ret ? refFromExpr(ret, ctx) : { t: "unknown" },
    };
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
function mineFn(fn, ctx) {
  const hints = extractIoHints(fn, {
    file: ctx.filePath,
    lineAt: ctx.lineAt,
    bindings: ctx.valueBindings,
    consts: ctx.consts,
    requires: ctx.requires,
    typeResolver: ctx.typeResolver,
    functionType: ctx.handlerTypes.get(fn.start),
    jsdoc: ctx.handlerJSDoc.get(fn.start),
  });
  return {
    ...hints,
    handlerResolved: true,
    handlerSource: { file: ctx.filePath, line: ctx.lineAt(fn.start) },
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
    return {
      io: mineFn(node, ctx),
      handlerRef: null,
      handlerName: null,
    };
  if (node.type === "Identifier") {
    const fn = ctx.handlerIndex.get(node.name);
    const io = fn ? mineFn(fn, ctx) : emptyIo();
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

/** Attach schema evidence from route-level express-validator middleware. */
function attachValidatorSchemas(route, middlewareNodes, ctx) {
  enrichExpressValidatorSchemas(route.io, middlewareNodes, {
    file: ctx.filePath,
    lineAt: ctx.lineAt,
    bindings: ctx.valueBindings,
    consts: ctx.consts,
    requires: ctx.requires,
  });
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

function resolveRouteBinding(name, node, ctx) {
  const decls = ctx?.declarations?.get(name) || ctx?.routeBindings?.get(name);
  if (!decls || decls.length === 0) return null;
  const declarationByBinding = new Map();
  for (const item of decls) {
    const declaration = item.isDeclaration !== false;
    if (!declaration || !item.scope || item.scope.start > node.start || node.end > item.scope.end) {
      continue;
    }
    const bindingId = item.bindingId ?? item;
    const previous = declarationByBinding.get(bindingId);
    if (!previous || (item.eventStart ?? item.start) > (previous.eventStart ?? previous.start)) {
      declarationByBinding.set(bindingId, item);
    }
  }
  const bindings = [...declarationByBinding.values()];
  bindings.sort((left, right) => {
    const leftSize = left.scope.end - left.scope.start;
    const rightSize = right.scope.end - right.scope.start;
    if (leftSize !== rightSize) return leftSize - rightSize;
    if (left.scope.start !== right.scope.start) return right.scope.start - left.scope.start;
    return (right.eventStart ?? right.start) - (left.eventStart ?? left.start);
  });
  const binding = bindings[0];
  if (!binding) return null;

  const bindingId = binding.bindingId ?? binding;
  const states = decls
    .filter((item) => {
      const itemBindingId = item.bindingId ?? item;
      const activeScope = item.activeScope || item.scope;
      return (
        itemBindingId === bindingId &&
        activeScope &&
        activeScope.start <= node.start &&
        node.end <= activeScope.end &&
        (item.eventStart ?? item.start) <= node.start
      );
    })
    .sort((left, right) => (right.eventStart ?? right.start) - (left.eventStart ?? left.start));
  if (states[0]?.kind === "route") return states[0];
  if (states[0]?.kind === "unknown") {
    const priorRoute = states.find((state) => state.kind === "route");
    if (priorRoute) {
      return {
        ...states[0],
        kind: "route",
        host: priorRoute.host,
        pathNode: null,
        allArgs: [],
      };
    }
  }
  return null;
}

/** Resolve the `(host, pathNode)` of an HTTP-method call, or null if not a route. */
function routeTarget(node, ctx) {
  const object = unwrap(node.callee.object);
  if (object.type === "Identifier") {
    const b = resolveRouteBinding(object.name, node, ctx);
    if (b) {
      return {
        host: b.host,
        pathNode: b.pathNode,
        pathArg: false,
        allArgs: b.allArgs || [],
        chainStart: b.start,
      };
    }
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
    if (root) {
      const b = resolveRouteBinding(root, node, ctx);
      if (b) {
        return {
          host: b.host,
          pathNode: b.pathNode,
          pathArg: false,
          allArgs: b.allArgs || [],
          chainStart: b.start,
        };
      }
      return { host: root, pathNode: node.arguments[0], pathArg: true, allArgs: [] };
    }
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
    const target = routeTarget(node, ctx);
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
      attachValidatorSchemas(route, mwSource, ctx);
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
    const info = requireInfo(n, ctx.requireAliases);
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

const OPAQUE_ROUTE_PROVIDER_SIGNAL =
  /agendash|swagger|openapi|graphi?ql|dashboard|adminjs|adminbro|bull.?board|router|routes|route-provider/i;

/**
 * `use()` also attaches ordinary middleware, so treating every unresolved
 * identifier as a hidden router would make nearly every Express app
 * incomplete. Retain only strong route-provider signals for integrations whose
 * routes live behind middleware rather than METHOD() registrations.
 */
function looksLikeOpaqueRouteProvider(item) {
  const ref = item.ref || {};
  return OPAQUE_ROUTE_PROVIDER_SIGNAL.test(
    [item.mw?.name, ref.source, ...(ref.props || [])].filter(Boolean).join(" "),
  );
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
    const opaqueLayers = tagged.filter((item) => {
      if (isMountRef(item.node, item.ref, ctx)) return false;
      const layer = unwrap(item.node);
      return (
        (layer.type === "Identifier" || layer.type === "MemberExpression") &&
        looksLikeOpaqueRouteProvider(item)
      );
    });
    const first = unwrap(node.arguments[0]);
    const ambiguousLeadingPath =
      !hasPath &&
      node.arguments.length > 1 &&
      first &&
      (first.type === "Identifier" || first.type === "MemberExpression");
    if (opaqueLayers.length > 0 && ((refs.length === 0 && hasPath) || ambiguousLeadingPath)) {
      for (const candidatePath of hasPath ? mountPaths : [null]) {
        out.opaqueUses.push({
          host,
          mountPath: candidatePath,
          pathConfidence:
            hasPath && candidatePath !== "<dynamic>"
              ? "full"
              : ambiguousLeadingPath
                ? "unknown"
                : "partial",
          middlewares: opaqueLayers.map((item) => item.mw.name),
          line,
        });
      }
    }
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
const NON_EXPRESS_HOST_PACKAGE =
  /^(?:fastify|uwebsockets(?:\.js)?|uws|koa|@koa\/router|@hapi\/hapi|hapi|hono|polka)(?:\/|$)/i;

/** Root binding of a TypeScript parameter type such as `uWS.TemplatedApp`. */
function parameterTypeBinding(param, ctx) {
  let type = param?.typeAnnotation?.typeAnnotation;
  if (type?.type !== "TSTypeReference") return null;
  let name = type.typeName;
  while (name?.type === "TSQualifiedName") name = name.left;
  return name?.type === "Identifier" ? ctx.requires.get(name.name) || null : null;
}

/**
 * A typed host imported from another HTTP framework is not an Express
 * registrar. The owning adapter can still claim it; this only prevents the
 * generic `app.get()` fallback from creating a second, misleading route.
 */
function isExpressRegistrarParameter(param, ctx) {
  if (param?.type !== "Identifier") return false;
  const binding = parameterTypeBinding(param, ctx);
  return !binding || !NON_EXPRESS_HOST_PACKAGE.test(binding.source);
}

/**
 * Routes registered on a function parameter — the registrar pattern
 * (`module.exports = (app) => { app.get('/x', h) }`). The host can't be
 * resolved from the function alone (it's bound at the call site), so routes are
 * grouped by their owning function for the graph pass to connect when possible.
 * A static `/`-path and at least one handler arg are required, which filters out
 * HTTP-client/ORM `.get(url)` lookalikes.
 */
function extractRegistrarRoutes(program, code, ctx, out) {
  const seen = new Set();
  walk(program, (fn) => {
    if (!FN_TYPES.has(fn.type) || !fn.body) return;
    const params = new Set(
      fn.params
        .filter((param) => isExpressRegistrarParameter(param, ctx))
        .map((param) => param.name),
    );
    if (params.size === 0) return;
    const registrar = {
      id: `${ctx.filePath}#express-registrar:${fn.start}`,
      file: ctx.filePath,
      fnStart: fn.start,
      name:
        fn.id?.name ||
        [...ctx.handlerIndex].find(([, candidate]) => candidate === fn)?.[0] ||
        `<anonymous:${fn.start}>`,
      routes: [],
    };
    const visitOwnBody = (node) => {
      if (!node || typeof node.type !== "string") return;
      if (node !== fn.body && FN_TYPES.has(node.type)) return;
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
          registrarStart: fn.start,
        };
        attachIo(route, handlerNode, ctx);
        attachValidatorSchemas(route, mwSource, ctx);
        out.registrarRoutes.push(route);
        registrar.routes.push(route);
      }
    };
    const descend = (node) => {
      if (!node || typeof node.type !== "string") return;
      visitOwnBody(node);
      if (node !== fn.body && FN_TYPES.has(node.type)) return;
      for (const key of Object.keys(node)) {
        if (["loc", "start", "end"].includes(key)) continue;
        const child = node[key];
        if (Array.isArray(child)) child.forEach(descend);
        else if (child && typeof child.type === "string") descend(child);
      }
    };
    descend(fn.body);
    if (registrar.routes.length) out.registrars.set(fn.start, registrar);
  });
}

/** Record free-function calls that pass a known local Express host. */
function extractRegistrarInvocations(program, ctx, out) {
  walk(program, (node) => {
    if (node.type !== "CallExpression") return;
    const host = node.arguments
      .map(unwrap)
      .find((argument) => argument?.type === "Identifier" && ctx.routers.has(argument.name));
    if (!host) return;
    const callee = unwrap(node.callee);
    if (callee?.type === "MemberExpression") {
      const object = unwrap(callee.object);
      if (object?.type === "Identifier" && object.name === host.name) return;
    }
    const registrarRef = refFromExpr(node.callee, ctx);
    if (!["local", "module", "factory", "object"].includes(registrarRef.t)) return;
    out.registrarInvocations.push({
      host: host.name,
      registrarRef,
      line: ctx.lineAt(node.start),
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
  if (node.declaration?.id?.name && FN_TYPES.has(node.declaration.type)) {
    exportRefs.set(node.declaration.id.name, { t: "local", name: node.declaration.id.name });
  }
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
  const { requires, routers, declarations, routeBindings, requireAliases } =
    collectBindings(program);
  const consts = collectStringConsts(program);
  const valueBindings = collectValueBindings(program);
  const lineAt = lineCounter(code);
  const handlerIndex = collectHandlerIndex(program);
  const handlerJSDoc = collectHandlerJSDoc(program, code);
  const handlerTypes = collectHandlerTypes(program);
  const typeResolver = createTypeResolver(program);
  const ctx = {
    requires,
    routers,
    declarations,
    routeBindings,
    requireAliases,
    consts,
    valueBindings,
    lineAt,
    handlerIndex,
    handlerJSDoc,
    handlerTypes,
    typeResolver,
    filePath,
    attachIo,
  };
  const frameworks = Object.fromEntries(
    STATIC_FRAMEWORK_ADAPTERS.map((adapter) => [adapter.name, adapter.analyze(program, code, ctx)]),
  );
  const out = {
    filePath,
    requires,
    routers,
    routes: [],
    edges: [],
    registrarRoutes: [],
    registrars: new Map(),
    registrarInvocations: [],
    opaqueUses: [],
    globalMwByHost: new Map(),
    handlerIndex,
    handlerJSDoc,
    handlerTypes,
    typeResolver,
    valueBindings,
    consts,
    lineAt,
    frameworks,
  };
  extractRoutes(program, code, ctx, out);
  extractMounts(program, code, ctx, out);
  extractRegistrarRoutes(program, code, ctx, out);
  extractRegistrarInvocations(program, ctx, out);
  const { exportRefs, reExportAll } = collectExports(program, ctx);
  out.exportRefs = exportRefs;
  out.reExportAll = reExportAll;
  return out;
}

module.exports = { walk, collectBindings, refFromExpr, analyzeFile };
