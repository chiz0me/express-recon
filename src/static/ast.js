"use strict";

const oxc = require("oxc-parser");
const { descriptor } = require("../middleware");

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);

const TS_WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSInstantiationExpression",
  "ParenthesizedExpression",
]);

/**
 * Parse a JS/TS/JSX source file into an ESTree program. oxc-parser strips
 * TypeScript types and infers the dialect from the filename extension. Returns
 * null if parsing produced no usable program (the caller skips the file).
 *
 * @param {string} code
 * @param {string} filename  used by oxc to pick the dialect (.ts/.tsx/.js…)
 * @returns {object|null}
 */
function parse(code, filename) {
  try {
    const result = oxc.parseSync(filename, code);
    const program = result && result.program;
    return program && Array.isArray(program.body) ? program : null;
  } catch {
    return null;
  }
}

/** Strip TS-only expression wrappers (`x as T`, `x!`, `(x)`) to the inner node. */
function unwrap(node) {
  let current = node;
  while (current && TS_WRAPPERS.has(current.type)) current = current.expression;
  return current;
}

/** Build a dotted name from a MemberExpression/Identifier callee (`a.b.c`). */
function calleeName(node) {
  const n = unwrap(node);
  if (!n) return null;
  if (n.type === "Identifier") return n.name;
  if (n.type === "MemberExpression" && !n.computed) {
    const obj = calleeName(n.object);
    return obj ? `${obj}.${n.property.name}` : null;
  }
  return null;
}

/** Extract a static string from a string literal or expression-free template. */
function staticString(node) {
  const n = unwrap(node);
  if (!n) return null;
  if (n.type === "Literal" && typeof n.value === "string") return n.value;
  if (n.type === "TemplateLiteral" && n.expressions.length === 0) {
    return n.quasis.map((q) => q.value.cooked).join("");
  }
  return null;
}

/** Best-effort one-line source snippet for a node, for the audit trail. */
function snippet(code, node, max = 80) {
  const text = code.slice(node.start, node.end).replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/**
 * Turn a call argument node into a middleware descriptor.
 *
 * @param {object} arg  argument AST node
 * @param {string} code  full source (for snippets)
 * @returns {import("../middleware").Descriptor}
 */
function middlewareFromArg(arg, code) {
  const node = unwrap(arg);
  if (node.type === "Identifier") {
    return descriptor({ name: node.name, kind: "identifier", raw: node.name });
  }
  if (node.type === "MemberExpression") {
    const name = calleeName(node);
    return descriptor({
      name: name || "<anonymous>",
      kind: "identifier",
      raw: snippet(code, node),
    });
  }
  if (node.type === "CallExpression") {
    const name = calleeName(node.callee);
    return descriptor({ name: name || "<anonymous>", kind: "call", raw: snippet(code, node) });
  }
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
    return descriptor({ name: "<anonymous>", kind: "anonymous", raw: "<inline fn>" });
  }
  return descriptor({ name: "<anonymous>", kind: "unknown", raw: snippet(code, node) });
}

module.exports = {
  parse,
  unwrap,
  calleeName,
  staticString,
  snippet,
  middlewareFromArg,
  HTTP_METHODS,
};
