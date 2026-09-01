"use strict";

const path = require("node:path");
const { walk, unwrap, calleeName, staticString, snippet, middlewareFromArg } = require("./ast");
const { extractIoHints } = require("./io-hints");
const { joinPath } = require("../walk");

const COMMON = "@nestjs/common";
const CORE = "@nestjs/core";
const ROUTE_DECORATORS = new Map([
  ["Get", "GET"],
  ["Post", "POST"],
  ["Put", "PUT"],
  ["Patch", "PATCH"],
  ["Delete", "DELETE"],
  ["Options", "OPTIONS"],
  ["Head", "HEAD"],
  ["All", "ALL"],
]);
const LIFECYCLE_DECORATORS = new Map([
  ["UseGuards", "guard"],
  ["UseInterceptors", "interceptor"],
  ["UsePipes", "pipe"],
  ["UseFilters", "filter"],
]);
const GLOBAL_METHODS = new Map([
  ["useGlobalGuards", "guard"],
  ["useGlobalInterceptors", "interceptor"],
  ["useGlobalPipes", "pipe"],
  ["useGlobalFilters", "filter"],
  ["use", "middleware"],
]);
const APP_PROVIDER_STAGES = new Map([
  ["APP_GUARD", "guard"],
  ["APP_INTERCEPTOR", "interceptor"],
  ["APP_PIPE", "pipe"],
  ["APP_FILTER", "filter"],
]);
const PARAMETER_DECORATORS = new Map([
  ["Body", "body"],
  ["Query", "query"],
  ["Param", "params"],
  ["Headers", "headers"],
]);
const HTTP_STATUS = new Map([
  ["OK", 200],
  ["CREATED", 201],
  ["ACCEPTED", 202],
  ["NO_CONTENT", 204],
  ["MOVED_PERMANENTLY", 301],
  ["FOUND", 302],
  ["BAD_REQUEST", 400],
  ["UNAUTHORIZED", 401],
  ["FORBIDDEN", 403],
  ["NOT_FOUND", 404],
  ["CONFLICT", 409],
  ["UNPROCESSABLE_ENTITY", 422],
  ["TOO_MANY_REQUESTS", 429],
  ["INTERNAL_SERVER_ERROR", 500],
  ["NOT_IMPLEMENTED", 501],
  ["BAD_GATEWAY", 502],
  ["SERVICE_UNAVAILABLE", 503],
]);

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
  const result = new Map();
  walk(program, (node) => {
    if (node.type !== "VariableDeclaration" || node.kind !== "const") return;
    for (const declaration of node.declarations) {
      if (declaration.id.type !== "Identifier" || !declaration.init) continue;
      const value = unwrapValue(declaration.init);
      if (value?.type === "ObjectExpression") result.set(declaration.id.name, value);
    }
  });
  return result;
}

function resolveObject(node, objects, seen = new Set()) {
  const value = unwrapValue(node);
  if (!value) return null;
  if (value.type === "ObjectExpression") return value;
  if (value.type !== "Identifier" || seen.has(value.name)) return null;
  const object = objects.get(value.name);
  if (!object) return null;
  seen.add(value.name);
  return resolveObject(object, objects, seen);
}

function objectProperty(object, name) {
  if (!object) return null;
  for (let index = object.properties.length - 1; index >= 0; index--) {
    const property = object.properties[index];
    if (property.type === "Property" && propertyName(property) === name) return property.value;
  }
  return null;
}

function arrayElements(node) {
  const value = unwrapValue(node);
  if (!value) return [];
  return value.type === "ArrayExpression" ? value.elements.filter(Boolean) : [value];
}

function staticPaths(node, consts, fallback = "") {
  if (!node) return [fallback];
  const value = staticString(node, consts);
  if (value !== null) return [value];
  const values = arrayElements(node).map((item) => staticString(item, consts));
  if (values.length && values.every((item) => item !== null)) return values;
  return [null];
}

function importedName(node, ctx, source) {
  const value = unwrapValue(node);
  if (!value) return null;
  if (value.type === "Identifier") {
    const binding = ctx.requires.get(value.name);
    if (!binding || binding.source !== source) return null;
    if (["default", "*"].includes(binding.exportName)) return value.name;
    return binding.exportName;
  }
  if (value.type === "MemberExpression" && !value.computed) {
    const root = unwrapValue(value.object);
    if (root?.type !== "Identifier") return null;
    const binding = ctx.requires.get(root.name);
    if (!binding || binding.source !== source) return null;
    return value.property.name;
  }
  return null;
}

function decoratorCall(decorator, ctx, source) {
  const expression = unwrapValue(decorator?.expression);
  if (!expression) return null;
  if (expression.type === "CallExpression") {
    const name = importedName(expression.callee, ctx, source);
    return name ? { name, arguments: expression.arguments, node: expression } : null;
  }
  const name = importedName(expression, ctx, source);
  return name ? { name, arguments: [], node: expression } : null;
}

function findDecorator(node, ctx, source, names) {
  for (const decorator of node.decorators || []) {
    const call = decoratorCall(decorator, ctx, source);
    if (call && names.has(call.name)) return call;
  }
  return null;
}

function descriptorFor(node, code, stage) {
  const value = unwrapValue(node);
  if (value?.type === "NewExpression") {
    const name = calleeName(value.callee) || "<anonymous>";
    return { name, kind: "call", raw: snippet(code, value), stage };
  }
  return { ...middlewareFromArg(value, code), stage };
}

function lifecycleDescriptors(node, code, ctx) {
  const result = [];
  for (const decorator of node.decorators || []) {
    const call = decoratorCall(decorator, ctx, COMMON);
    const stage = call && LIFECYCLE_DECORATORS.get(call.name);
    if (!stage) continue;
    result.push(...call.arguments.map((argument) => descriptorFor(argument, code, stage)));
  }
  return result;
}

function expressionRef(node, model, ctx) {
  const value = unwrapValue(node);
  if (!value) return { type: "unknown" };
  // `export default class AppModule {}` exposes the declaration node rather
  // than an Identifier. The class was indexed during the first pass, so retain
  // the local reference and let an importing NestFactory root resolve it.
  if (value.type === "ClassDeclaration" && value.id && model.classes.has(value.id.name)) {
    return { type: "local", name: value.id.name };
  }
  if (value.type === "Identifier") {
    if (model.classes.has(value.name)) return { type: "local", name: value.name };
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
    const name = importedName(value.callee, ctx, COMMON);
    if (name === "forwardRef") {
      const callback = unwrapValue(value.arguments[0]);
      if (callback?.type === "ArrowFunctionExpression" && callback.expression) {
        return expressionRef(callback.body, model, ctx);
      }
      if (callback?.body?.type === "BlockStatement") {
        const returned = callback.body.body.find((item) => item.type === "ReturnStatement");
        if (returned?.argument) return expressionRef(returned.argument, model, ctx);
      }
    }
    if (value.callee.type === "MemberExpression" && !value.callee.computed) {
      return expressionRef(value.callee.object, model, ctx);
    }
  }
  return { type: "unknown", label: calleeName(value) || "dynamic reference" };
}

function controllerPaths(call, model, ctx) {
  const argument = call.arguments[0];
  const object = resolveObject(argument, model.objects);
  return object
    ? staticPaths(objectProperty(object, "path"), ctx.consts, "")
    : staticPaths(argument, ctx.consts, "");
}

function statusCode(node, ctx) {
  const call = findDecorator(node, ctx, COMMON, new Set(["HttpCode"]));
  const argument = unwrapValue(call?.arguments[0]);
  if (argument?.type === "Literal" && Number.isInteger(argument.value)) return argument.value;
  if (argument?.type === "MemberExpression" && !argument.computed) {
    const root = unwrapValue(argument.object);
    if (root && importedName(root, ctx, COMMON) === "HttpStatus") {
      return HTTP_STATUS.get(argument.property.name) || null;
    }
  }
  return null;
}

function objectKeys(node) {
  const value = unwrapValue(node);
  if (value?.type !== "ObjectExpression") return null;
  const keys = [];
  for (const property of value.properties) {
    const name = property.type === "Property" ? propertyName(property) : null;
    if (name !== null) keys.push(name);
  }
  return keys;
}

function returnKeys(fn) {
  if (!fn?.body) return null;
  if (fn.expression) return objectKeys(fn.body);
  let found = null;
  for (const statement of fn.body.body || []) {
    if (statement.type === "ReturnStatement") {
      found = objectKeys(statement.argument);
      break;
    }
  }
  return found;
}

function parameterHints(fn, ctx) {
  const request = { body: new Set(), query: new Set(), params: new Set(), headers: new Set() };
  for (const parameter of fn?.params || []) {
    for (const decorator of parameter.decorators || []) {
      const call = decoratorCall(decorator, ctx, COMMON);
      const bucket = call && PARAMETER_DECORATORS.get(call.name);
      if (!bucket) continue;
      const key = staticString(call.arguments[0], ctx.consts);
      if (key !== null) request[bucket].add(key);
    }
  }
  return Object.fromEntries(
    Object.entries(request).map(([key, values]) => [key, [...values].sort()]),
  );
}

function nativeHandlerIo(fn, ctx) {
  const first = fn?.params?.[0];
  const second = fn?.params?.[1];
  const firstNames = new Set(
    (first?.decorators || [])
      .map((decorator) => decoratorCall(decorator, ctx, COMMON)?.name)
      .filter(Boolean),
  );
  const secondNames = new Set(
    (second?.decorators || [])
      .map((decorator) => decoratorCall(decorator, ctx, COMMON)?.name)
      .filter(Boolean),
  );
  return firstNames.has("Req") && secondNames.has("Res") ? extractIoHints(fn) : null;
}

function nestIo(method, httpMethod, ctx, className) {
  const fn = method.value;
  const native = nativeHandlerIo(fn, ctx);
  const request = parameterHints(fn, ctx);
  if (native) {
    for (const key of Object.keys(request)) {
      request[key] = [...new Set([...request[key], ...native.request[key]])].sort();
    }
  }
  const explicit = statusCode(method, ctx);
  const status = explicit || (httpMethod === "POST" ? 201 : 200);
  const keys = returnKeys(fn);
  return {
    request,
    responses: native?.responses?.length
      ? native.responses
      : keys
        ? [{ status, bodyKeys: keys }]
        : [],
    statusCodes: [...new Set([...(native?.statusCodes || []), status])].sort((a, b) => a - b),
    handlerResolved: true,
    handlerName: `${className}.${method.key?.name || "handler"}`,
    handlerSource: { file: ctx.filePath, line: ctx.lineAt(method.value?.start || method.start) },
  };
}

function collectController(node, call, model, code, ctx) {
  const metadata = resolveObject(call.arguments[0], model.objects);
  const hostOrVersioned = Boolean(
    metadata && (objectProperty(metadata, "host") || objectProperty(metadata, "version")),
  );
  if (hostOrVersioned) {
    model.diagnostics.push(
      `NestJS controller host/version routing for ${node.id.name} in ${ctx.filePath} requires runtime confirmation`,
    );
  }
  const controller = {
    kind: "controller",
    id: `${ctx.filePath}#nestjs-controller:${node.id.name}`,
    file: ctx.filePath,
    name: node.id.name,
    line: ctx.lineAt(node.start),
    paths: controllerPaths(call, model, ctx),
    partial: hostOrVersioned,
    middlewares: lifecycleDescriptors(node, code, ctx),
    routes: [],
  };
  for (const method of node.body.body || []) {
    if (method.type !== "MethodDefinition" || !method.value) continue;
    let routeCall = null;
    let httpMethod = null;
    for (const decorator of method.decorators || []) {
      const callValue = decoratorCall(decorator, ctx, COMMON);
      const candidate = callValue && ROUTE_DECORATORS.get(callValue.name);
      if (candidate) {
        routeCall = callValue;
        httpMethod = candidate;
        break;
      }
    }
    if (!routeCall) continue;
    const versioned = Boolean(findDecorator(method, ctx, COMMON, new Set(["Version"])));
    if (versioned) {
      model.diagnostics.push(
        `NestJS route versioning for ${controller.name}.${method.key?.name || "handler"} in ${ctx.filePath} requires runtime confirmation`,
      );
    }
    const paths = staticPaths(routeCall.arguments[0], ctx.consts, "");
    const middlewares = lifecycleDescriptors(method, code, ctx);
    for (const routePath of paths) {
      controller.routes.push({
        method: httpMethod,
        path: routePath,
        middlewares,
        source: { file: ctx.filePath, line: ctx.lineAt(routeCall.node.start) },
        io: nestIo(method, httpMethod, ctx, controller.name),
        partial: versioned,
      });
    }
  }
  return controller;
}

function providerDescriptors(node, model, code, ctx) {
  const descriptors = [];
  for (const providerNode of arrayElements(node)) {
    const provider = resolveObject(providerNode, model.objects);
    if (!provider) continue;
    const token = objectProperty(provider, "provide");
    const tokenName = importedName(token, ctx, CORE);
    const stage = APP_PROVIDER_STAGES.get(tokenName);
    if (!stage) continue;
    const implementation =
      objectProperty(provider, "useClass") ||
      objectProperty(provider, "useValue") ||
      objectProperty(provider, "useFactory");
    if (implementation) descriptors.push(descriptorFor(implementation, code, stage));
  }
  return descriptors;
}

function chainMethodCall(node, method) {
  let value = unwrapValue(node);
  while (value?.type === "CallExpression" && value.callee.type === "MemberExpression") {
    if (!value.callee.computed && value.callee.property.name === method) return value;
    value = unwrapValue(value.callee.object);
  }
  return null;
}

function chainRootName(node) {
  let value = unwrapValue(node);
  while (value?.type === "CallExpression" && value.callee.type === "MemberExpression") {
    value = unwrapValue(value.callee.object);
  }
  return value?.type === "Identifier" ? value.name : null;
}

function requestMethod(node, ctx) {
  const value = unwrapValue(node);
  if (value?.type !== "MemberExpression" || value.computed) return null;
  return importedName(value.object, ctx, COMMON) === "RequestMethod"
    ? value.property.name.toUpperCase()
    : null;
}

function middlewareTarget(node, model, ctx) {
  const value = unwrapValue(node);
  if (!value) return { type: "unknown" };
  if (value.type === "ArrayExpression") {
    return {
      type: "group",
      items: value.elements.filter(Boolean).map((item) => middlewareTarget(item, model, ctx)),
    };
  }
  const directPath = staticString(value, ctx.consts);
  if (directPath !== null) {
    return directPath === "*" || directPath === "/*"
      ? { type: "all", method: "ALL" }
      : { type: "path", path: directPath, method: "ALL" };
  }
  const object = resolveObject(value, model.objects);
  if (object) {
    const routePath = staticString(objectProperty(object, "path"), ctx.consts);
    const method = requestMethod(objectProperty(object, "method"), ctx) || "ALL";
    return routePath === null
      ? { type: "unknown" }
      : routePath === "*" || routePath === "/*"
        ? { type: "all", method }
        : { type: "path", path: routePath, method };
  }
  const ref = expressionRef(value, model, ctx);
  return ["local", "module"].includes(ref.type) ? { type: "controller", ref } : { type: "unknown" };
}

function flattenMiddlewareTargets(nodes, model, ctx) {
  return nodes
    .map((node) => middlewareTarget(node, model, ctx))
    .flatMap((target) => (target.type === "group" ? target.items : [target]));
}

function collectModuleMiddleware(node, module, model, code, ctx) {
  for (const method of node.body.body || []) {
    if (
      method.type !== "MethodDefinition" ||
      method.computed ||
      method.key?.name !== "configure" ||
      !method.value?.body
    ) {
      continue;
    }
    const consumer = method.value.params?.[0];
    const consumerName = consumer?.type === "Identifier" ? consumer.name : null;
    walk(method.value.body, (call) => {
      if (
        call.type !== "CallExpression" ||
        call.callee.type !== "MemberExpression" ||
        call.callee.computed ||
        call.callee.property.name !== "forRoutes" ||
        (consumerName && chainRootName(call.callee.object) !== consumerName)
      ) {
        return;
      }
      const apply = chainMethodCall(call.callee.object, "apply");
      if (!apply) return;
      const exclude = chainMethodCall(call.callee.object, "exclude");
      const targets = flattenMiddlewareTargets(call.arguments, model, ctx);
      const exclusions = exclude ? flattenMiddlewareTargets(exclude.arguments, model, ctx) : [];
      const dynamic = [...targets, ...exclusions].some((target) => target.type === "unknown");
      if (dynamic) {
        model.diagnostics.push(
          `NestJS middleware scope at ${ctx.filePath}:${ctx.lineAt(call.start)} requires runtime confirmation`,
        );
      }
      module.middlewareRegistrations.push({
        middlewares: apply.arguments.map((argument) => descriptorFor(argument, code, "middleware")),
        targets: targets.length ? targets : [{ type: "unknown" }],
        exclusions,
        dynamic,
        line: ctx.lineAt(call.start),
      });
    });
  }
}

function routerRegister(node, ctx) {
  const value = unwrapValue(node);
  if (value?.type !== "CallExpression" || value.callee.type !== "MemberExpression") return null;
  if (value.callee.computed || value.callee.property.name !== "register") return null;
  return importedName(value.callee.object, ctx, CORE) === "RouterModule" ? value : null;
}

function routerMappings(node, model, ctx, base = "") {
  const mappings = [];
  for (const entryNode of arrayElements(node)) {
    const entry = resolveObject(entryNode, model.objects);
    if (!entry) {
      model.dynamicRouterMappings++;
      continue;
    }
    const pathValue = staticString(objectProperty(entry, "path"), ctx.consts);
    const prefix = pathValue === null ? joinPath(base, "<dynamic>") : joinPath(base, pathValue);
    const moduleNode = objectProperty(entry, "module");
    if (moduleNode) mappings.push({ ref: expressionRef(moduleNode, model, ctx), prefix });
    const children = objectProperty(entry, "children");
    if (children) mappings.push(...routerMappings(children, model, ctx, prefix));
  }
  return mappings;
}

function functionReturnExpressions(fn) {
  const returned = [];
  const visit = (node) => {
    if (!node) return;
    if (
      node !== fn.body &&
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)
    ) {
      return;
    }
    if (node.type === "ReturnStatement") {
      if (node.argument) returned.push(node.argument);
      return;
    }
    for (const key of Object.keys(node)) {
      if (["loc", "start", "end"].includes(key)) continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child.type === "string") visit(child);
    }
  };
  if (fn.type === "ArrowFunctionExpression" && fn.expression) returned.push(fn.body);
  else visit(fn.body);
  return returned;
}

function collectArrayBindings(program) {
  const result = new Map();
  walk(program, (node) => {
    if (node.type !== "VariableDeclaration" || node.kind !== "const") return;
    for (const declaration of node.declarations) {
      const value = declaration.init && unwrapValue(declaration.init);
      if (declaration.id.type === "Identifier" && value?.type === "ArrayExpression") {
        result.set(declaration.id.name, value);
      }
    }
  });
  return result;
}

function expandModuleImports(node, model, ctx, seen = new Set()) {
  const value = unwrapValue(node);
  if (!value) return { values: [], dynamic: false };
  if (value.type === "ArrayExpression") {
    const expanded = value.elements.filter(Boolean).map((item) => {
      const element = item.type === "SpreadElement" ? item.argument : item;
      return expandModuleImports(element, model, ctx, new Set(seen));
    });
    return {
      values: expanded.flatMap((item) => item.values),
      dynamic: expanded.some((item) => item.dynamic),
    };
  }
  if (value.type === "Identifier" && model.arrays.has(value.name) && !seen.has(value.name)) {
    seen.add(value.name);
    return expandModuleImports(model.arrays.get(value.name), model, ctx, seen);
  }
  if (value.type === "ConditionalExpression") {
    const consequent = expandModuleImports(value.consequent, model, ctx, new Set(seen));
    const alternate = expandModuleImports(value.alternate, model, ctx, new Set(seen));
    return {
      values: [...consequent.values, ...alternate.values],
      dynamic: true,
    };
  }
  if (value.type === "CallExpression" && value.callee.type === "Identifier") {
    const fn = ctx.handlerIndex.get(value.callee.name);
    if (fn && !seen.has(`fn:${fn.start}`)) {
      seen.add(`fn:${fn.start}`);
      const returned = functionReturnExpressions(fn).map((item) =>
        expandModuleImports(item, model, ctx, new Set(seen)),
      );
      if (returned.length) {
        return {
          values: returned.flatMap((item) => item.values),
          dynamic:
            returned.length > 1 ||
            returned.some((item) => item.dynamic) ||
            value.arguments.length > 0,
        };
      }
    }
  }
  return { values: [value], dynamic: false };
}

function applyModuleMetadata(module, metadata, model, code, ctx) {
  module.controllers.push(
    ...arrayElements(objectProperty(metadata, "controllers")).map((value) =>
      expressionRef(value, model, ctx),
    ),
  );
  module.globalMiddleware.push(
    ...providerDescriptors(objectProperty(metadata, "providers"), model, code, ctx),
  );
  const imports = expandModuleImports(objectProperty(metadata, "imports"), model, ctx);
  module.metadataDynamic ||= imports.dynamic;
  for (const value of imports.values) {
    const registration = routerRegister(value, ctx);
    if (registration) {
      module.routerMappings.push(...routerMappings(registration.arguments[0], model, ctx));
    } else {
      module.imports.push(expressionRef(value, model, ctx));
    }
  }
}

function dynamicModuleMetadata(node, model) {
  const methods = (node.body.body || []).filter(
    (method) =>
      method.type === "MethodDefinition" &&
      method.static &&
      !method.computed &&
      ["register", "forRoot", "forRootAsync"].includes(method.key?.name) &&
      method.value,
  );
  return methods.flatMap((method) =>
    functionReturnExpressions(method.value).map((value) => resolveObject(value, model.objects)),
  );
}

function collectModule(node, call, model, code, ctx) {
  const metadata = resolveObject(call.arguments[0], model.objects);
  const dynamicMappingsBefore = model.dynamicRouterMappings;
  const module = {
    kind: "module",
    id: `${ctx.filePath}#nestjs-module:${node.id.name}`,
    file: ctx.filePath,
    name: node.id.name,
    controllers: [],
    imports: [],
    routerMappings: [],
    globalMiddleware: [],
    middlewareRegistrations: [],
    metadataDynamic: !metadata,
    dynamicRouterMappings: 0,
  };
  if (!metadata) {
    model.diagnostics.push(
      `NestJS @Module metadata for ${node.id.name} in ${ctx.filePath} is dynamic`,
    );
    return module;
  }
  applyModuleMetadata(module, metadata, model, code, ctx);
  const registeredMetadata = dynamicModuleMetadata(node, model);
  for (const registered of registeredMetadata.filter(Boolean)) {
    applyModuleMetadata(module, registered, model, code, ctx);
  }
  if (registeredMetadata.some((value) => !value) || registeredMetadata.length > 1) {
    module.metadataDynamic = true;
  }
  module.dynamicRouterMappings = model.dynamicRouterMappings - dynamicMappingsBefore;
  collectModuleMiddleware(node, module, model, code, ctx);
  return module;
}

function collectClasses(program, model, code, ctx) {
  walk(program, (node) => {
    if (node.type !== "ClassDeclaration" || !node.id) return;
    model.classes.set(node.id.name, { kind: "class", file: ctx.filePath, name: node.id.name });
  });
  walk(program, (node) => {
    if (node.type !== "ClassDeclaration" || !node.id) return;
    const controller = findDecorator(node, ctx, COMMON, new Set(["Controller"]));
    if (controller) {
      const value = collectController(node, controller, model, code, ctx);
      model.controllers.set(node.id.name, value);
      model.classes.set(node.id.name, value);
    }
    const moduleCall = findDecorator(node, ctx, COMMON, new Set(["Module"]));
    if (moduleCall) {
      const value = collectModule(node, moduleCall, model, code, ctx);
      model.modules.set(node.id.name, value);
      model.classes.set(node.id.name, value);
    }
  });
}

function exportName(left) {
  const name = calleeName(left);
  if (name === "module.exports" || name === "exports") return "default";
  if (name?.startsWith("module.exports.") || name?.startsWith("exports.")) {
    return name.split(".").at(-1);
  }
  return null;
}

function collectExports(program, model, ctx) {
  walk(program, (node) => {
    if (node.type === "AssignmentExpression") {
      const name = exportName(node.left);
      if (name) model.exports.set(name, expressionRef(node.right, model, ctx));
    } else if (node.type === "ExportDefaultDeclaration") {
      model.exports.set("default", expressionRef(node.declaration, model, ctx));
    } else if (node.type === "ExportNamedDeclaration") {
      if (node.declaration?.id?.name) {
        model.exports.set(node.declaration.id.name, {
          type: "local",
          name: node.declaration.id.name,
        });
      }
      for (const declaration of node.declaration?.declarations || []) {
        if (declaration.id.type === "Identifier") {
          model.exports.set(declaration.id.name, expressionRef(declaration.init, model, ctx));
        }
      }
      for (const specifier of node.specifiers || []) {
        model.exports.set(
          specifier.exported.name,
          node.source
            ? {
                type: "module",
                source: node.source.value,
                exportName: specifier.local.name,
                props: [],
              }
            : expressionRef(specifier.local, model, ctx),
        );
      }
    } else if (node.type === "ExportAllDeclaration" && !node.exported) {
      model.exportAll.push(node.source.value);
    }
  });
}

function nestFactoryCreate(callee, ctx) {
  const value = unwrapValue(callee);
  const name = calleeName(value);
  if (!name?.endsWith(".create")) return false;
  const object = unwrapValue(value.object);
  if (!object) return false;
  if (importedName(object, ctx, CORE) === "NestFactory") return true;
  if (object.type === "MemberExpression" && !object.computed) {
    return importedName(object, ctx, CORE) === "NestFactory";
  }
  return false;
}

function adapterFrom(node, model, ctx) {
  const value = unwrapValue(node);
  if (!value) return "express";
  if (resolveObject(value, model.objects)) return "express";
  const callee =
    value.type === "NewExpression" || value.type === "CallExpression" ? value.callee : value;
  const fastify = importedName(callee, ctx, "@nestjs/platform-fastify");
  if (fastify === "FastifyAdapter") return "fastify";
  const express = importedName(callee, ctx, "@nestjs/platform-express");
  return express === "ExpressAdapter" ? "express" : "unknown";
}

function collectRoots(program, model, ctx) {
  walk(program, (node) => {
    if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier" || !node.init) return;
    const call = unwrapValue(node.init);
    if (call?.type !== "CallExpression" || !nestFactoryCreate(call.callee, ctx)) return;
    const adapter = adapterFrom(call.arguments[1], model, ctx);
    if (adapter === "unknown") {
      model.diagnostics.push(
        `NestJS platform adapter at ${ctx.filePath}:${ctx.lineAt(call.start)} could not be identified`,
      );
    }
    model.roots.set(node.id.name, {
      id: `${ctx.filePath}#nestjs-root:${node.id.name}`,
      file: ctx.filePath,
      name: node.id.name,
      line: ctx.lineAt(node.start),
      moduleRef: expressionRef(call.arguments[0], model, ctx),
      adapter,
      prefix: "",
      prefixPartial: false,
      versioning: false,
      globalMiddleware: [],
    });
  });
}

function collectRootCalls(program, model, code, ctx) {
  walk(program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return;
    const object = unwrapValue(node.callee.object);
    if (object?.type !== "Identifier") return;
    const root = model.roots.get(object.name);
    if (!root || node.callee.computed) return;
    const method = node.callee.property.name;
    if (method === "setGlobalPrefix") {
      const prefix = staticString(node.arguments[0], ctx.consts);
      root.prefix = prefix === null ? "<dynamic>" : prefix;
      root.prefixPartial = prefix === null || node.arguments.length > 1;
      if (node.arguments.length > 1) {
        model.diagnostics.push(
          `NestJS global-prefix exclusions in ${ctx.filePath} require runtime confirmation`,
        );
      }
      return;
    }
    if (method === "enableVersioning") {
      root.versioning = true;
      model.diagnostics.push(
        `NestJS URI/version routing in ${ctx.filePath} requires runtime confirmation`,
      );
      return;
    }
    const stage = GLOBAL_METHODS.get(method);
    if (stage) {
      root.globalMiddleware.push(
        ...node.arguments.map((argument) => descriptorFor(argument, code, stage)),
      );
    }
  });
}

/** Analyze a parsed file for NestJS roots, modules, controllers, and lifecycle decorators. */
function analyzeNestjs(program, code, ctx) {
  const model = {
    filePath: ctx.filePath,
    objects: collectObjectBindings(program),
    arrays: collectArrayBindings(program),
    classes: new Map(),
    controllers: new Map(),
    modules: new Map(),
    roots: new Map(),
    exports: new Map(),
    exportAll: [],
    diagnostics: [],
    dynamicRouterMappings: 0,
  };
  collectClasses(program, model, code, ctx);
  collectExports(program, model, ctx);
  collectRoots(program, model, ctx);
  collectRootCalls(program, model, code, ctx);
  return model;
}

function normalizedModuleRef(ref) {
  let exportName = ref.exportName;
  const props = [...(ref.props || [])];
  if (["default", "*"].includes(exportName) && props.length) exportName = props.shift();
  return { ...ref, exportName, props };
}

function resolveClass(fromFile, ref, models, resolve, seen = new Set()) {
  if (!ref) return null;
  const current = models.get(fromFile);
  if (ref.type === "local") return current?.classes.get(ref.name) || null;
  if (ref.type !== "module") return null;
  const target = resolve(fromFile, ref.source);
  const model = target && models.get(target);
  if (!model) return null;
  const normalized = normalizedModuleRef(ref);
  const key = `${target}\0${normalized.exportName}\0${normalized.props.join(".")}`;
  if (seen.has(key)) return null;
  seen.add(key);
  let next = model.exports.get(normalized.exportName);
  if (!next) {
    for (const source of model.exportAll) {
      const value = resolveClass(
        target,
        { type: "module", source, exportName: normalized.exportName, props: normalized.props },
        models,
        resolve,
        seen,
      );
      if (value) return value;
    }
    return model.classes.get(normalized.exportName) || null;
  }
  if (normalized.props.length) {
    if (next.type !== "module") return null;
    next = { ...next, props: [...(next.props || []), ...normalized.props] };
  }
  return resolveClass(target, next, models, resolve, seen);
}

function traverseModules(rootModule, models, resolve, state, stack = new Set()) {
  if (!rootModule || rootModule.kind !== "module" || stack.has(rootModule.id)) return;
  stack.add(rootModule.id);
  state.modules.set(rootModule.id, rootModule);
  state.unresolved += Number(rootModule.metadataDynamic) + (rootModule.dynamicRouterMappings || 0);
  state.globalMiddleware.push(...rootModule.globalMiddleware);
  for (const ref of rootModule.controllers) {
    const controller = resolveClass(rootModule.file, ref, models, resolve);
    if (controller?.kind === "controller") state.controllers.set(controller.id, controller);
    else state.unresolved++;
  }
  for (const ref of rootModule.imports) {
    const imported = resolveClass(rootModule.file, ref, models, resolve);
    if (imported?.kind === "module") traverseModules(imported, models, resolve, state, stack);
    else if (ref.type !== "module" || ref.source.startsWith(".") || ref.source.startsWith("@/")) {
      state.unresolved++;
    }
  }
}

function modulePrefixes(state, models, resolve) {
  const prefixes = new Map();
  const addPrefix = (module, prefix, seen = new Set()) => {
    if (!module || module.kind !== "module" || seen.has(module.id)) return;
    seen.add(module.id);
    if (!prefixes.has(module.id)) prefixes.set(module.id, new Set());
    prefixes.get(module.id).add(prefix);
    for (const ref of module.imports) {
      const imported = resolveClass(module.file, ref, models, resolve);
      if (imported?.kind === "module") addPrefix(imported, prefix, seen);
    }
  };
  for (const module of state.modules.values()) {
    for (const mapping of module.routerMappings) {
      const target = resolveClass(module.file, mapping.ref, models, resolve);
      if (target?.kind === "module") {
        addPrefix(target, mapping.prefix);
      } else state.unresolved++;
    }
  }
  return prefixes;
}

function controllerModulePrefixes(controller, state, prefixes, models, resolve) {
  const result = new Set();
  for (const module of state.modules.values()) {
    if (!prefixes.has(module.id)) continue;
    for (const ref of module.controllers) {
      const candidate = resolveClass(module.file, ref, models, resolve);
      if (candidate?.id === controller.id) {
        for (const prefix of prefixes.get(module.id)) result.add(prefix);
      }
    }
  }
  return result.size ? [...result] : [""];
}

function wildcardPath(pattern, routePath, prefixMatch) {
  const normalized = joinPath("", pattern);
  if (!/[{*:]/.test(normalized)) {
    return routePath === normalized || (prefixMatch && routePath.startsWith(`${normalized}/`));
  }
  let source = "";
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    if (char === "{" && normalized[index + 1] === "*") {
      const end = normalized.indexOf("}", index + 2);
      if (end !== -1) {
        source += ".*";
        index = end;
        continue;
      }
    }
    if (char === "*") {
      while (/[A-Za-z0-9_]/.test(normalized[index + 1] || "")) index++;
      source += ".*";
      continue;
    }
    if (char === ":") {
      while (/[A-Za-z0-9_]/.test(normalized[index + 1] || "")) index++;
      source += "[^/]+";
      continue;
    }
    source += /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${source}${prefixMatch ? "(?:/.*)?" : ""}$`).test(routePath);
}

function middlewareTargetApplies(
  target,
  module,
  controller,
  routePath,
  method,
  models,
  resolve,
  prefixMatch,
) {
  if (target.type === "unknown") return null;
  if (target.method && target.method !== "ALL" && target.method !== method) return false;
  if (target.type === "all") return true;
  if (target.type === "path") return wildcardPath(target.path, routePath, prefixMatch);
  if (target.type === "controller") {
    const candidate = resolveClass(module.file, target.ref, models, resolve);
    return candidate ? candidate.id === controller.id : null;
  }
  return null;
}

function opaqueMiddlewareRegistration(module, registration) {
  return {
    name: "<anonymous>",
    kind: "unknown",
    raw: `NestJS middleware scope at ${module.file}:${registration.line}`,
    stage: "middleware",
  };
}

function middlewareForNestRoute(state, controller, controllerPath, route, models, resolve) {
  const result = [];
  const relativePath = joinPath(
    joinPath("", controllerPath ?? "<dynamic>"),
    route.path ?? "<dynamic>",
  );
  for (const module of state.modules.values()) {
    for (const registration of module.middlewareRegistrations) {
      const included = registration.targets.map((target) =>
        middlewareTargetApplies(
          target,
          module,
          controller,
          relativePath,
          route.method,
          models,
          resolve,
          true,
        ),
      );
      if (!included.includes(true) && !included.includes(null)) continue;
      const excluded = registration.exclusions.map((target) =>
        middlewareTargetApplies(
          target,
          module,
          controller,
          relativePath,
          route.method,
          models,
          resolve,
          false,
        ),
      );
      if (excluded.includes(true)) continue;
      if (!included.includes(true) || excluded.includes(null)) {
        result.push(opaqueMiddlewareRegistration(module, registration));
      } else {
        result.push(...registration.middlewares);
      }
    }
  }
  return result;
}

function emitController(controller, options, output) {
  const { applicationId, rootPrefix, modulePrefix, inherited, partial, middlewareForRoute } =
    options;
  const normalizedRoot = rootPrefix ? joinPath("", rootPrefix) : "";
  for (const controllerPath of controller.paths) {
    for (const route of controller.routes) {
      const dynamic = controllerPath === null || route.path === null;
      const pathValue = joinPath(
        joinPath(joinPath(normalizedRoot, modulePrefix), controllerPath ?? "<dynamic>"),
        route.path ?? "<dynamic>",
      );
      output.push({
        framework: "nestjs",
        applicationId,
        method: route.method,
        path: pathValue,
        middlewares: middlewareForRoute(controllerPath, route).concat(
          inherited,
          controller.middlewares,
          route.middlewares,
        ),
        source: route.source,
        io: route.io,
        pathConfidence:
          partial ||
          controller.partial ||
          route.partial ||
          dynamic ||
          pathValue.includes("<dynamic>")
            ? "partial"
            : "full",
      });
    }
  }
}

function nestApplicationId(root, application) {
  const relative = path.relative(root, application.file).split(path.sep).join("/");
  return `nestjs:${relative}#${application.name}`;
}

/** Build a framework-neutral route registry from the repository's NestJS models. */
function buildNestjsRegistry(files, resolve, root) {
  const models = new Map(files.map((file) => [file.filePath, file.frameworks.nestjs]));
  const routes = [];
  const applications = [];
  const globalMiddleware = [];
  const diagnostics = files.flatMap((file) => file.frameworks.nestjs.diagnostics);
  const assigned = new Set();
  let unresolved = 0;
  for (const model of models.values()) {
    for (const application of model.roots.values()) {
      const rootModule = resolveClass(application.file, application.moduleRef, models, resolve);
      const state = {
        modules: new Map(),
        controllers: new Map(),
        globalMiddleware: [...application.globalMiddleware],
        unresolved: 0,
      };
      if (rootModule?.kind === "module") traverseModules(rootModule, models, resolve, state);
      else state.unresolved++;
      const prefixes = modulePrefixes(state, models, resolve);
      const id = nestApplicationId(root, application);
      const before = routes.length;
      for (const controller of state.controllers.values()) {
        assigned.add(controller.id);
        for (const modulePrefix of controllerModulePrefixes(
          controller,
          state,
          prefixes,
          models,
          resolve,
        )) {
          emitController(
            controller,
            {
              applicationId: id,
              rootPrefix: application.prefix,
              modulePrefix,
              inherited: state.globalMiddleware,
              middlewareForRoute: (controllerPath, route) =>
                middlewareForNestRoute(state, controller, controllerPath, route, models, resolve),
              partial:
                application.prefixPartial ||
                application.versioning ||
                application.adapter === "unknown" ||
                state.unresolved > 0,
            },
            routes,
          );
        }
      }
      applications.push({
        id,
        name: `${path.relative(root, application.file).split(path.sep).join("/")}#${application.name}`,
        framework: "nestjs",
        adapter: application.adapter,
        source: { file: application.file, line: application.line },
        routeCount: routes.length - before,
        globalMiddleware: state.globalMiddleware,
      });
      globalMiddleware.push(...state.globalMiddleware);
      unresolved += state.unresolved;
    }
  }
  let orphanRoutes = 0;
  for (const model of models.values()) {
    for (const controller of model.controllers.values()) {
      if (assigned.has(controller.id)) continue;
      const before = routes.length;
      emitController(
        controller,
        {
          applicationId: null,
          rootPrefix: "",
          modulePrefix: "",
          inherited: [],
          middlewareForRoute: () => [],
          partial: true,
        },
        routes,
      );
      orphanRoutes += routes.length - before;
    }
  }
  if (orphanRoutes) {
    diagnostics.push(
      `${orphanRoutes} NestJS route(s) could not be connected to a NestFactory application; global prefixes and application-wide guards are unknown.`,
    );
  }
  if (unresolved) {
    diagnostics.push(
      `${unresolved} NestJS module or routing reference(s) could not be resolved statically; affected paths are partial-confidence.`,
    );
  }
  return { routes, applications, globalMiddleware, diagnostics, orphanRoutes };
}

module.exports = { analyzeNestjs, buildNestjsRegistry };
