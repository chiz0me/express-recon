"use strict";

const { walk, unwrap } = require("./ast");
const {
  addRequestSchema,
  contract,
  dataObject,
  evidence,
  staticValue,
} = require("./schema-evidence");

const EXPRESS_VALIDATOR = "express-validator";
const REQUEST_MEMBER_BUCKETS = new Map([
  ["body", "body"],
  ["query", "query"],
  ["params", "params"],
  ["headers", "headers"],
]);
const EXPRESS_VALIDATOR_BUCKETS = new Map([
  ["body", "body"],
  ["query", "query"],
  ["param", "params"],
  ["header", "headers"],
]);

function sourceFor(node, context) {
  return context.file && context.lineAt
    ? { file: context.file, line: context.lineAt(node.start) }
    : null;
}

function importedFunction(node, context, source) {
  const value = unwrap(node);
  if (!value) return null;
  if (value.type === "Identifier") {
    const binding = context.requires?.get(value.name);
    if (!binding || binding.source !== source) return null;
    if (binding.props?.length) return binding.props.at(-1);
    return ["default", "*"].includes(binding.exportName) ? value.name : binding.exportName;
  }
  if (value.type === "MemberExpression" && !value.computed) {
    let root = unwrap(value.object);
    while (root?.type === "MemberExpression" && !root.computed) root = unwrap(root.object);
    const binding = root?.type === "Identifier" && context.requires?.get(root.name);
    return binding?.source === source ? value.property.name : null;
  }
  return null;
}

function callChain(node) {
  let value = unwrap(node);
  const modifiers = [];
  while (value?.type === "CallExpression") {
    const callee = unwrap(value.callee);
    if (callee?.type !== "MemberExpression" || callee.computed) {
      return { root: value, modifiers: modifiers.reverse() };
    }
    if (unwrap(callee.object)?.type !== "CallExpression") {
      return { root: value, modifiers: modifiers.reverse() };
    }
    modifiers.push({ name: callee.property.name, arguments: value.arguments, node: value });
    value = unwrap(callee.object);
  }
  return null;
}

function literalArgument(node, context) {
  return staticValue(node, { bindings: context.bindings, consts: context.consts });
}

function nullable(schema) {
  if (typeof schema.type === "string") return { ...schema, type: [schema.type, "null"] };
  if (Array.isArray(schema.type) && !schema.type.includes("null")) {
    return { ...schema, type: [...schema.type, "null"] };
  }
  return { anyOf: [schema, { type: "null" }] };
}

function numericConstraint(schema, name, value) {
  if (typeof value !== "number") return schema;
  if (schema.type === "string")
    return { ...schema, [name === "minimum" ? "minLength" : "maxLength"]: value };
  if (schema.type === "array")
    return { ...schema, [name === "minimum" ? "minItems" : "maxItems"]: value };
  return { ...schema, [name]: value };
}

function regexValue(node) {
  const value = unwrap(node);
  return value?.type === "Literal" && value.regex ? value.regex.pattern || null : null;
}

function applyCommonModifier(result, modifier, context, library) {
  const args = modifier.arguments;
  const first = literalArgument(args[0], context);
  let { schema, optional } = result;
  let handled = true;
  if (modifier.name === "optional") optional = true;
  else if (modifier.name === "required" || modifier.name === "exists") optional = false;
  else if (modifier.name === "nullable") schema = nullable(schema);
  else if (modifier.name === "default") {
    optional = true;
    if (first !== undefined) schema = { ...schema, default: first };
  } else if (modifier.name === "int" || modifier.name === "integer" || modifier.name === "toInt") {
    schema = { ...schema, type: "integer" };
  } else if (["min", "max"].includes(modifier.name)) {
    schema = numericConstraint(schema, modifier.name === "min" ? "minimum" : "maximum", first);
  } else if (modifier.name === "length" && typeof first === "number") {
    const minimum = schema.type === "array" ? "minItems" : "minLength";
    const maximum = schema.type === "array" ? "maxItems" : "maxLength";
    schema = { ...schema, [minimum]: first, [maximum]: first };
  } else if (modifier.name === "email") schema = { ...schema, type: "string", format: "email" };
  else if (["url", "uri"].includes(modifier.name)) {
    schema = { ...schema, type: "string", format: "uri" };
  } else if (modifier.name === "uuid") schema = { ...schema, type: "string", format: "uuid" };
  else if (["datetime", "isoDate"].includes(modifier.name)) {
    schema = { ...schema, type: "string", format: "date-time" };
  } else if (["valid", "oneOf"].includes(modifier.name)) {
    const values = library === "joi" ? args.map((arg) => literalArgument(arg, context)) : first;
    if (Array.isArray(values)) schema = { ...schema, enum: values };
  } else if (modifier.name === "allow" && first === null) schema = nullable(schema);
  else if (modifier.name === "nullish") {
    optional = true;
    schema = nullable(schema);
  } else if (["positive", "nonnegative"].includes(modifier.name)) {
    schema =
      modifier.name === "positive" ? { ...schema, exclusiveMinimum: 0 } : { ...schema, minimum: 0 };
  } else if (["regex", "pattern"].includes(modifier.name)) {
    const pattern = regexValue(args[0]);
    if (pattern) schema = { ...schema, type: "string", pattern };
    else handled = false;
  } else if (
    ["describe", "brand", "readonly", "withMessage", "bail", "trim"].includes(modifier.name)
  ) {
    // These calls do not change the representable JSON Schema shape.
  } else handled = false;
  return { schema, optional, handled };
}

function objectShape(node, context, library, seen) {
  const value = unwrap(node);
  if (value?.type !== "ObjectExpression") {
    return { schema: { type: "object" }, optional: false, complete: false };
  }
  const properties = [];
  const required = [];
  let complete = true;
  for (const property of value.properties || []) {
    if (property.type !== "Property" || property.computed) continue;
    const name =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.type === "Literal"
          ? String(property.key.value)
          : null;
    if (name === null) continue;
    const child = validationShape(property.value, context, seen);
    if (!child || child.library !== library) {
      complete = false;
      continue;
    }
    if (!child.complete) complete = false;
    properties.push([name, child.schema]);
    if (!child.optional) required.push(name);
  }
  return {
    schema: {
      type: "object",
      properties: dataObject(properties),
      ...(required.length ? { required: required.sort() } : {}),
    },
    optional: false,
    complete,
  };
}

function validationRoot(root, context, seen) {
  const callee = unwrap(root?.callee);
  const zodName = importedFunction(callee, context, "zod");
  const joiName =
    importedFunction(callee, context, "joi") || importedFunction(callee, context, "@hapi/joi");
  const library = zodName ? "zod" : joiName ? "joi" : null;
  const name = zodName || joiName;
  if (!library || !name) return null;
  if (name === "object") {
    return {
      ...objectShape(root.arguments[0], context, library, seen),
      optional: library === "joi",
      library,
    };
  }
  if (name === "array") {
    const child = root.arguments[0] && validationShape(root.arguments[0], context, seen);
    return {
      schema: { type: "array", items: child?.schema || {} },
      optional: library === "joi",
      complete: child ? child.complete : root.arguments.length === 0,
      library,
    };
  }
  if (name === "enum") {
    const values = literalArgument(root.arguments[0], context);
    return {
      schema: { type: "string", ...(Array.isArray(values) ? { enum: values } : {}) },
      optional: library === "joi",
      complete: Array.isArray(values),
      library,
    };
  }
  if (name === "literal") {
    const value = literalArgument(root.arguments[0], context);
    return {
      schema:
        value === undefined ? {} : { const: value, type: value === null ? "null" : typeof value },
      optional: library === "joi",
      complete: value !== undefined,
      library,
    };
  }
  const types = {
    string: "string",
    number: "number",
    boolean: "boolean",
    bigint: "integer",
    date: "string",
    object: "object",
  };
  if (!Object.hasOwn(types, name) && !["any", "unknown"].includes(name)) {
    return { schema: {}, optional: library === "joi", complete: false, library };
  }
  return {
    schema:
      name === "any" || name === "unknown"
        ? {}
        : { type: types[name] || "string", ...(name === "date" ? { format: "date-time" } : {}) },
    optional: library === "joi",
    complete: true,
    library,
  };
}

/** Interpret a local Zod or Joi schema expression without loading the package. */
function validationShape(node, context, seen = new Set()) {
  const value = unwrap(node);
  if (!value) return null;
  if (value.type === "Identifier") {
    const binding = context.bindings?.get(value.name);
    if (!binding || seen.has(value.name)) return null;
    return validationShape(binding, context, new Set(seen).add(value.name));
  }
  const chain = callChain(value);
  if (!chain) return null;
  let result = validationRoot(chain.root, context, seen);
  if (!result) return null;
  for (const modifier of chain.modifiers) {
    if (modifier.name === "array") {
      result = { ...result, schema: { type: "array", items: result.schema } };
      continue;
    }
    if (modifier.name === "items") {
      const child = modifier.arguments[0] && validationShape(modifier.arguments[0], context, seen);
      result = {
        ...result,
        schema: { ...result.schema, type: "array", items: child?.schema || {} },
        complete: result.complete && Boolean(child?.complete),
      };
      continue;
    }
    const applied = applyCommonModifier(result, modifier, context, result.library);
    result = { ...result, ...applied, complete: result.complete && applied.handled };
  }
  return result;
}

function requestBucket(node, reqName) {
  const value = unwrap(node);
  if (value?.type !== "MemberExpression" || value.computed) return null;
  const root = unwrap(value.object);
  if (root?.type !== "Identifier" || root.name !== reqName) return null;
  return REQUEST_MEMBER_BUCKETS.get(value.property.name) || null;
}

/** Add schemas used by `zod.parse(req.body)` or `joi.validate(req.query)`. */
function enrichHandlerSchemas(io, fn, context) {
  const req = fn.params?.[0];
  const reqName = req?.type === "Identifier" ? req.name : null;
  if (!reqName || !fn.body) return;
  walk(fn.body, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = unwrap(node.callee);
    if (callee?.type !== "MemberExpression" || callee.computed) return;
    if (!["parse", "safeParse", "validate", "validateAsync"].includes(callee.property.name)) return;
    const bucket = requestBucket(node.arguments[0], reqName);
    if (!bucket) return;
    const shape = validationShape(callee.object, context);
    if (!shape) return;
    addRequestSchema(
      io,
      bucket,
      contract(
        shape.schema,
        evidence(shape.library, shape.complete ? "high" : "medium", sourceFor(node, context)),
      ),
    );
  });
}

function expressValidatorRoot(root, context) {
  const name = importedFunction(root?.callee, context, EXPRESS_VALIDATOR);
  return name && (EXPRESS_VALIDATOR_BUCKETS.has(name) || name === "checkSchema") ? name : null;
}

function expressChainShape(modifiers, context) {
  let result = { schema: {}, optional: false, complete: true };
  for (const modifier of modifiers) {
    const first = Object.hasOwn(modifier, "value")
      ? modifier.value
      : literalArgument(modifier.arguments[0], context);
    if (modifier.name === "isString") result.schema = { ...result.schema, type: "string" };
    else if (modifier.name === "isInt" || modifier.name === "toInt") {
      result.schema = {
        ...result.schema,
        type: "integer",
        ...(first && typeof first === "object" && typeof first.min === "number"
          ? { minimum: first.min }
          : {}),
        ...(first && typeof first === "object" && typeof first.max === "number"
          ? { maximum: first.max }
          : {}),
      };
    } else if (modifier.name === "isFloat" || modifier.name === "toFloat") {
      result.schema = {
        ...result.schema,
        type: "number",
        ...(first && typeof first === "object" && typeof first.min === "number"
          ? { minimum: first.min }
          : {}),
        ...(first && typeof first === "object" && typeof first.max === "number"
          ? { maximum: first.max }
          : {}),
      };
    } else if (modifier.name === "isBoolean" || modifier.name === "toBoolean") {
      result.schema = { ...result.schema, type: "boolean" };
    } else if (modifier.name === "isArray")
      result.schema = { ...result.schema, type: "array", items: {} };
    else if (modifier.name === "isObject") result.schema = { ...result.schema, type: "object" };
    else if (modifier.name === "isEmail") {
      result.schema = { ...result.schema, type: "string", format: "email" };
    } else if (modifier.name === "isURL") {
      result.schema = { ...result.schema, type: "string", format: "uri" };
    } else if (modifier.name === "isUUID") {
      result.schema = { ...result.schema, type: "string", format: "uuid" };
    } else if (modifier.name === "isISO8601") {
      result.schema = { ...result.schema, type: "string", format: "date-time" };
    } else if (modifier.name === "notEmpty") {
      result.optional = false;
      result.schema = { ...result.schema, minLength: 1 };
    } else if (modifier.name === "isIn" && Array.isArray(first)) {
      result.schema = { ...result.schema, enum: first };
    } else if (modifier.name === "isLength" && first && typeof first === "object") {
      result.schema = {
        ...result.schema,
        ...(typeof first.min === "number" ? { minLength: first.min } : {}),
        ...(typeof first.max === "number" ? { maxLength: first.max } : {}),
      };
    } else {
      const applied = applyCommonModifier(result, modifier, context, "express-validator");
      result = { ...result, ...applied, complete: result.complete && applied.handled };
    }
  }
  return result;
}

function mergeObjectShape(target, incoming) {
  const properties = dataObject(Object.entries(target.properties || {}));
  for (const [name, value] of Object.entries(incoming.properties || {})) {
    if (!Object.hasOwn(properties, name)) properties[name] = value;
    else if (properties[name].type === "object" && value.type === "object") {
      properties[name] = mergeObjectShape(properties[name], value);
    } else if (properties[name].type == null && value.type != null) properties[name] = value;
  }
  const required = [...new Set([...(target.required || []), ...(incoming.required || [])])].sort();
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

function fieldShape(field, schema, required) {
  const tokens = String(field).match(/[^.[\]]+|\*/g) || [String(field)];
  let value = schema;
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index];
    if (token === "*") value = { type: "array", items: value };
    else {
      value = {
        type: "object",
        properties: dataObject([[token, value]]),
        ...(required ? { required: [token] } : {}),
      };
    }
  }
  return value;
}

function checkSchemaShapes(root, context) {
  const configuration = literalArgument(root.arguments[0], context);
  const defaults = literalArgument(root.arguments[1], context);
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration))
    return [];
  const output = [];
  for (const [field, rules] of Object.entries(configuration)) {
    if (!rules || typeof rules !== "object" || Array.isArray(rules)) continue;
    const configured = Array.isArray(rules.in) ? rules.in : rules.in ? [rules.in] : null;
    const locations =
      configured || (Array.isArray(defaults) ? defaults : ["body", "query", "params", "headers"]);
    const modifiers = Object.entries(rules)
      .filter(([name, enabled]) => name !== "in" && enabled !== false)
      .map(([name, value]) => ({
        name,
        arguments: [],
        value:
          value && typeof value === "object" && Object.hasOwn(value, "options")
            ? Array.isArray(value.options) && value.options.length === 1
              ? value.options[0]
              : value.options
            : undefined,
      }));
    const shape = expressChainShape(modifiers, {
      ...context,
      bindings: new Map(),
    });
    const optional = rules.optional === true || Boolean(rules.optional?.options);
    for (const location of locations) {
      const bucket = EXPRESS_VALIDATOR_BUCKETS.get(location === "params" ? "param" : location);
      if (bucket) {
        output.push({
          bucket,
          field,
          schema: shape.schema,
          required: !optional,
          complete: shape.complete,
        });
      }
    }
  }
  return output;
}

function argumentNodes(nodes, context, seen = new Set()) {
  const output = [];
  for (const node of nodes) {
    const value = unwrap(node);
    if (!value) continue;
    if (value.type === "ArrayExpression") {
      output.push(...argumentNodes(value.elements.filter(Boolean), context, seen));
    } else if (
      value.type === "Identifier" &&
      context.bindings?.has(value.name) &&
      !seen.has(value.name)
    ) {
      output.push(
        ...argumentNodes(
          [context.bindings.get(value.name)],
          context,
          new Set(seen).add(value.name),
        ),
      );
    } else output.push(value);
  }
  return output;
}

/** Add route-level `express-validator` chains and `checkSchema()` contracts. */
function enrichExpressValidatorSchemas(io, nodes, context) {
  const byBucket = new Map();
  const add = (bucket, shape, node, complete = true) => {
    const current = byBucket.get(bucket);
    byBucket.set(bucket, {
      schema: mergeObjectShape(current?.schema || { type: "object" }, shape),
      complete: (current?.complete ?? true) && complete,
      source: current?.source || sourceFor(node, context),
    });
  };
  for (const node of argumentNodes(nodes, context)) {
    const chain = callChain(node);
    if (!chain) continue;
    const rootName = expressValidatorRoot(chain.root, context);
    if (!rootName) continue;
    if (rootName === "checkSchema") {
      for (const item of checkSchemaShapes(chain.root, context)) {
        add(
          item.bucket,
          fieldShape(item.field, item.schema, item.required),
          chain.root,
          item.complete,
        );
      }
      continue;
    }
    const bucket = EXPRESS_VALIDATOR_BUCKETS.get(rootName);
    const fields = literalArgument(chain.root.arguments[0], context);
    const names = Array.isArray(fields) ? fields : typeof fields === "string" ? [fields] : [];
    const shape = expressChainShape(chain.modifiers, context);
    for (const field of names) {
      add(bucket, fieldShape(field, shape.schema, !shape.optional), chain.root, shape.complete);
    }
  }
  for (const [bucket, item] of byBucket) {
    addRequestSchema(
      io,
      bucket,
      contract(
        item.schema,
        evidence("express-validator", item.complete ? "high" : "medium", item.source),
      ),
    );
  }
}

module.exports = {
  enrichExpressValidatorSchemas,
  enrichHandlerSchemas,
  validationShape,
};
