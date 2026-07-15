"use strict";

const { walk, unwrap, staticString } = require("./ast");

const REQUEST_SOURCES = new Set(["body", "query", "params"]);
const HEADER_ACCESSORS = new Set(["get", "header"]);

/** Numeric literal value of an argument node, or null. */
function numericArg(node) {
  const n = unwrap(node);
  if (n && n.type === "Literal" && typeof n.value === "number") return n.value;
  return null;
}

/** Top-level own property names of an object-literal argument, or null. */
function objectKeys(node) {
  const n = unwrap(node);
  if (!n || n.type !== "ObjectExpression") return null;
  const keys = [];
  for (const prop of n.properties) {
    if (prop.type === "Property" && !prop.computed && prop.key.type === "Identifier")
      keys.push(prop.key.name);
    else if (prop.type === "Property" && !prop.computed && prop.key.type === "Literal")
      keys.push(String(prop.key.value));
  }
  return keys;
}

/** Parameter name if it's a plain identifier, else null (destructured/absent). */
function paramName(params, index) {
  const p = params && params[index];
  return p && p.type === "Identifier" ? p.name : null;
}

/**
 * Classify a `res.…()` call within the handler. Walks the receiver chain to
 * confirm it is rooted at `resName`, picking up a `.status(N)` seen along the
 * way (so `res.status(201).json(...)` reports status 201).
 *
 * @returns {{method: string, status: number|null}|null}
 */
function resChain(callNode, resName) {
  const callee = unwrap(callNode.callee);
  if (!callee || callee.type !== "MemberExpression" || callee.computed) return null;
  const method = callee.property.name;
  let status = null;
  let obj = unwrap(callee.object);
  while (obj) {
    if (obj.type === "Identifier") return obj.name === resName ? { method, status } : null;
    if (obj.type === "CallExpression") {
      const inner = unwrap(obj.callee);
      if (!inner || inner.type !== "MemberExpression" || inner.computed) return null;
      if (inner.property.name === "status") {
        const n = numericArg(obj.arguments[0]);
        if (n != null) status = n;
      }
      obj = unwrap(inner.object);
      continue;
    }
    return null;
  }
  return null;
}

/** Merge a response record into the accumulator, keyed by status, unioning keys. */
function addResponse(responses, status, bodyKeys) {
  const existing = responses.get(status);
  if (!existing) {
    responses.set(status, new Set(bodyKeys || []));
    if (bodyKeys == null) responses.set(status, null);
    return;
  }
  if (existing === null || bodyKeys == null) return;
  for (const k of bodyKeys) existing.add(k);
}

function collectResponse(node, resName, responses, statusCodes) {
  const chain = resChain(node, resName);
  if (!chain) return;
  const { method, status } = chain;
  if (method === "status") {
    if (status != null) statusCodes.add(status);
  } else if (method === "json") {
    addResponse(responses, status ?? 200, objectKeys(node.arguments[0]) || []);
  } else if (method === "send") {
    addResponse(responses, status ?? 200, objectKeys(node.arguments[0]));
  } else if (method === "sendStatus") {
    const code = numericArg(node.arguments[0]);
    if (code != null) addResponse(responses, code, null);
  }
}

/** `req.<source>.<field>` / `req.headers['x']` member reads. */
function collectMemberRead(node, reqName, request) {
  const obj = unwrap(node.object);
  if (!obj || obj.type !== "MemberExpression" || obj.computed) return;
  const root = unwrap(obj.object);
  if (!root || root.type !== "Identifier" || root.name !== reqName) return;
  const source = obj.property.name;
  const field =
    node.computed && node.property.type === "Literal"
      ? String(node.property.value)
      : !node.computed && node.property.type === "Identifier"
        ? node.property.name
        : null;
  if (field == null) return;
  if (REQUEST_SOURCES.has(source)) request[source].add(field);
  else if (source === "headers") request.headers.add(field);
}

/** `req.get('x')` / `req.header('x')` header reads. */
function collectHeaderCall(node, reqName, request) {
  const callee = unwrap(node.callee);
  if (!callee || callee.type !== "MemberExpression" || callee.computed) return;
  if (!HEADER_ACCESSORS.has(callee.property.name)) return;
  const root = unwrap(callee.object);
  if (!root || root.type !== "Identifier" || root.name !== reqName) return;
  const key = staticString(node.arguments[0]);
  if (key != null) request.headers.add(key);
}

/** `const { a, b } = req.<source>` destructuring. */
function collectDestructure(node, reqName, request) {
  if (node.id.type !== "ObjectPattern" || !node.init) return;
  const init = unwrap(node.init);
  if (!init || init.type !== "MemberExpression" || init.computed) return;
  const root = unwrap(init.object);
  if (!root || root.type !== "Identifier" || root.name !== reqName) return;
  const source = init.property.name;
  const bucket = REQUEST_SOURCES.has(source) ? source : source === "headers" ? "headers" : null;
  if (!bucket) return;
  for (const prop of node.id.properties) {
    if (prop.type === "Property" && prop.key.type === "Identifier")
      request[bucket].add(prop.key.name);
  }
}

function toSortedArray(set) {
  return [...set].sort();
}

/**
 * Statically mine request/response shape hints from a route handler's AST body.
 * A best-effort audit aid: it captures field names the code references, not a
 * complete schema (which an AI pass refines). `req`/`res` are matched by their
 * parameter identifiers; a destructured parameter disables that half.
 *
 * @param {object} fnNode  a Function/Arrow node (the handler)
 * @returns {{request: {body: string[], query: string[], params: string[], headers: string[]},
 *            responses: {status: number|null, bodyKeys: string[]|null}[],
 *            statusCodes: number[]}}
 */
function extractIoHints(fnNode) {
  const request = { body: new Set(), query: new Set(), params: new Set(), headers: new Set() };
  const responses = new Map();
  const statusCodes = new Set();
  const reqName = paramName(fnNode.params, 0);
  const resName = paramName(fnNode.params, 1);
  const body = fnNode.body;
  if (body) {
    walk(body, (node) => {
      if (reqName) {
        if (node.type === "MemberExpression") collectMemberRead(node, reqName, request);
        else if (node.type === "CallExpression") collectHeaderCall(node, reqName, request);
        else if (node.type === "VariableDeclarator") collectDestructure(node, reqName, request);
      }
      if (resName && node.type === "CallExpression")
        collectResponse(node, resName, responses, statusCodes);
    });
  }
  const responseList = [...responses.entries()]
    .map(([status, keys]) => ({ status, bodyKeys: keys === null ? null : toSortedArray(keys) }))
    .sort((a, b) => (a.status ?? 0) - (b.status ?? 0));
  return {
    request: {
      body: toSortedArray(request.body),
      query: toSortedArray(request.query),
      params: toSortedArray(request.params),
      headers: toSortedArray(request.headers),
    },
    responses: responseList,
    statusCodes: [...statusCodes].sort((a, b) => a - b),
  };
}

module.exports = { extractIoHints };
