"use strict";

const path = require("node:path");
const { walk, unwrap, calleeName, staticString, middlewareFromArg } = require("./ast");
const {
  addRequestSchema,
  addResponseSchema,
  contract,
  evidence,
  staticValue,
} = require("./schema-evidence");
const { joinPath } = require("../walk");

const ROUTE_METHODS = new Map([
  ["get", "GET"],
  ["head", "HEAD"],
  ["post", "POST"],
  ["put", "PUT"],
  ["delete", "DELETE"],
  ["options", "OPTIONS"],
  ["patch", "PATCH"],
  ["trace", "TRACE"],
  ["all", "ALL"],
]);
const REQUEST_HOOKS = new Set(["onRequest", "preParsing", "preValidation", "preHandler"]);
const FN_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const KNOWN_NO_ROUTE_PLUGINS = new Set([
  "@fastify/compress",
  "@fastify/cookie",
  "@fastify/cors",
  "@fastify/formbody",
  "@fastify/helmet",
  "@fastify/multipart",
  "@fastify/rate-limit",
  "@fastify/sensible",
  "fastify-compress",
  "fastify-cookie",
  "fastify-cors",
  "fastify-formbody",
  "fastify-helmet",
  "fastify-multipart",
  "fastify-rate-limit",
  "fastify-sensible",
]);
/** Remove expression wrappers that do not affect a statically inspected value. */
function unwrapValue(node) {
  let current = unwrap(node);
  while (current && (current.type === "AwaitExpression" || current.type === "ChainExpression")) {
    current = unwrap(current.argument || current.expression);
  }
  return current;
}

function propertyName(property) {
  if (!property || property.computed) return null;
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "Literal") return String(property.key.value);
  return null;
}

function collectObjectBindings(program) {
  const bindings = new Map();
  walk(program, (node) => {
    if (node.type !== "VariableDeclaration" || node.kind !== "const") return;
    for (const declaration of node.declarations) {
      if (declaration.id.type === "Identifier" && declaration.init) {
        const value = unwrapValue(declaration.init);
        if (value?.type === "ObjectExpression") bindings.set(declaration.id.name, value);
      }
    }
  });
  return bindings;
}

function flattenObject(object, bindings, seen = new Set()) {
  if (!object || object.type !== "ObjectExpression" || !bindings) return object;
  if (!object.properties.some((p) => p.type === "SpreadElement")) return object;
  const flatProperties = [];
  let hasUnresolvedSpread = false;
  for (const prop of object.properties) {
    if (prop.type === "SpreadElement") {
      const spread = resolveObject(prop.argument, bindings, new Set(seen));
      if (spread?.type === "ObjectExpression") {
        flatProperties.push(...spread.properties);
        if (spread.hasUnresolvedSpread) hasUnresolvedSpread = true;
      } else {
        hasUnresolvedSpread = true;
        flatProperties.push(prop);
      }
    } else {
      flatProperties.push(prop);
    }
  }
  return { ...object, properties: flatProperties, hasUnresolvedSpread };
}

function resolveObject(node, bindings, seen = new Set()) {
  const value = unwrapValue(node);
  if (!value) return null;
  if (value.type === "ObjectExpression") return flattenObject(value, bindings, seen);
  if (value.type !== "Identifier" || seen.has(value.name)) return null;
  const object = bindings.get(value.name);
  if (!object) return null;
  seen.add(value.name);
  return resolveObject(object, bindings, seen);
}

function objectProperty(object, name) {
  if (!object) return null;
  let hasTrailingSpread = false;
  for (let index = object.properties.length - 1; index >= 0; index--) {
    const property = object.properties[index];
    if (property.type === "SpreadElement") {
      hasTrailingSpread = true;
      continue;
    }
    if (property.type === "Property" && propertyName(property) === name) {
      if (hasTrailingSpread) {
        return { uncertain: true, value: property.value };
      }
      return property.value;
    }
  }
  return hasTrailingSpread ? { uncertain: true, value: null } : null;
}

function propertyValue(prop) {
  return prop && typeof prop === "object" && "uncertain" in prop ? prop.value : prop;
}

function staticValues(node, consts, defaultValue = null) {
  if (!node) return defaultValue === null ? [null] : [defaultValue];
  const value = staticString(node, consts);
  if (value !== null) return [value];
  const unwrapped = unwrapValue(node);
  if (unwrapped?.type === "ArrayExpression") {
    const values = unwrapped.elements.filter(Boolean).map((item) => staticString(item, consts));
    if (values.length && values.every((item) => item !== null)) return values;
  }
  return [null];
}

function stagedDescriptor(node, code, stage) {
  return { ...middlewareFromArg(node, code), stage };
}

function valueDescriptors(node, code, stage) {
  const value = unwrapValue(node);
  if (!value) return [];
  const nodes =
    value.type === "ArrayExpression" ? value.elements.filter(Boolean).map(unwrapValue) : [value];
  return nodes.map((item) => stagedDescriptor(item, code, stage));
}

function routeHooks(options, code, model, node, ctx) {
  const result = [];
  let hasUncertainHook = false;
  for (const name of REQUEST_HOOKS) {
    const value = objectProperty(options, name);
    if (value && typeof value === "object" && value.uncertain) {
      hasUncertainHook = true;
    } else if (value) {
      result.push(...valueDescriptors(value, code, "hook"));
    }
  }
  if (hasUncertainHook || options?.hasUnresolvedSpread) {
    result.push({
      name: "<anonymous>",
      kind: "unknown",
      raw: `uncertain Fastify route options at ${model?.filePath || ""}:${ctx ? ctx.lineAt(node?.start || 0) : 1}`,
      stage: "hook",
    });
    hasUncertainHook = true;
  }
  return { hooks: result, hasUncertainHook };
}

function bindingFrom(ctx, local, source) {
  const binding = ctx.requires.get(local);
  return binding && binding.source === source ? binding : null;
}

function directRequire(node, source) {
  const value = unwrapValue(node);
  return (
    value?.type === "CallExpression" &&
    calleeName(value.callee) === "require" &&
    staticString(value.arguments[0]) === source
  );
}

function fastifyFactory(callee, ctx) {
  const value = unwrapValue(callee);
  if (!value) return false;
  if (value.type === "Identifier") return Boolean(bindingFrom(ctx, value.name, "fastify"));
  if (directRequire(value, "fastify")) return true;
  if (value.type === "MemberExpression" && !value.computed) {
    const root = unwrapValue(value.object);
    return (
      root?.type === "Identifier" &&
      Boolean(bindingFrom(ctx, root.name, "fastify")) &&
      ["default", "fastify"].includes(value.property.name)
    );
  }
  return false;
}

function collectFunctions(program, filePath) {
  const byStart = new Map();
  const byName = new Map();
  const add = (node, name) => {
    const value = unwrapValue(node);
    if (!value || !FN_TYPES.has(value.type)) return null;
    let plugin = byStart.get(value.start);
    if (!plugin) {
      const first = value.params?.[0];
      plugin = {
        id: `${filePath}#fastify-plugin:${value.start}`,
        file: filePath,
        name: name || `<inline:${value.start}>`,
        node: value,
        host: first?.type === "Identifier" ? first.name : null,
        line: null,
        routes: [],
        opaqueRoutes: [],
        hooks: [],
        registrations: [],
        encapsulated: true,
        fastifySignal: false,
      };
      byStart.set(value.start, plugin);
    }
    if (name) {
      plugin.name = name;
      byName.set(name, plugin);
    }
    return plugin;
  };
  walk(program, (node) => {
    if (FN_TYPES.has(node.type)) add(node);
    if (node.type === "FunctionDeclaration") add(node, node.id?.name);
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      add(node.init, node.id.name);
    }
    if (node.type === "ExportDefaultDeclaration") {
      add(node.declaration, node.declaration.id?.name || "default");
    }
  });
  return { byStart, byName, add };
}

function functionReturnNode(fn) {
  if (fn.type === "ArrowFunctionExpression" && fn.expression) return fn.body;
  let found = null;
  const visit = (node) => {
    if (!node || found) return;
    if (node !== fn.body && FN_TYPES.has(node.type)) return;
    if (node.type === "ReturnStatement") {
      found = node.argument || null;
      return;
    }
    for (const key of Object.keys(node)) {
      if (["loc", "start", "end"].includes(key)) continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child.type === "string") visit(child);
    }
  };
  visit(fn.body);
  return found;
}

function collectRoots(program, ctx, filePath) {
  const roots = new Map();
  walk(program, (node) => {
    if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier" || !node.init) return;
    const init = unwrapValue(node.init);
    if (init?.type !== "CallExpression" || !fastifyFactory(init.callee, ctx)) return;
    roots.set(node.id.name, {
      id: `${filePath}#fastify-root:${node.id.name}`,
      file: filePath,
      name: node.id.name,
      line: ctx.lineAt(node.start),
      routes: [],
      opaqueRoutes: [],
      hooks: [],
      registrations: [],
    });
  });
  return roots;
}

function containingPlugin(functions, host, node) {
  let selected = null;
  for (const plugin of functions.byStart.values()) {
    if (
      plugin.host === host &&
      plugin.node.start <= node.start &&
      plugin.node.end >= node.end &&
      (!selected || plugin.node.end - plugin.node.start < selected.node.end - selected.node.start)
    ) {
      selected = plugin;
    }
  }
  return selected;
}

function callOwner(model, object, node) {
  const value = unwrapValue(object);
  if (value?.type !== "Identifier") return null;
  return containingPlugin(model.functions, value.name, node) || model.roots.get(value.name) || null;
}

function expressionRef(node, model, ctx) {
  const value = unwrapValue(node);
  if (!value) return { type: "unknown", label: "unknown" };
  if (FN_TYPES.has(value.type)) {
    const plugin = model.functions.add(value);
    return plugin ? { type: "plugin", id: plugin.id } : { type: "unknown", label: "function" };
  }
  if (value.type === "Identifier") {
    const plugin = model.functions.byName.get(value.name);
    if (plugin) return { type: "plugin", id: plugin.id };
    const valueRef = model.valueRefs?.get(value.name);
    if (valueRef) return valueRef;
    const binding = ctx.requires.get(value.name);
    if (binding) {
      return {
        type: "module",
        source: binding.source,
        exportName: binding.exportName,
        props: binding.props || [],
      };
    }
    return { type: "unknown", label: value.name };
  }
  if (value.type === "MemberExpression" && !value.computed) {
    const root = unwrapValue(value.object);
    if (root?.type === "Identifier") {
      const binding = ctx.requires.get(root.name);
      if (binding) {
        return {
          type: "module",
          source: binding.source,
          exportName: binding.exportName,
          props: [...(binding.props || []), value.property.name],
        };
      }
    }
  }
  if (value.type === "CallExpression") {
    if (calleeName(value.callee) === "require") {
      const source = staticString(value.arguments[0]);
      if (source) return { type: "module", source, exportName: "default", props: [] };
    }
    const callee = unwrapValue(value.callee);
    let wrapper = false;
    if (callee?.type === "Identifier") {
      wrapper = ctx.requires.get(callee.name)?.source === "fastify-plugin";
    } else if (callee?.type === "MemberExpression" && !callee.computed) {
      const root = unwrapValue(callee.object);
      wrapper =
        root?.type === "Identifier" &&
        ctx.requires.get(root.name)?.source === "fastify-plugin" &&
        callee.property.name === "default";
    } else {
      wrapper = directRequire(callee, "fastify-plugin");
    }
    if (wrapper && value.arguments[0]) {
      const options = resolveObject(value.arguments[1], model.objects);
      const encapsulate = unwrapValue(propertyValue(objectProperty(options, "encapsulate")));
      const ref = expressionRef(value.arguments[0], model, ctx);
      if (ref.type === "plugin") {
        const plugin = model.functions.byStart.get(Number(ref.id.split(":").at(-1)));
        if (plugin?.id === ref.id) plugin.fastifySignal = true;
      }
      return encapsulate?.type === "Literal" && encapsulate.value === true
        ? ref
        : { ...ref, unencapsulated: true };
    }
    const factory = expressionRef(value.callee, model, ctx);
    if (["plugin", "module", "factory-call"].includes(factory.type)) {
      return { type: "factory-call", factory };
    }
  }
  if (value.type === "ImportExpression") {
    const source = staticString(value.source, ctx.consts);
    if (source) return { type: "module", source, exportName: "default", props: [] };
  }
  return { type: "unknown", label: calleeName(value) || "dynamic plugin" };
}

function collectValueRefs(program, model, ctx) {
  walk(program, (node) => {
    if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier" || !node.init) return;
    const value = unwrapValue(node.init);
    if (value?.type !== "CallExpression") return;
    const ref = expressionRef(value, model, ctx);
    if (ref.type === "factory-call") model.valueRefs.set(node.id.name, ref);
  });
}

function assignmentExportName(left) {
  const name = calleeName(left);
  if (name === "module.exports" || name === "exports") return "default";
  if (name?.startsWith("exports.") || name?.startsWith("module.exports.")) {
    return name.split(".").at(-1);
  }
  return null;
}

function collectExports(program, model, ctx) {
  const exports = new Map();
  const exportAll = [];
  walk(program, (node) => {
    if (node.type === "AssignmentExpression") {
      const name = assignmentExportName(node.left);
      if (name) exports.set(name, expressionRef(node.right, model, ctx));
    } else if (node.type === "ExportDefaultDeclaration") {
      exports.set("default", expressionRef(node.declaration, model, ctx));
    } else if (node.type === "ExportNamedDeclaration") {
      if (node.declaration?.type === "FunctionDeclaration" && node.declaration.id) {
        exports.set(node.declaration.id.name, expressionRef(node.declaration, model, ctx));
      }
      for (const declaration of node.declaration?.declarations || []) {
        if (declaration.id.type === "Identifier") {
          exports.set(declaration.id.name, expressionRef(declaration.init, model, ctx));
        }
      }
      for (const specifier of node.specifiers || []) {
        if (node.source) {
          exports.set(specifier.exported.name, {
            type: "module",
            source: node.source.value,
            exportName: specifier.local.name,
            props: [],
          });
        } else {
          exports.set(specifier.exported.name, expressionRef(specifier.local, model, ctx));
        }
      }
    } else if (node.type === "ExportAllDeclaration" && !node.exported) {
      exportAll.push(node.source.value);
    }
  });
  return { exports, exportAll };
}

function methodsFrom(node, consts) {
  return staticValues(node, consts)
    .flatMap((value) => (value === null ? [] : String(value).split(",")))
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value && [...ROUTE_METHODS.values()].includes(value));
}

/** Fold Fastify's static route `schema` option into the common I/O contract. */
function applyFastifySchema(io, schemaNode, ctx) {
  if (!schemaNode) return;
  const value = staticValue(schemaNode, {
    bindings: ctx.valueBindings,
    consts: ctx.consts,
  });
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const source = { file: ctx.filePath, line: ctx.lineAt(schemaNode.start) };
  const requestKeys = new Map([
    ["body", "body"],
    ["querystring", "query"],
    ["query", "query"],
    ["params", "params"],
    ["headers", "headers"],
  ]);
  for (const [key, bucket] of requestKeys) {
    const schema = value[key];
    if (schema && typeof schema === "object" && !Array.isArray(schema)) {
      addRequestSchema(io, bucket, contract(schema, evidence("fastify-schema", "high", source)));
    }
  }
  const responses = value.response;
  if (!responses || typeof responses !== "object" || Array.isArray(responses)) return;
  for (const [rawStatus, schema] of Object.entries(responses)) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) continue;
    const status = /^\d{3}$/.test(rawStatus) ? Number(rawStatus) : null;
    addResponseSchema(io, status, contract(schema, evidence("fastify-schema", "high", source)));
  }
}

function addRoute(
  owner,
  method,
  pathNode,
  options,
  handler,
  node,
  code,
  ctx,
  model,
  dynamicOptions,
) {
  const paths = staticValues(pathNode, ctx.consts);
  const hookInfo = routeHooks(options, code, model, node, ctx);
  const isDynamic =
    dynamicOptions || hookInfo.hasUncertainHook || Boolean(options?.hasUnresolvedSpread);
  for (const routePath of paths) {
    const route = {
      method,
      path: routePath,
      middlewares: dynamicOptions
        ? [
            {
              name: "<anonymous>",
              kind: "unknown",
              raw: `dynamic Fastify route options at ${model.filePath}:${ctx.lineAt(node.start)}`,
              stage: "hook",
            },
          ]
        : hookInfo.hooks,
      line: ctx.lineAt(node.callee?.property?.start ?? node.start),
    };
    ctx.attachIo(route, handler, ctx);
    const schemaProp = objectProperty(options, "schema");
    const schemaNode =
      schemaProp && typeof schemaProp === "object" && schemaProp.uncertain ? null : schemaProp;
    applyFastifySchema(route.io, schemaNode, ctx);
    owner.routes.push(route);
    if (isDynamic) {
      owner.opaqueRoutes.push({
        paths: [routePath],
        line: ctx.lineAt(node.start),
      });
    }
  }
  model.routeCallStarts.add(node.start);
}

function extractShorthand(node, owner, method, model, code, ctx) {
  if (!node.arguments.length) return;
  const options = resolveObject(node.arguments[1], model.objects);
  const hasOptionsArgument = node.arguments.length >= 3;
  const handler = options
    ? node.arguments[2] || propertyValue(objectProperty(options, "handler"))
    : hasOptionsArgument
      ? node.arguments[2]
      : node.arguments[1];
  addRoute(
    owner,
    method,
    node.arguments[0],
    options,
    handler,
    node,
    code,
    ctx,
    model,
    hasOptionsArgument && !options,
  );
}

function extractFullRoute(node, owner, model, code, ctx) {
  const options = resolveObject(node.arguments[0], model.objects);
  if (!options) {
    owner.opaqueRoutes.push({ paths: [null], line: ctx.lineAt(node.start) });
    return;
  }
  const methods = methodsFrom(propertyValue(objectProperty(options, "method")), ctx.consts);
  if (!methods.length) {
    const pathNode = propertyValue(
      objectProperty(options, "url") || objectProperty(options, "path"),
    );
    owner.opaqueRoutes.push({
      paths: staticValues(pathNode, ctx.consts),
      line: ctx.lineAt(node.start),
    });
    return;
  }
  const pathNode = propertyValue(objectProperty(options, "url") || objectProperty(options, "path"));
  const handler = propertyValue(objectProperty(options, "handler"));
  for (const method of methods) {
    addRoute(
      owner,
      method,
      pathNode,
      options,
      handler,
      node,
      code,
      ctx,
      model,
      options.hasUnresolvedSpread,
    );
  }
}

function extractCalls(program, model, code, ctx) {
  walk(program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return;
    const property = node.callee.computed ? null : node.callee.property.name;
    if (!property) return;
    const owner = callOwner(model, node.callee.object, node);
    if (!owner) return;
    if (ROUTE_METHODS.has(property)) {
      extractShorthand(node, owner, ROUTE_METHODS.get(property), model, code, ctx);
      return;
    }
    if (property === "route") {
      // `.route()` is shared by browser automation and many unrelated APIs.
      // A local Fastify root or a plugin reached through register()/a direct
      // server invocation is sufficient evidence; the method alone must not
      // turn `page.route()` into an opaque Fastify registration.
      extractFullRoute(node, owner, model, code, ctx);
      return;
    }
    if (property === "addHook") {
      owner.fastifySignal = true;
      const hook = staticString(node.arguments[0], ctx.consts);
      if (REQUEST_HOOKS.has(hook)) {
        owner.hooks.push(
          ...valueDescriptors(node.arguments[1], code, "hook").map((middleware) => ({
            middleware,
            line: ctx.lineAt(node.start),
          })),
        );
      } else if (hook === null) {
        owner.hooks.push({
          middleware: {
            name: "<anonymous>",
            kind: "unknown",
            raw: `dynamic Fastify hook at ${model.filePath}:${ctx.lineAt(node.start)}`,
            stage: "hook",
          },
          line: ctx.lineAt(node.start),
        });
        model.diagnostics.push(
          `Fastify hook name at ${model.filePath}:${ctx.lineAt(node.start)} is dynamic and requires runtime confirmation`,
        );
      }
      return;
    }
    if (property === "register") {
      owner.fastifySignal = true;
      const options = resolveObject(node.arguments[1], model.objects);
      const prefixProp = objectProperty(options, "prefix");
      const prefixNode = propertyValue(prefixProp);
      const uncertain = Boolean(
        prefixProp?.uncertain ||
        (options?.hasUnresolvedSpread && !prefixProp) ||
        (!options && node.arguments[1]),
      );
      const prefixes =
        !options && node.arguments[1]
          ? [null]
          : prefixNode
            ? staticValues(prefixNode, ctx.consts)
            : [""];
      owner.registrations.push({
        ref: expressionRef(node.arguments[0], model, ctx),
        prefixes,
        uncertain,
        line: ctx.lineAt(node.start),
      });
    }
  });
}

function invocationOwner(model, argument, node) {
  const value = unwrapValue(argument);
  if (value?.type !== "Identifier") return null;
  return containingPlugin(model.functions, value.name, node) || model.roots.get(value.name) || null;
}

/**
 * Connect factory/registrar calls that receive a Fastify instance directly:
 * `configure(server)` and `require('./configure')(server)`. These functions
 * mutate the same instance rather than creating an encapsulated `register()`
 * scope, so the graph records them as transparent, prefix-free registrations.
 */
function collectDirectInvocations(program, model, ctx) {
  const seen = new Set();
  walk(program, (node) => {
    if (node.type !== "CallExpression" || seen.has(node.start)) return;
    const ref = expressionRef(node.callee, model, ctx);
    if (!ref || ref.type === "unknown") return;
    const owner = node.arguments
      .map((argument) => invocationOwner(model, argument, node))
      .find(Boolean);
    if (!owner) return;
    // A root method such as `server.register(plugin)` is already represented
    // by extractCalls; only free/local/module function calls belong here.
    const callee = unwrapValue(node.callee);
    if (
      callee?.type === "MemberExpression" &&
      invocationOwner(model, callee.object, node) === owner
    ) {
      return;
    }
    seen.add(node.start);
    owner.registrations.push({
      ref,
      prefixes: [""],
      line: ctx.lineAt(node.start),
      direct: true,
      argumentRefs: node.arguments.map((argument) => expressionRef(argument, model, ctx)),
    });
  });
}

/** Analyze one parsed source file for Fastify roots, plugins, routes, and request hooks. */
function analyzeFastify(program, code, ctx) {
  const functions = collectFunctions(program, ctx.filePath);
  for (const plugin of functions.byStart.values()) plugin.line = ctx.lineAt(plugin.node.start);
  const model = {
    filePath: ctx.filePath,
    functions,
    roots: collectRoots(program, ctx, ctx.filePath),
    objects: collectObjectBindings(program),
    valueRefs: new Map(),
    routeCallStarts: new Set(),
    diagnostics: [],
  };
  collectValueRefs(program, model, ctx);
  for (const plugin of model.functions.byStart.values()) {
    const returned = functionReturnNode(plugin.node);
    plugin.returnRef = returned ? expressionRef(returned, model, ctx) : null;
  }
  extractCalls(program, model, code, ctx);
  collectDirectInvocations(program, model, ctx);
  const exported = collectExports(program, model, ctx);
  model.exports = exported.exports;
  model.exportAll = exported.exportAll;
  return model;
}

function moduleExportRef(file, ref) {
  let exportName = ref.exportName;
  const props = [...(ref.props || [])];
  if (exportName === "*" && props.length) exportName = props.shift();
  if (exportName === "default" && props.length) exportName = props.shift();
  return { file, exportName, props };
}

function resolvePluginRef(fromFile, ref, models, resolve, seen = new Set()) {
  if (!ref) return null;
  if (ref.type === "factory-call") {
    const factory = resolvePluginRef(fromFile, ref.factory, models, resolve, seen);
    return factory?.returnRef
      ? resolvePluginRef(factory.file, factory.returnRef, models, resolve, seen)
      : null;
  }
  if (ref.type === "plugin") {
    const plugin = pluginById(models, ref.id);
    return plugin && ref.unencapsulated ? { ...plugin, encapsulated: false } : plugin;
  }
  if (ref.type !== "module") return null;
  const target = resolve(fromFile, ref.source);
  const targetModel = target && models.get(target);
  if (!targetModel) return null;
  const normalized = moduleExportRef(target, ref);
  const key = `${normalized.file}\0${normalized.exportName}\0${normalized.props.join(".")}`;
  if (seen.has(key)) return null;
  seen.add(key);
  let next = targetModel.exports.get(normalized.exportName);
  if (!next) {
    for (const source of targetModel.exportAll) {
      const found = resolvePluginRef(
        target,
        { type: "module", source, exportName: normalized.exportName, props: normalized.props },
        models,
        resolve,
        seen,
      );
      if (found) return found;
    }
    return null;
  }
  if (normalized.props.length) {
    if (next.type !== "module") return null;
    next = { ...next, props: [...(next.props || []), ...normalized.props] };
  }
  const plugin = resolvePluginRef(target, next, models, resolve, seen);
  return plugin && (ref.unencapsulated || next.unencapsulated)
    ? { ...plugin, encapsulated: false }
    : plugin;
}

function pluginById(models, id) {
  for (const model of models.values()) {
    for (const plugin of model.functions.byStart.values()) if (plugin.id === id) return plugin;
  }
  return null;
}

function parameterBindings(plugin, argumentRefs) {
  const bindings = new Map();
  for (const [index, parameter] of (plugin.node?.params || []).entries()) {
    if (parameter.type === "Identifier" && argumentRefs[index]) {
      bindings.set(parameter.name, argumentRefs[index]);
    }
  }
  return bindings;
}

function substituteParameterRef(ref, bindings) {
  if (ref?.type === "unknown" && bindings.has(ref.label)) return bindings.get(ref.label);
  if (ref?.type === "factory-call") {
    return { ...ref, factory: substituteParameterRef(ref.factory, bindings) };
  }
  return ref;
}

/** Bind a directly invoked registrar's parameters to refs from its call site. */
function bindDirectArguments(plugin, argumentRefs) {
  const bindings = parameterBindings(plugin, argumentRefs || []);
  if (!bindings.size) return plugin;
  return {
    ...plugin,
    registrations: plugin.registrations.map((registration) => ({
      ...registration,
      ref: substituteParameterRef(registration.ref, bindings),
      ...(registration.argumentRefs
        ? {
            argumentRefs: registration.argumentRefs.map((ref) =>
              substituteParameterRef(ref, bindings),
            ),
          }
        : {}),
    })),
  };
}

function fastifyApplicationId(root, application) {
  const relative = path.relative(root, application.file).split(path.sep).join("/");
  return `fastify:${relative}#${application.name}`;
}

function registrationTarget(scope, registration, context) {
  let target;
  if (registration.ref.type === "plugin") {
    const plugin = pluginById(context.models, registration.ref.id);
    target =
      plugin && registration.ref.unencapsulated ? { ...plugin, encapsulated: false } : plugin;
  } else {
    target = resolvePluginRef(scope.file, registration.ref, context.models, context.resolve);
  }
  return target && registration.direct
    ? {
        ...bindDirectArguments(target, registration.argumentRefs),
        encapsulated: false,
      }
    : target;
}

function registrationSource(ref) {
  if (!ref) return null;
  if (ref.type === "module") return ref.source;
  if (ref.type === "factory-call") return registrationSource(ref.factory);
  return null;
}

function knownNoRouteRegistration(ref) {
  return KNOWN_NO_ROUTE_PLUGINS.has(registrationSource(ref));
}

function leakingHooks(scope, context, stack = new Set()) {
  if (stack.has(scope.id)) return [];
  const nextStack = new Set(stack).add(scope.id);
  const hooks = scope.hooks.map((entry) => entry.middleware);
  for (const registration of scope.registrations) {
    const target = registrationTarget(scope, registration, context);
    if (target && target.encapsulated === false) {
      hooks.push(...leakingHooks(target, context, nextStack));
    }
  }
  return hooks;
}

function middlewareBefore(scope, line, inherited, context, stack) {
  const result = inherited.concat(
    scope.hooks.filter((entry) => entry.line <= line).map((entry) => entry.middleware),
  );
  for (const registration of scope.registrations) {
    if (registration.line > line) continue;
    const target = registrationTarget(scope, registration, context);
    if (target && target.encapsulated === false && !stack.has(target.id)) {
      result.push(...leakingHooks(target, context, stack));
    }
  }
  return result;
}

function emitRoutes(scope, prefix, inherited, partial, applicationId, context, stack) {
  context.assigned.add(scope.id);
  for (const route of scope.routes) {
    const dynamic = route.path === null;
    const own = middlewareBefore(scope, route.line, inherited, context, stack);
    const emitted = {
      framework: "fastify",
      applicationId,
      method: route.method,
      path: joinPath(prefix, dynamic ? "<dynamic>" : route.path),
      middlewares: own.concat(route.middlewares),
      source: { file: scope.file, line: route.line },
      pathConfidence: partial || dynamic ? "partial" : "full",
      ...(route.io ? { io: route.io } : {}),
    };
    const key = `${applicationId || "<unresolved>"}\0${emitted.method}\0${emitted.path}\0${emitted.source.file}:${emitted.source.line}`;
    if (!context.routeSeen.has(key)) {
      context.routeSeen.add(key);
      context.routes.push(emitted);
    }
  }
  for (const route of scope.opaqueRoutes) {
    for (const routePath of route.paths) {
      const dynamic = routePath === null;
      context.opaqueMounts.push({
        applicationId,
        path: dynamic ? null : joinPath(prefix, routePath) || "/",
        pathConfidence: dynamic ? "unknown" : partial ? "partial" : "full",
        middlewares: ["route:<dynamic>"],
        source: { file: scope.file, line: route.line },
      });
    }
  }
  for (const registration of scope.registrations) {
    const target = registrationTarget(scope, registration, context);
    if (!target) {
      if (knownNoRouteRegistration(registration.ref)) continue;
      const label =
        registration.ref.source ||
        registration.ref.label ||
        registration.ref.exportName ||
        "plugin";
      for (const registeredPrefix of registration.prefixes) {
        context.opaqueMounts.push({
          applicationId,
          path: registeredPrefix === null ? null : joinPath(prefix, registeredPrefix) || "/",
          pathConfidence: "unknown",
          middlewares: [`${registration.direct ? "invoke" : "register"}:${label}`],
          source: { file: scope.file, line: registration.line },
        });
      }
      continue;
    }
    if (stack.has(target.id)) continue;
    const own = middlewareBefore(scope, registration.line, inherited, context, stack);
    const prefixes = target.encapsulated === false ? [""] : registration.prefixes;
    if (
      !registration.direct &&
      target.encapsulated === false &&
      registration.prefixes.some((registeredPrefix) => registeredPrefix)
    ) {
      const warning = `${scope.file}:${registration.line}`;
      if (!context.prefixWarnings.has(warning)) {
        context.prefixWarnings.add(warning);
        context.diagnostics.push(
          `Fastify register() prefix at ${warning} is ignored because the plugin is wrapped with fastify-plugin`,
        );
      }
    }
    if (registration.uncertain) {
      const label =
        registration.ref.source ||
        registration.ref.label ||
        registration.ref.exportName ||
        "plugin";
      for (const registeredPrefix of prefixes) {
        context.opaqueMounts.push({
          applicationId,
          path: registeredPrefix === null ? null : joinPath(prefix, registeredPrefix) || "/",
          pathConfidence: "partial",
          middlewares: [`${registration.direct ? "invoke" : "register"}:${label}`],
          source: { file: scope.file, line: registration.line },
        });
      }
    }
    for (const registeredPrefix of prefixes) {
      const dynamic = registeredPrefix === null;
      const childPrefix = joinPath(prefix, dynamic ? "<dynamic>" : registeredPrefix);
      emitRoutes(
        target,
        childPrefix,
        own,
        partial || dynamic || registration.uncertain,
        applicationId,
        context,
        new Set(stack).add(target.id),
      );
    }
  }
}

/** Build a framework-neutral route registry from all Fastify file models. */
function buildFastifyRegistry(files, resolve, root, options = {}) {
  const models = new Map(files.map((file) => [file.filePath, file.frameworks.fastify]));
  const routes = [];
  const applications = [];
  const globalMiddleware = [];
  const opaqueMounts = [];
  const assigned = new Set();
  const routeSeen = new Set();
  const diagnostics = files.flatMap((file) => file.frameworks.fastify.diagnostics);
  const claimedExpressRegistrarSites =
    options.claimedExpressRegistrarSites instanceof Set
      ? options.claimedExpressRegistrarSites
      : new Set();
  for (const model of models.values()) {
    for (const application of model.roots.values()) {
      const id = fastifyApplicationId(root, application);
      const before = routes.length;
      const context = {
        routes,
        opaqueMounts,
        models,
        resolve,
        assigned,
        diagnostics,
        prefixWarnings: new Set(),
        routeSeen,
      };
      emitRoutes(application, "", [], false, id, context, new Set([application.id]));
      const applicationMiddleware = middlewareBefore(
        application,
        Number.POSITIVE_INFINITY,
        [],
        context,
        new Set([application.id]),
      );
      applications.push({
        id,
        name: `${path.relative(root, application.file).split(path.sep).join("/")}#${application.name}`,
        framework: "fastify",
        adapter: "fastify",
        source: { file: application.file, line: application.line },
        routeCount: routes.length - before,
        globalMiddleware: applicationMiddleware,
      });
      globalMiddleware.push(...applicationMiddleware);
    }
  }
  const beforeOrphans = routes.length;
  for (const model of models.values()) {
    for (const plugin of model.functions.byStart.values()) {
      const unclaimedRoutes = plugin.routes.filter(
        (route) =>
          !claimedExpressRegistrarSites.has(`${plugin.file}\0${route.line || 0}\0${route.method}`),
      );
      const conventionalPlugin =
        plugin.fastifySignal ||
        /plugin$/i.test(plugin.name) ||
        /^(fastify|server|instance)$/i.test(plugin.host || "");
      if (
        assigned.has(plugin.id) ||
        !conventionalPlugin ||
        (!unclaimedRoutes.length && !plugin.opaqueRoutes.length && !plugin.registrations.length)
      )
        continue;
      const orphanPlugin =
        unclaimedRoutes.length === plugin.routes.length
          ? plugin
          : { ...plugin, routes: unclaimedRoutes };
      emitRoutes(
        orphanPlugin,
        "",
        [],
        true,
        null,
        {
          routes,
          opaqueMounts,
          models,
          resolve,
          assigned,
          diagnostics,
          prefixWarnings: new Set(),
          routeSeen,
        },
        new Set([plugin.id]),
      );
    }
  }
  const orphanRoutes = routes.length - beforeOrphans;
  if (orphanRoutes) {
    diagnostics.push(
      `${orphanRoutes} Fastify plugin route(s) were not registered on a local application and ` +
        "were emitted with an unknown path prefix.",
    );
  }
  if (opaqueMounts.length) {
    diagnostics.push(
      `${opaqueMounts.length} opaque Fastify registration(s) may add routes; route coverage is incomplete.`,
    );
  }
  return { routes, applications, globalMiddleware, diagnostics, opaqueMounts, orphanRoutes };
}

module.exports = { analyzeFastify, buildFastifyRegistry };
