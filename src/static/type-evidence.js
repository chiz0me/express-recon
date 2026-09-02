"use strict";

const { parse, unwrap, walk } = require("./ast");
const { schemaFromType } = require("./nest-dto");
const { addRequestSchema, addResponseSchema, contract, evidence } = require("./schema-evidence");

const REQUEST_BUCKETS = new Set(["body", "query", "params", "headers"]);
const EXPRESS_TYPES = new Set(["Request", "Response", "RequestHandler"]);
const MAX_DOCUMENTATION_LENGTH = 4_000;

function declaration(statement) {
  return ["ExportNamedDeclaration", "ExportDefaultDeclaration"].includes(statement?.type)
    ? statement.declaration
    : statement;
}

function typeName(node) {
  const value = unwrap(node);
  if (value?.type === "Identifier") return value.name;
  if (value?.type === "TSQualifiedName") return `${typeName(value.left)}.${typeName(value.right)}`;
  return null;
}

function typeArguments(node) {
  const type = node?.type === "TSTypeAnnotation" ? node.typeAnnotation : node;
  return type?.type === "TSTypeReference"
    ? type.typeArguments?.params || type.typeArguments?.parameters || []
    : [];
}

function mergeObjects(values) {
  const objects = values.filter((value) => value?.type === "object");
  if (!objects.length) return {};
  const properties = Object.fromEntries(
    objects.flatMap((value) => Object.entries(value.properties || {})),
  );
  const required = [...new Set(objects.flatMap((value) => value.required || []))].sort();
  return {
    type: "object",
    ...(Object.keys(properties).length ? { properties } : {}),
    ...(required.length ? { required } : {}),
  };
}

/** Build a bounded resolver for same-file TypeScript aliases and interfaces. */
function createTypeResolver(program) {
  const nodes = new Map();
  for (const statement of program.body || []) {
    const node = declaration(statement);
    if (["TSTypeAliasDeclaration", "TSInterfaceDeclaration"].includes(node?.type) && node.id) {
      nodes.set(node.id.name, node);
    }
  }
  const cache = new Map();
  const resolve = (name, depth = 0, seen = new Set()) => {
    if (cache.has(name)) return structuredClone(cache.get(name));
    if (depth > 12 || seen.has(name)) return null;
    const node = nodes.get(name);
    if (!node) return null;
    const nextSeen = new Set(seen).add(name);
    let value;
    if (node.type === "TSTypeAliasDeclaration") {
      value = schemaFromType(node.typeAnnotation, resolve, depth + 1, nextSeen);
    } else {
      const own = schemaFromType(
        { type: "TSTypeLiteral", members: node.body?.body || [] },
        resolve,
        depth + 1,
        nextSeen,
      );
      const inherited = (node.extends || [])
        .map((item) => resolve(typeName(item.expression), depth + 1, nextSeen))
        .filter(Boolean);
      value = mergeObjects([...inherited, own]);
    }
    cache.set(name, value);
    return structuredClone(value);
  };
  return resolve;
}

function importedExpressType(node, requires) {
  const type = node?.type === "TSTypeAnnotation" ? node.typeAnnotation : node;
  if (type?.type !== "TSTypeReference") return null;
  const name = typeName(type.typeName);
  if (!name) return null;
  const parts = name.split(".");
  const root = parts[0];
  const binding = requires?.get(root);
  let candidate = parts.at(-1);
  if (binding?.source === "express") {
    candidate =
      parts.length > 1
        ? parts.at(-1)
        : [...(binding.props || []), binding.exportName]
            .filter((item) => item && !["default", "*"].includes(item))
            .at(-1) || root;
  } else if (!(root === "Express" && parts.length === 2)) {
    return null;
  }
  return EXPRESS_TYPES.has(candidate) ? { name: candidate, arguments: typeArguments(type) } : null;
}

function usableSchema(schema) {
  return Boolean(schema && typeof schema === "object" && Object.keys(schema).length > 0);
}

function addTypedContract(io, bucket, type, options, source) {
  if (!type) return;
  const schema = schemaFromType(type, options.typeResolver);
  if (!usableSchema(schema)) return;
  addRequestSchema(io, bucket, contract(schema, evidence("typescript", "medium", source)));
}

function addTypedResponse(io, type, options, source) {
  if (!type) return;
  const schema = schemaFromType(type, options.typeResolver);
  if (!usableSchema(schema)) return;
  const statuses = [
    ...new Set([
      ...(io.responses || []).map((item) => item.status).filter((item) => item !== null),
      ...(io.statusCodes || []),
    ]),
  ];
  for (const status of statuses.length ? statuses : [null]) {
    addResponseSchema(io, status, contract(schema, evidence("typescript", "medium", source)));
  }
}

/** Apply Express Request/Response/RequestHandler generic arguments as schema evidence. */
function enrichTypeScriptIo(io, fnNode, options = {}) {
  const source =
    options.file && options.lineAt
      ? { file: options.file, line: options.lineAt(fnNode.start) }
      : null;
  const handler = importedExpressType(options.functionType, options.requires);
  const request =
    handler?.name === "RequestHandler"
      ? handler
      : importedExpressType(fnNode.params?.[0]?.typeAnnotation, options.requires);
  const response = importedExpressType(fnNode.params?.[1]?.typeAnnotation, options.requires);
  const requestArguments =
    request?.name === "Request" || request?.name === "RequestHandler" ? request.arguments : [];
  addTypedContract(io, "params", requestArguments[0], options, source);
  addTypedContract(io, "body", requestArguments[2], options, source);
  addTypedContract(io, "query", requestArguments[3], options, source);
  addTypedResponse(io, response?.arguments[0] || requestArguments[1], options, source);
}

function nearestLeadingJSDoc(comments, code, start) {
  let selected = null;
  for (const comment of comments || []) {
    if (comment.type !== "Block" || !comment.value.startsWith("*") || comment.end > start) continue;
    if (!selected || comment.end > selected.end) selected = comment;
  }
  if (!selected || code.slice(selected.end, start).trim()) return null;
  return selected;
}

/** Associate leading JSDoc blocks with function nodes without retaining source text. */
function collectHandlerJSDoc(program, code) {
  const docs = new Map();
  const comments = program.__comments || [];
  const add = (fn, boundary) => {
    const comment = nearestLeadingJSDoc(comments, code, boundary);
    if (comment) docs.set(fn.start, comment.value);
  };
  walk(program, (node) => {
    if (node.type === "FunctionDeclaration") add(node, node.start);
    if (node.type !== "VariableDeclaration") return;
    for (const item of node.declarations || []) {
      const fn = item.init && unwrap(item.init);
      if (["FunctionExpression", "ArrowFunctionExpression"].includes(fn?.type)) add(fn, node.start);
    }
  });
  return docs;
}

/** Record RequestHandler annotations placed on a named arrow/function expression. */
function collectHandlerTypes(program) {
  const types = new Map();
  walk(program, (node) => {
    if (node.type !== "VariableDeclarator" || !node.id?.typeAnnotation || !node.init) return;
    const fn = unwrap(node.init);
    if (["FunctionExpression", "ArrowFunctionExpression"].includes(fn?.type)) {
      types.set(fn.start, node.id.typeAnnotation);
    }
  });
  return types;
}

function cleanedLines(value) {
  return value.split(/\r?\n/).map((line) => line.replace(/^\s*\*?\s?/, "").trimEnd());
}

function parsedTag(line, tag) {
  const prefix = `@${tag}`;
  if (!line.startsWith(prefix) || !/\s/.test(line[prefix.length] || "")) return null;
  let rest = line.slice(prefix.length).trim();
  let type = null;
  if (rest.startsWith("{")) {
    let depth = 0;
    let quote = null;
    let escaped = false;
    let end = -1;
    for (let index = 0; index < rest.length; index++) {
      const character = rest[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quote && character === "\\") {
        escaped = true;
        continue;
      }
      if (quote) {
        if (character === quote) quote = null;
        continue;
      }
      if (['"', "'", "`"].includes(character)) quote = character;
      else if (character === "{") depth++;
      else if (character === "}" && --depth === 0) {
        end = index;
        break;
      }
    }
    if (end < 0) return null;
    type = rest.slice(1, end).trim();
    rest = rest.slice(end + 1).trim();
  }
  return { type, rest };
}

function typeTextSchema(value) {
  if (!value) return {};
  let normalized = value.trim();
  if (normalized.startsWith("?")) normalized = `${normalized.slice(1)} | null`;
  else if (normalized.startsWith("!")) normalized = normalized.slice(1);
  if (normalized.startsWith("...") && normalized.length > 3) {
    normalized = `Array<${normalized.slice(3)}>`;
  }
  if (normalized.endsWith("=")) normalized = normalized.slice(0, -1);
  normalized = normalized
    .replace(/^Object\.<\s*([^,<>]+)\s*,\s*(.+)>$/, "Record<$1, $2>")
    .replace(/^Object\.<(.+)>$/, "Record<string, $1>")
    .replace(/\b(Array|Promise|ReadonlyArray|Set)\.</g, "$1<")
    .replace(/\bString\b/g, "string")
    .replace(/\bNumber\b/g, "number")
    .replace(/\bBoolean\b/g, "boolean")
    .replace(/^Object$/, "object")
    .replace(/^\*$/, "unknown");
  const program = parse(`type __ExpressReconJSDoc = ${normalized};`, "jsdoc-type.ts");
  const node = program && declaration(program.body[0]);
  if (node?.type !== "TSTypeAliasDeclaration") return {};
  return schemaFromType(node.typeAnnotation, createTypeResolver(program));
}

function parseParameterName(value) {
  const token = value.split(/\s+/, 1)[0] || "";
  const optional = token.startsWith("[") && token.endsWith("]");
  const unwrapped = optional ? token.slice(1, -1) : token;
  return { name: unwrapped.split("=", 1)[0], optional, consumed: token.length };
}

function defineNestedProperty(schema, parts, value, required) {
  let current = schema;
  for (const [index, part] of parts.entries()) {
    current.type = "object";
    current.properties ||= {};
    const last = index === parts.length - 1;
    current.properties[part] ||= last ? value : { type: "object", properties: {} };
    if (last) current.properties[part] = { ...current.properties[part], ...value };
    if (required) current.required = [...new Set([...(current.required || []), part])].sort();
    current = current.properties[part];
  }
}

function documentationFromLines(lines, source) {
  const prose = [];
  let explicitSummary = null;
  for (const line of lines) {
    if (line.startsWith("@")) {
      const summary = parsedTag(line, "summary");
      if (summary?.rest) explicitSummary = summary.rest.slice(0, 200);
      continue;
    }
    if (line || prose.length) prose.push(line);
  }
  const description = prose.join("\n").trim().slice(0, MAX_DOCUMENTATION_LENGTH);
  const first = description.split(/(?<=[.!?])\s|\n/, 1)[0]?.trim();
  const summary = explicitSummary || (first && first.length <= 200 ? first : null);
  return description || summary
    ? {
        ...(summary ? { summary } : {}),
        ...(description && description !== summary ? { description } : {}),
        ...(source ? { source } : {}),
      }
    : null;
}

/** Apply ordinary handler JSDoc prose, @param fields, and @returns types. */
function enrichJSDocIo(io, fnNode, options = {}) {
  const comment = options.jsdoc;
  if (!comment) return;
  const lines = cleanedLines(comment);
  const source =
    options.file && options.lineAt
      ? { file: options.file, line: options.lineAt(fnNode.start) }
      : null;
  const documentation = documentationFromLines(lines, source);
  if (documentation) io.documentation = documentation;
  const requestName = fnNode.params?.[0]?.type === "Identifier" ? fnNode.params[0].name : null;
  const buckets = new Map();
  for (const line of lines) {
    const parameter =
      parsedTag(line, "param") || parsedTag(line, "arg") || parsedTag(line, "argument");
    if (!parameter) continue;
    const parsedName = parseParameterName(parameter.rest);
    const parts = parsedName.name.split(".");
    if (!requestName || parts[0] !== requestName || !REQUEST_BUCKETS.has(parts[1])) continue;
    const bucket = parts[1];
    const description = parameter.rest
      .slice(parsedName.consumed)
      .trim()
      .replace(/^[-–—]\s*/, "")
      .slice(0, MAX_DOCUMENTATION_LENGTH);
    const schema = typeTextSchema(parameter.type);
    if (description) schema.description = description;
    if (parts.length === 2) buckets.set(bucket, schema);
    else {
      const root = buckets.get(bucket) || { type: "object", properties: {} };
      defineNestedProperty(root, parts.slice(2), schema, !parsedName.optional);
      buckets.set(bucket, root);
    }
  }
  for (const [bucket, schema] of buckets) {
    if (usableSchema(schema)) {
      addRequestSchema(io, bucket, contract(schema, evidence("jsdoc", "medium", source)));
    }
  }
  const returns = lines
    .map((line) => parsedTag(line, "returns") || parsedTag(line, "return"))
    .find(Boolean);
  if (!returns?.type) return;
  const schema = typeTextSchema(returns.type);
  const description = returns.rest
    .trim()
    .replace(/^[-–—]\s*/, "")
    .slice(0, MAX_DOCUMENTATION_LENGTH);
  if (description) schema.description = description;
  if (!usableSchema(schema)) return;
  const statuses = [
    ...new Set([
      ...(io.responses || []).map((item) => item.status).filter((item) => item !== null),
      ...(io.statusCodes || []),
    ]),
  ];
  for (const status of statuses.length ? statuses : [null]) {
    addResponseSchema(io, status, contract(schema, evidence("jsdoc", "medium", source)));
  }
}

module.exports = {
  collectHandlerJSDoc,
  collectHandlerTypes,
  createTypeResolver,
  enrichJSDocIo,
  enrichTypeScriptIo,
};
