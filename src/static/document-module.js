"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parse, unwrap, staticString } = require("./ast");
const { createScopedResolver } = require("./resolve");

const MODULE_EXTENSIONS = new Set([".js", ".jsx", ".cjs", ".mjs", ".ts", ".tsx", ".cts", ".mts"]);
const DEFAULT_MAX_STEPS = 1_000_000;
const DEFAULT_MAX_CALL_DEPTH = 100;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_COLLECTION_ENTRIES = 250_000;
const OMIT = Symbol("static-document-omit");

class StaticDocumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "StaticDocumentError";
  }
}

class ReturnValue {
  constructor(value) {
    this.value = value;
  }
}

class Environment {
  constructor(parent = null) {
    this.parent = parent;
    this.values = new Map();
  }

  define(name, value) {
    this.values.set(name, value);
  }

  get(name) {
    if (this.values.has(name)) return this.values.get(name);
    if (this.parent) return this.parent.get(name);
    throw new StaticDocumentError(`unresolved identifier ${JSON.stringify(name)}`);
  }

  assign(name, value) {
    if (this.values.has(name)) {
      this.values.set(name, value);
      return value;
    }
    if (this.parent) return this.parent.assign(name, value);
    throw new StaticDocumentError(`assignment to unresolved identifier ${JSON.stringify(name)}`);
  }
}

function dataObject() {
  return Object.create(null);
}

function defineDataProperty(target, key, value) {
  Object.defineProperty(target, String(key), {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep));
}

function sourceLocation(file, node) {
  return `${file}:${node?.loc?.start?.line || "?"}`;
}

function closure(node, env, file) {
  const value = dataObject();
  defineDataProperty(value, "kind", "static-document-function");
  defineDataProperty(value, "node", node);
  defineDataProperty(value, "env", env);
  defineDataProperty(value, "file", file);
  return value;
}

function safeFunction(name, call) {
  const value = dataObject();
  defineDataProperty(value, "kind", "static-document-safe-function");
  defineDataProperty(value, "name", name);
  defineDataProperty(value, "call", call);
  return value;
}

function arrayMethod(name, target) {
  const value = dataObject();
  defineDataProperty(value, "kind", "static-document-array-method");
  defineDataProperty(value, "name", name);
  defineDataProperty(value, "target", target);
  return value;
}

function consumeCloneBudget(state, bytes) {
  state.nodes++;
  state.bytes += bytes;
  if (state.nodes > state.maxNodes || state.bytes > state.maxBytes) {
    throw new StaticDocumentError(
      `static documentation output exceeds its bounded value limit (${state.maxBytes} bytes)`,
    );
  }
}

function jsonCompatibleClone(value, state, active = new Set(), inArray = false) {
  if (value === undefined) return inArray ? null : OMIT;
  if (value === null || typeof value === "boolean") {
    consumeCloneBudget(state, 8);
    return value;
  }
  if (typeof value === "string") {
    consumeCloneBudget(state, Buffer.byteLength(value, "utf8") + 2);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new StaticDocumentError("static documentation contains a non-finite number");
    }
    consumeCloneBudget(state, 16);
    return value;
  }
  if (!value || typeof value !== "object") {
    throw new StaticDocumentError("static documentation contains a non-JSON value");
  }
  if (isCallable(value)) {
    throw new StaticDocumentError("static documentation contains an unevaluated function");
  }
  if (active.has(value)) throw new StaticDocumentError("static documentation contains a cycle");
  consumeCloneBudget(state, 2);
  active.add(value);
  let output;
  if (Array.isArray(value)) {
    output = value.map((item) => jsonCompatibleClone(item, state, active, true));
  } else {
    output = dataObject();
    for (const [key, item] of Object.entries(value)) {
      consumeCloneBudget(state, Buffer.byteLength(key, "utf8") + 3);
      const normalized = jsonCompatibleClone(item, state, active, false);
      if (normalized !== OMIT) defineDataProperty(output, key, normalized);
    }
  }
  active.delete(value);
  return output;
}

function isCallable(value) {
  return (
    value?.kind === "static-document-function" ||
    value?.kind === "static-document-safe-function" ||
    value?.kind === "static-document-array-method"
  );
}

function staticPropertyName(node, evaluator, env, file, depth) {
  if (!node.computed && (node.key?.type === "Identifier" || node.property?.type === "Identifier")) {
    return node.key?.name ?? node.property.name;
  }
  const keyNode = node.key || node.property;
  const value = evaluator.expression(keyNode, env, file, depth + 1);
  if (["string", "number"].includes(typeof value)) return String(value);
  throw new StaticDocumentError(`non-static property name at ${sourceLocation(file, node)}`);
}

class StaticDocumentEvaluator {
  constructor(root, options = {}) {
    this.root = fs.realpathSync(path.resolve(root));
    this.resolve = createScopedResolver(this.root);
    this.maxFiles = options.maxFiles ?? 50_000;
    this.maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 250 * 1024 * 1024;
    this.deadline = Date.now() + (options.timeoutMs ?? 120_000);
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.maxCallDepth = options.maxCallDepth ?? DEFAULT_MAX_CALL_DEPTH;
    this.maxOutputBytes = Math.min(
      options.maxDocumentBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      this.maxTotalBytes,
    );
    this.maxCollectionEntries = options.maxCollectionEntries ?? DEFAULT_MAX_COLLECTION_ENTRIES;
    this.files = 0;
    this.bytes = 0;
    this.steps = 0;
    this.generatedBytes = 0;
    this.generatedEntries = 0;
    this.modules = new Map();
    this.objectSizes = new WeakMap();
    this.objectBuiltin = dataObject();
    defineDataProperty(
      this.objectBuiltin,
      "values",
      safeFunction("Object.values", ([value]) => {
        if (value === null || value === undefined) {
          throw new StaticDocumentError("Object.values received null or undefined");
        }
        if (isCallable(value)) {
          throw new StaticDocumentError("Object.values cannot inspect a static function");
        }
        const values = Object.values(value);
        this.ensureCollectionSize(values.length, "Object.values result");
        this.consumeGeneratedEntries(values.length, "Object.values result");
        this.consumeWork(null, null, values.length);
        return values;
      }),
    );
    this.lodashBuiltin = dataObject();
    defineDataProperty(
      this.lodashBuiltin,
      "isString",
      safeFunction("lodash.isString", ([value]) => typeof value === "string"),
    );
  }

  consumeWork(file, node, amount = 1) {
    this.steps += amount;
    if (this.steps > this.maxSteps) {
      throw new StaticDocumentError(`static document evaluation exceeded ${this.maxSteps} steps`);
    }
    if (Date.now() >= this.deadline) {
      throw new StaticDocumentError("static document evaluation exceeded scan.timeoutMs");
    }
  }

  step(file, node) {
    this.consumeWork(file, node);
    if (node && node.type === "ChainExpression") return unwrap(node.expression);
    return unwrap(node);
  }

  ensureCollectionSize(size, label, file = null, node = null) {
    if (size > this.maxCollectionEntries) {
      throw new StaticDocumentError(
        `${label} exceeds ${this.maxCollectionEntries} entries${file ? ` at ${sourceLocation(file, node)}` : ""}`,
      );
    }
  }

  consumeGeneratedEntries(amount, label, file = null, node = null) {
    this.generatedEntries += amount;
    if (this.generatedEntries > this.maxCollectionEntries) {
      throw new StaticDocumentError(
        `${label} exceeds the cumulative ${this.maxCollectionEntries}-entry value limit${file ? ` at ${sourceLocation(file, node)}` : ""}`,
      );
    }
  }

  defineProperty(object, key, value, file, node) {
    let size = this.objectSizes.get(object);
    if (size === undefined) size = Object.keys(object).length;
    if (!Object.hasOwn(object, String(key))) {
      size++;
      this.consumeGeneratedEntries(1, "static document object", file, node);
    }
    this.ensureCollectionSize(size, "static document object", file, node);
    this.objectSizes.set(object, size);
    defineDataProperty(object, key, value);
  }

  staticString(value, file, node) {
    if (
      value !== null &&
      value !== undefined &&
      !["string", "number", "boolean"].includes(typeof value)
    ) {
      throw new StaticDocumentError(
        `non-primitive string coercion at ${sourceLocation(file, node)}`,
      );
    }
    return String(value);
  }

  concat(left, right, file, node) {
    if (typeof left !== "string" && typeof right !== "string") {
      if ([left, right].some((value) => value !== null && typeof value === "object")) {
        throw new StaticDocumentError(`non-primitive addition at ${sourceLocation(file, node)}`);
      }
      return left + right;
    }
    const leftText = this.staticString(left, file, node);
    const rightText = this.staticString(right, file, node);
    const bytes = Buffer.byteLength(leftText, "utf8") + Buffer.byteLength(rightText, "utf8");
    this.generatedBytes += bytes;
    if (bytes > this.maxOutputBytes || this.generatedBytes > this.maxOutputBytes) {
      throw new StaticDocumentError(
        `static documentation output exceeds its bounded value limit (${this.maxOutputBytes} bytes)`,
      );
    }
    return leftText + rightText;
  }

  memberValue(object, key, file, node) {
    if (object === null || object === undefined) {
      throw new StaticDocumentError(
        `property access on null or undefined at ${sourceLocation(file, node)}`,
      );
    }
    if (isCallable(object)) {
      throw new StaticDocumentError(
        `function internals are not available at ${sourceLocation(file, node)}`,
      );
    }
    if (Array.isArray(object)) {
      if (key === "reduce") return arrayMethod("reduce", object);
      if (key === "length" || /^\d+$/.test(key) || Object.hasOwn(object, key)) return object[key];
      throw new StaticDocumentError(
        `inherited array property ${JSON.stringify(key)} is not available at ${sourceLocation(file, node)}`,
      );
    }
    if (typeof object === "string") {
      if (key === "length" || /^\d+$/.test(key)) return object[key];
      throw new StaticDocumentError(
        `string method ${JSON.stringify(key)} is not available at ${sourceLocation(file, node)}`,
      );
    }
    if (typeof object === "object" && Object.getPrototypeOf(object) === null) {
      return object[key];
    }
    throw new StaticDocumentError(
      `inherited or missing property ${JSON.stringify(key)} is not available at ${sourceLocation(file, node)}`,
    );
  }

  readModule(file) {
    const resolved = fs.realpathSync(path.resolve(file));
    if (!inside(this.root, resolved)) {
      throw new StaticDocumentError(`documentation module leaves the scan root: ${resolved}`);
    }
    if (!MODULE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      throw new StaticDocumentError(`unsupported documentation module extension: ${resolved}`);
    }
    const cached = this.modules.get(resolved);
    if (cached) return cached.exports;
    const stat = fs.statSync(resolved);
    if (!stat.isFile())
      throw new StaticDocumentError(`documentation module is not a file: ${resolved}`);
    if (stat.size > this.maxFileBytes) {
      throw new StaticDocumentError(
        `documentation module ${resolved} is ${stat.size} bytes, exceeding scan.maxFileBytes (${this.maxFileBytes})`,
      );
    }
    if (this.files + 1 > this.maxFiles) {
      throw new StaticDocumentError(
        `documentation modules exceed scan.maxFiles (${this.maxFiles})`,
      );
    }
    if (this.bytes + stat.size > this.maxTotalBytes) {
      throw new StaticDocumentError(
        `documentation modules exceed scan.maxTotalBytes (${this.maxTotalBytes})`,
      );
    }
    this.files++;
    this.bytes += stat.size;
    const code = fs.readFileSync(resolved, "utf8");
    let parseError = null;
    const program = parse(code, resolved, (message) => {
      parseError = message;
    });
    if (!program) {
      throw new StaticDocumentError(
        `could not parse documentation module ${resolved}: ${parseError || "unknown parse error"}`,
      );
    }

    const moduleObject = dataObject();
    defineDataProperty(moduleObject, "exports", dataObject());
    const record = { exports: moduleObject.exports, evaluating: true };
    this.modules.set(resolved, record);
    const env = new Environment();
    env.define("module", moduleObject);
    env.define("exports", moduleObject.exports);
    env.define("Object", this.objectBuiltin);
    env.define("undefined", undefined);

    try {
      for (const statement of program.body) {
        if (statement.type === "FunctionDeclaration" && statement.id) {
          env.define(statement.id.name, closure(statement, env, resolved));
        }
      }
      for (const statement of program.body) this.statement(statement, env, resolved, 0);
      record.exports = moduleObject.exports;
      record.evaluating = false;
      return record.exports;
    } catch (error) {
      this.modules.delete(resolved);
      if (error instanceof StaticDocumentError) throw error;
      throw new StaticDocumentError(
        `could not statically evaluate documentation module ${resolved}: ${error.message}`,
      );
    }
  }

  requireModule(source, fromFile) {
    if (source === "lodash") return this.lodashBuiltin;
    const target = this.resolve(fromFile, source);
    if (!target) {
      throw new StaticDocumentError(
        `external module ${JSON.stringify(source)} is not allowed in static documentation evaluation`,
      );
    }
    return this.readModule(target);
  }

  statement(statement, env, file, depth) {
    const node = this.step(file, statement);
    if (!node) return;
    switch (node.type) {
      case "EmptyStatement":
      case "FunctionDeclaration":
        return;
      case "VariableDeclaration":
        for (const declaration of node.declarations) {
          const value = declaration.init
            ? this.expression(declaration.init, env, file, depth + 1)
            : undefined;
          this.bind(declaration.id, value, env, file, depth + 1);
        }
        return;
      case "ExpressionStatement":
        this.expression(node.expression, env, file, depth + 1);
        return;
      case "ReturnStatement":
        throw new ReturnValue(
          node.argument ? this.expression(node.argument, env, file, depth + 1) : undefined,
        );
      case "BlockStatement":
        for (const child of node.body) this.statement(child, env, file, depth + 1);
        return;
      case "IfStatement": {
        const branch = this.expression(node.test, env, file, depth + 1)
          ? node.consequent
          : node.alternate;
        if (branch) this.statement(branch, env, file, depth + 1);
        return;
      }
      case "ExportDefaultDeclaration": {
        const value = this.expression(node.declaration, env, file, depth + 1);
        env.get("module").exports = value;
        return;
      }
      case "ExportNamedDeclaration":
        if (node.declaration) {
          this.statement(node.declaration, env, file, depth + 1);
          for (const declaration of node.declaration.declarations || []) {
            if (declaration.id.type === "Identifier") {
              this.defineProperty(
                env.get("module").exports,
                declaration.id.name,
                env.get(declaration.id.name),
                file,
                declaration,
              );
            }
          }
        }
        for (const specifier of node.specifiers || []) {
          const exported = specifier.exported.name || specifier.exported.value;
          const local = specifier.local.name || specifier.local.value;
          this.defineProperty(env.get("module").exports, exported, env.get(local), file, specifier);
        }
        return;
      case "ImportDeclaration": {
        const imported = this.requireModule(node.source.value, file);
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportDefaultSpecifier")
            env.define(
              specifier.local.name,
              imported && typeof imported === "object" && Object.hasOwn(imported, "default")
                ? imported.default
                : imported,
            );
          else if (specifier.type === "ImportNamespaceSpecifier")
            env.define(specifier.local.name, imported);
          else {
            const name = specifier.imported.name || specifier.imported.value;
            env.define(specifier.local.name, this.memberValue(imported, name, file, specifier));
          }
        }
        return;
      }
      default:
        throw new StaticDocumentError(
          `unsupported statement ${node.type} at ${sourceLocation(file, node)}`,
        );
    }
  }

  bind(pattern, value, env, file, depth) {
    const node = this.step(file, pattern);
    if (node.type === "Identifier") {
      env.define(node.name, value);
      return;
    }
    if (node.type === "AssignmentPattern") {
      this.bind(
        node.left,
        value === undefined ? this.expression(node.right, env, file, depth + 1) : value,
        env,
        file,
        depth + 1,
      );
      return;
    }
    if (node.type === "ObjectPattern") {
      const source = value == null ? dataObject() : value;
      const used = new Set();
      for (const property of node.properties) {
        if (property.type === "RestElement") {
          const rest = dataObject();
          const entries = Object.entries(source);
          this.consumeWork(file, property, entries.length);
          for (const [key, item] of entries) {
            if (!used.has(key)) this.defineProperty(rest, key, item, file, property);
          }
          this.bind(property.argument, rest, env, file, depth + 1);
          continue;
        }
        const key = staticPropertyName(property, this, env, file, depth + 1);
        used.add(key);
        this.bind(
          property.value,
          this.memberValue(source, key, file, property),
          env,
          file,
          depth + 1,
        );
      }
      return;
    }
    if (node.type === "ArrayPattern") {
      const source = Array.isArray(value) ? value : [];
      for (let index = 0; index < node.elements.length; index++) {
        if (node.elements[index])
          this.bind(node.elements[index], source[index], env, file, depth + 1);
      }
      return;
    }
    if (node.type === "RestElement") {
      this.bind(node.argument, value, env, file, depth + 1);
      return;
    }
    throw new StaticDocumentError(
      `unsupported binding ${node.type} at ${sourceLocation(file, node)}`,
    );
  }

  expression(expression, env, file, depth) {
    if (depth > this.maxCallDepth * 4) {
      throw new StaticDocumentError("static document expression nesting is too deep");
    }
    const node = this.step(file, expression);
    if (!node) return undefined;
    switch (node.type) {
      case "Literal":
        if (["string", "number", "boolean"].includes(typeof node.value) || node.value === null) {
          return node.value;
        }
        throw new StaticDocumentError(`unsupported literal at ${sourceLocation(file, node)}`);
      case "Identifier":
        return env.get(node.name);
      case "ObjectExpression": {
        const output = dataObject();
        for (const property of node.properties) {
          if (property.type === "SpreadElement") {
            const spread = this.expression(property.argument, env, file, depth + 1);
            if (spread === null || spread === undefined || spread === false) continue;
            if (typeof spread !== "object" || isCallable(spread)) {
              throw new StaticDocumentError(
                `non-object spread at ${sourceLocation(file, property)}`,
              );
            }
            const entries = Object.entries(spread);
            this.consumeWork(file, property, entries.length);
            for (const [key, value] of entries)
              this.defineProperty(output, key, value, file, property);
            continue;
          }
          if (property.type !== "Property" || property.kind !== "init" || property.method) {
            throw new StaticDocumentError(
              `unsupported object member ${property.type} at ${sourceLocation(file, property)}`,
            );
          }
          const key = staticPropertyName(property, this, env, file, depth + 1);
          this.defineProperty(
            output,
            key,
            this.expression(property.value, env, file, depth + 1),
            file,
            property,
          );
        }
        return output;
      }
      case "ArrayExpression": {
        const output = [];
        for (const element of node.elements) {
          if (!element) {
            this.ensureCollectionSize(output.length + 1, "static document array", file, node);
            this.consumeGeneratedEntries(1, "static document array", file, node);
            output.push(null);
          } else if (element.type === "SpreadElement") {
            const spread = this.expression(element.argument, env, file, depth + 1);
            if (!Array.isArray(spread)) {
              throw new StaticDocumentError(`non-array spread at ${sourceLocation(file, element)}`);
            }
            this.ensureCollectionSize(
              output.length + spread.length,
              "static document array",
              file,
              element,
            );
            this.consumeGeneratedEntries(spread.length, "static document array", file, element);
            this.consumeWork(file, element, spread.length);
            for (const item of spread) output.push(item);
          } else {
            this.ensureCollectionSize(output.length + 1, "static document array", file, node);
            this.consumeGeneratedEntries(1, "static document array", file, node);
            output.push(this.expression(element, env, file, depth + 1));
          }
        }
        return output;
      }
      case "ArrowFunctionExpression":
      case "FunctionExpression":
      case "FunctionDeclaration":
        return closure(node, env, file);
      case "TemplateLiteral": {
        let value = "";
        for (let index = 0; index < node.quasis.length; index++) {
          value = this.concat(
            value,
            node.quasis[index].value.cooked ?? node.quasis[index].value.raw,
            file,
            node,
          );
          if (index < node.expressions.length) {
            value = this.concat(
              value,
              this.expression(node.expressions[index], env, file, depth + 1),
              file,
              node,
            );
          }
        }
        return value;
      }
      case "MemberExpression": {
        const object = this.expression(node.object, env, file, depth + 1);
        const key = staticPropertyName(node, this, env, file, depth + 1);
        return this.memberValue(object, key, file, node);
      }
      case "CallExpression": {
        if (node.callee.type === "Identifier" && node.callee.name === "require") {
          const source = staticString(node.arguments[0]);
          if (source === null) {
            throw new StaticDocumentError(`dynamic require at ${sourceLocation(file, node)}`);
          }
          return this.requireModule(source, file);
        }
        const callable = this.expression(node.callee, env, file, depth + 1);
        const args = [];
        for (const argument of node.arguments) {
          if (argument.type === "SpreadElement") {
            const spread = this.expression(argument.argument, env, file, depth + 1);
            if (!Array.isArray(spread)) {
              throw new StaticDocumentError(
                `non-array call spread at ${sourceLocation(file, argument)}`,
              );
            }
            this.ensureCollectionSize(
              args.length + spread.length,
              "static document call arguments",
              file,
              argument,
            );
            this.consumeWork(file, argument, spread.length);
            for (const item of spread) args.push(item);
          } else {
            this.ensureCollectionSize(
              args.length + 1,
              "static document call arguments",
              file,
              argument,
            );
            args.push(this.expression(argument, env, file, depth + 1));
          }
        }
        return this.call(callable, args, file, node, depth + 1);
      }
      case "AssignmentExpression": {
        const current =
          node.operator === "=" ? undefined : this.assignmentValue(node.left, env, file, depth + 1);
        const right = this.expression(node.right, env, file, depth + 1);
        let value;
        switch (node.operator) {
          case "=":
            value = right;
            break;
          case "||=":
            value = current || right;
            break;
          case "&&=":
            value = current && right;
            break;
          case "??=":
            value = current ?? right;
            break;
          case "+=":
            value = this.concat(current, right, file, node);
            break;
          default:
            throw new StaticDocumentError(
              `unsupported assignment operator ${node.operator} at ${sourceLocation(file, node)}`,
            );
        }
        return this.assign(node.left, value, env, file, depth + 1);
      }
      case "LogicalExpression": {
        const left = this.expression(node.left, env, file, depth + 1);
        if (node.operator === "&&")
          return left && this.expression(node.right, env, file, depth + 1);
        if (node.operator === "||")
          return left || this.expression(node.right, env, file, depth + 1);
        if (node.operator === "??")
          return left ?? this.expression(node.right, env, file, depth + 1);
        throw new StaticDocumentError(`unsupported logical operator ${node.operator}`);
      }
      case "ConditionalExpression":
        return this.expression(
          this.expression(node.test, env, file, depth + 1) ? node.consequent : node.alternate,
          env,
          file,
          depth + 1,
        );
      case "UnaryExpression": {
        const value = this.expression(node.argument, env, file, depth + 1);
        if (node.operator === "!") return !value;
        if (node.operator === "+") return +value;
        if (node.operator === "-") return -value;
        if (node.operator === "typeof") return typeof value;
        if (node.operator === "void") return undefined;
        throw new StaticDocumentError(`unsupported unary operator ${node.operator}`);
      }
      case "BinaryExpression": {
        const left = this.expression(node.left, env, file, depth + 1);
        const right = this.expression(node.right, env, file, depth + 1);
        switch (node.operator) {
          case "+":
            return this.concat(left, right, file, node);
          case "-":
            return left - right;
          case "*":
            return left * right;
          case "/":
            return left / right;
          case "===":
            return left === right;
          case "!==":
            return left !== right;
          case "==":
            return left == right;
          case "!=":
            return left != right;
          case "<":
            return left < right;
          case "<=":
            return left <= right;
          case ">":
            return left > right;
          case ">=":
            return left >= right;
          default:
            throw new StaticDocumentError(`unsupported binary operator ${node.operator}`);
        }
      }
      case "SequenceExpression": {
        let value;
        for (const item of node.expressions) value = this.expression(item, env, file, depth + 1);
        return value;
      }
      default:
        throw new StaticDocumentError(
          `unsupported expression ${node.type} at ${sourceLocation(file, node)}`,
        );
    }
  }

  assignmentValue(target, env, file, depth) {
    const node = this.step(file, target);
    if (node.type === "Identifier") return env.get(node.name);
    if (node.type === "MemberExpression") {
      const object = this.expression(node.object, env, file, depth + 1);
      const key = staticPropertyName(node, this, env, file, depth + 1);
      return this.memberValue(object, key, file, node);
    }
    throw new StaticDocumentError(`unsupported assignment target ${node.type}`);
  }

  assign(target, value, env, file, depth) {
    const node = this.step(file, target);
    if (node.type === "Identifier") return env.assign(node.name, value);
    if (node.type === "MemberExpression") {
      const object = this.expression(node.object, env, file, depth + 1);
      const key = staticPropertyName(node, this, env, file, depth + 1);
      if (!object || typeof object !== "object") {
        throw new StaticDocumentError(
          `assignment target is not an object at ${sourceLocation(file, node)}`,
        );
      }
      this.defineProperty(object, key, value, file, node);
      return value;
    }
    throw new StaticDocumentError(`unsupported assignment target ${node.type}`);
  }

  call(callable, args, file, node, depth) {
    if (!isCallable(callable)) {
      throw new StaticDocumentError(`non-static function call at ${sourceLocation(file, node)}`);
    }
    if (callable.kind === "static-document-safe-function") return callable.call(args);
    if (callable.kind === "static-document-array-method") {
      if (callable.name !== "reduce" || !isCallable(args[0])) {
        throw new StaticDocumentError(`unsupported array method at ${sourceLocation(file, node)}`);
      }
      let accumulator = args.length > 1 ? args[1] : callable.target[0];
      const start = args.length > 1 ? 0 : 1;
      for (let index = start; index < callable.target.length; index++) {
        accumulator = this.call(
          args[0],
          [accumulator, callable.target[index], index, callable.target],
          file,
          node,
          depth + 1,
        );
      }
      return accumulator;
    }
    if (depth > this.maxCallDepth) {
      throw new StaticDocumentError(
        `static document function depth exceeds ${this.maxCallDepth} at ${sourceLocation(file, node)}`,
      );
    }
    const local = new Environment(callable.env);
    for (let index = 0; index < callable.node.params.length; index++) {
      const parameter = callable.node.params[index];
      if (parameter.type === "RestElement") {
        this.bind(parameter.argument, args.slice(index), local, callable.file, depth + 1);
        break;
      }
      this.bind(parameter, args[index], local, callable.file, depth + 1);
    }
    try {
      if (callable.node.type === "ArrowFunctionExpression" && callable.node.expression) {
        return this.expression(callable.node.body, local, callable.file, depth + 1);
      }
      this.statement(callable.node.body, local, callable.file, depth + 1);
      return undefined;
    } catch (result) {
      if (result instanceof ReturnValue) return result.value;
      throw result;
    }
  }
}

function loadStaticDocumentModule(file, options = {}) {
  const root = options.root || path.dirname(path.resolve(file));
  const evaluator = new StaticDocumentEvaluator(root, options);
  const value = jsonCompatibleClone(evaluator.readModule(file), {
    bytes: 0,
    nodes: 0,
    maxBytes: evaluator.maxOutputBytes,
    maxNodes: evaluator.maxSteps,
  });
  return {
    value,
    evidence: {
      files: evaluator.files,
      bytes: evaluator.bytes,
      steps: evaluator.steps,
      executedTargetCode: false,
    },
  };
}

module.exports = {
  MODULE_EXTENSIONS,
  StaticDocumentError,
  loadStaticDocumentModule,
};
