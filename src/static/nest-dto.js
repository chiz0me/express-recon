"use strict";

const { unwrap } = require("./ast");
const { dataObject, staticValue } = require("./schema-evidence");

const VALIDATOR = "class-validator";
const SWAGGER = "@nestjs/swagger";
const MAX_DTO_DEPTH = 12;
const SHAPE_DECORATORS = new Set([
  "ApiProperty",
  "ApiPropertyOptional",
  "ArrayMaxSize",
  "ArrayMinSize",
  "IsArray",
  "IsBoolean",
  "IsDateString",
  "IsEmail",
  "IsIn",
  "IsInt",
  "IsISO8601",
  "IsNumber",
  "IsObject",
  "IsString",
  "IsUrl",
  "IsURL",
  "IsUUID",
  "Length",
  "Matches",
  "Max",
  "MaxLength",
  "Min",
  "MinLength",
]);

function importedName(node, context, source) {
  const value = unwrap(node);
  if (!value) return null;
  if (value.type === "Identifier") {
    const binding = context.requires.get(value.name);
    if (!binding || binding.source !== source) return null;
    if (binding.props?.length) return binding.props.at(-1);
    return ["default", "*"].includes(binding.exportName) ? value.name : binding.exportName;
  }
  if (value.type === "MemberExpression" && !value.computed) {
    let root = unwrap(value.object);
    while (root?.type === "MemberExpression" && !root.computed) root = unwrap(root.object);
    const binding = root?.type === "Identifier" && context.requires.get(root.name);
    return binding?.source === source ? value.property.name : null;
  }
  return null;
}

function decoratorCall(decorator, context) {
  const expression = unwrap(decorator?.expression);
  if (!expression) return null;
  const call = expression.type === "CallExpression" ? expression : null;
  const callee = call ? call.callee : expression;
  for (const source of [VALIDATOR, SWAGGER]) {
    const name = importedName(callee, context, source);
    if (name) return { name, source, arguments: call?.arguments || [], node: expression };
  }
  return null;
}

function typeName(node) {
  const value = unwrap(node);
  if (value?.type === "Identifier") return value.name;
  if (value?.type === "TSQualifiedName") return `${typeName(value.left)}.${typeName(value.right)}`;
  return null;
}

function literalType(node) {
  const value = unwrap(node?.literal);
  if (value?.type !== "Literal") return {};
  const type = value.value === null ? "null" : typeof value.value;
  return {
    const: value.value,
    ...(type === "number" && Number.isInteger(value.value) ? { type: "integer" } : { type }),
  };
}

function unionSchema(types, resolve, depth, seen) {
  const schemas = types
    .filter(
      (type) => !["TSUndefinedKeyword", "TSVoidKeyword", "TSNeverKeyword"].includes(type.type),
    )
    .map((type) => schemaFromType(type, resolve, depth + 1, seen));
  const unique = [...new Map(schemas.map((schema) => [JSON.stringify(schema), schema])).values()];
  return unique.length === 1 ? unique[0] : { anyOf: unique };
}

/** Convert an oxc TypeScript type node into a conservative JSON Schema fragment. */
function schemaFromType(annotation, resolve, depth = 0, seen = new Set()) {
  const type = annotation?.type === "TSTypeAnnotation" ? annotation.typeAnnotation : annotation;
  if (!type || depth > MAX_DTO_DEPTH) return {};
  const primitive = {
    TSStringKeyword: "string",
    TSNumberKeyword: "number",
    TSBooleanKeyword: "boolean",
    TSBigIntKeyword: "integer",
    TSObjectKeyword: "object",
    TSNullKeyword: "null",
    TSAnyKeyword: null,
    TSUnknownKeyword: null,
  };
  if (Object.hasOwn(primitive, type.type)) {
    return primitive[type.type] ? { type: primitive[type.type] } : {};
  }
  if (type.type === "TSLiteralType") return literalType(type);
  if (type.type === "TSArrayType") {
    return { type: "array", items: schemaFromType(type.elementType, resolve, depth + 1, seen) };
  }
  if (type.type === "TSTupleType") {
    return {
      type: "array",
      prefixItems: (type.elementTypes || []).map((item) =>
        schemaFromType(item, resolve, depth + 1, seen),
      ),
    };
  }
  if (type.type === "TSUnionType") return unionSchema(type.types || [], resolve, depth, seen);
  if (type.type === "TSParenthesizedType") {
    return schemaFromType(type.typeAnnotation, resolve, depth + 1, seen);
  }
  if (type.type === "TSTypeReference") {
    const name = typeName(type.typeName);
    const parameters = type.typeArguments?.params || type.typeArguments?.parameters || [];
    if (["Array", "ReadonlyArray", "Set"].includes(name)) {
      return { type: "array", items: schemaFromType(parameters[0], resolve, depth + 1, seen) };
    }
    if (name === "Date") return { type: "string", format: "date-time" };
    if (name === "Record")
      return {
        type: "object",
        additionalProperties: schemaFromType(parameters[1], resolve, depth + 1, seen),
      };
    if (name && !seen.has(name)) {
      const resolved = resolve(name, depth + 1, new Set(seen).add(name));
      if (resolved) return resolved;
    }
    return {};
  }
  if (type.type === "TSTypeLiteral") {
    const properties = [];
    const required = [];
    for (const member of type.members || []) {
      if (member.type !== "TSPropertySignature" || member.computed) continue;
      const name = member.key?.name ?? member.key?.value;
      if (name == null) continue;
      properties.push([
        String(name),
        schemaFromType(member.typeAnnotation, resolve, depth + 1, seen),
      ]);
      if (!member.optional) required.push(String(name));
    }
    return {
      type: "object",
      properties: dataObject(properties),
      ...(required.length ? { required } : {}),
    };
  }
  return {};
}

function regexPattern(node) {
  const value = unwrap(node);
  if (value?.type !== "Literal" || !value.regex) return null;
  return value.regex.pattern || null;
}

function applyDecorator(schema, call, context) {
  const first = staticValue(call.arguments[0], {
    bindings: context.valueBindings,
    consts: context.consts,
    partialObjects: true,
  });
  const types = {
    IsString: "string",
    IsNumber: "number",
    IsInt: "integer",
    IsBoolean: "boolean",
    IsArray: "array",
    IsObject: "object",
  };
  if (types[call.name]) {
    schema = { ...schema, type: types[call.name] };
    if (call.name === "IsArray" && !schema.items) schema.items = {};
  } else if (call.name === "IsEmail") schema = { ...schema, type: "string", format: "email" };
  else if (call.name === "IsUrl" || call.name === "IsURL") {
    schema = { ...schema, type: "string", format: "uri" };
  } else if (call.name === "IsUUID") schema = { ...schema, type: "string", format: "uuid" };
  else if (call.name === "IsDateString" || call.name === "IsISO8601") {
    schema = { ...schema, type: "string", format: "date-time" };
  } else if (call.name === "Min" && typeof first === "number")
    schema = { ...schema, minimum: first };
  else if (call.name === "Max" && typeof first === "number") schema = { ...schema, maximum: first };
  else if (call.name === "MinLength" && typeof first === "number")
    schema = { ...schema, minLength: first };
  else if (call.name === "MaxLength" && typeof first === "number")
    schema = { ...schema, maxLength: first };
  else if (call.name === "Length" && typeof first === "number") {
    const maximum = staticValue(call.arguments[1], {
      bindings: context.valueBindings,
      consts: context.consts,
    });
    schema = {
      ...schema,
      minLength: first,
      ...(typeof maximum === "number" ? { maxLength: maximum } : {}),
    };
  } else if (call.name === "ArrayMinSize" && typeof first === "number")
    schema = { ...schema, minItems: first };
  else if (call.name === "ArrayMaxSize" && typeof first === "number")
    schema = { ...schema, maxItems: first };
  else if (call.name === "IsIn" && Array.isArray(first)) schema = { ...schema, enum: first };
  else if (call.name === "Matches") {
    const pattern = regexPattern(call.arguments[0]);
    if (pattern) schema = { ...schema, type: "string", pattern };
  } else if (["ApiProperty", "ApiPropertyOptional"].includes(call.name)) {
    const options = first;
    if (options && typeof options === "object" && !Array.isArray(options)) {
      const allowed = [
        "description",
        "example",
        "format",
        "minimum",
        "maximum",
        "minLength",
        "maxLength",
        "minItems",
        "maxItems",
        "pattern",
      ];
      for (const key of allowed)
        if (options[key] !== undefined) schema = { ...schema, [key]: options[key] };
      if (Array.isArray(options.enum)) schema = { ...schema, enum: options.enum };
      if (options.nullable === true) {
        schema =
          typeof schema.type === "string" ? { ...schema, type: [schema.type, "null"] } : schema;
      }
    }
  }
  return schema;
}

function propertyName(property) {
  if (property.computed) return null;
  if (property.key?.type === "Identifier") return property.key.name;
  if (property.key?.type === "Literal") return String(property.key.value);
  return null;
}

/** Index same-file DTO classes, TypeScript fields, and validation decorators. */
function buildDtoModels(program, context) {
  const nodes = new Map();
  for (const statement of program.body || []) {
    const declaration = ["ExportNamedDeclaration", "ExportDefaultDeclaration"].includes(
      statement.type,
    )
      ? statement.declaration
      : statement;
    if (declaration?.type === "ClassDeclaration" && declaration.id) {
      nodes.set(declaration.id.name, declaration);
    }
  }
  const models = new Map();
  const build = (name, depth = 0, seen = new Set()) => {
    if (models.has(name)) return models.get(name);
    const node = nodes.get(name);
    if (!node || depth > MAX_DTO_DEPTH || seen.has(name)) return null;
    const nextSeen = new Set(seen).add(name);
    const properties = [];
    const required = [];
    let validatorDecorators = 0;
    let swaggerDecorators = 0;
    let describedProperties = 0;
    const resolve = (target, targetDepth, targetSeen) =>
      build(target, targetDepth, targetSeen)?.schema;
    for (const property of node.body.body || []) {
      if (property.type !== "PropertyDefinition") continue;
      const key = propertyName(property);
      if (key === null) continue;
      const calls = (property.decorators || [])
        .map((item) => decoratorCall(item, context))
        .filter(Boolean);
      validatorDecorators += calls.filter((item) => item.source === VALIDATOR).length;
      swaggerDecorators += calls.filter((item) => item.source === SWAGGER).length;
      if (calls.some((item) => SHAPE_DECORATORS.has(item.name))) describedProperties++;
      let schema = schemaFromType(property.typeAnnotation, resolve, depth + 1, nextSeen);
      for (const call of calls) schema = applyDecorator(schema, call, context);
      const optional =
        property.optional ||
        calls.some((call) => ["IsOptional", "ApiPropertyOptional"].includes(call.name)) ||
        calls.some(
          (call) =>
            call.name === "ApiProperty" &&
            staticValue(call.arguments[0], {
              bindings: context.valueBindings,
              consts: context.consts,
              partialObjects: true,
            })?.required === false,
        );
      properties.push([key, schema]);
      if (!optional || calls.some((call) => call.name === "IsDefined")) required.push(key);
    }
    if (properties.length === 0) return null;
    const model = {
      schema: {
        type: "object",
        properties: dataObject(properties),
        ...(required.length ? { required: required.sort() } : {}),
      },
      evidenceKinds: [
        "nestjs-dto",
        ...(validatorDecorators ? ["class-validator"] : []),
        ...(swaggerDecorators ? ["nestjs-swagger"] : []),
      ],
      confidence: describedProperties === properties.length ? "high" : "medium",
      line: context.lineAt(node.start),
    };
    models.set(name, model);
    return model;
  };
  for (const name of nodes.keys()) build(name);
  return models;
}

function parameterTypeReference(parameter, context) {
  const type = parameter.typeAnnotation?.typeAnnotation;
  if (type?.type !== "TSTypeReference") return null;
  const name = typeName(type.typeName);
  if (!name || name.includes(".")) return null;
  const binding = context.requires.get(name);
  return binding
    ? {
        type: "module",
        source: binding.source,
        exportName: binding.exportName,
        props: binding.props || [],
      }
    : { type: "local", name };
}

/** Resolve a controller parameter's TypeScript shape and optional DTO reference. */
function parameterSchema(parameter, context, dtoModels) {
  const ref = parameterTypeReference(parameter, context);
  if (ref?.type === "local" && dtoModels.has(ref.name)) {
    const model = dtoModels.get(ref.name);
    return {
      schema: model.schema,
      evidenceKinds: model.evidenceKinds,
      confidence: model.confidence,
      ref: null,
    };
  }
  const resolve = (name) => dtoModels.get(name)?.schema || null;
  return {
    schema: schemaFromType(parameter.typeAnnotation, resolve),
    evidenceKinds: ["typescript"],
    confidence: "medium",
    ref: ref?.type === "module" ? ref : null,
  };
}

module.exports = { buildDtoModels, parameterSchema, schemaFromType };
