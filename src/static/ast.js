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
 * null if parsing produced errors or no usable program. The optional callback
 * lets the scanner surface the failure instead of silently losing coverage.
 *
 * @param {string} code
 * @param {string} filename  used by oxc to pick the dialect (.ts/.tsx/.js…)
 * @param {(message: string) => void} [onError]
 * @returns {object|null}
 */
function parse(code, filename, onError) {
  const attempts = [filename];
  // Babel/SWC projects commonly keep JSX in `.js` files. oxc deliberately
  // infers the grammar from the filename, so retrying with a virtual `.jsx`
  // suffix recovers those files without renaming or executing repository code.
  if (/\.js$/i.test(filename)) attempts.push(filename.replace(/\.js$/i, ".jsx"));

  let firstFailure = null;
  for (const attempt of attempts) {
    try {
      const result = oxc.parseSync(attempt, code);
      if (result && Array.isArray(result.errors) && result.errors.length > 0) {
        const first = result.errors[0];
        const extra = result.errors.length > 1 ? ` (+${result.errors.length - 1} more)` : "";
        firstFailure ||= `${first.message || "parse error"}${extra}`;
        continue;
      }
      const program = result && result.program;
      if (program && Array.isArray(program.body)) {
        Object.defineProperty(program, "__comments", {
          value: Array.isArray(result.comments) ? result.comments : [],
        });
        return program;
      }
      firstFailure ||= "parser returned no usable program";
    } catch (err) {
      firstFailure ||= err && err.message ? err.message : String(err);
    }
  }
  onError?.(firstFailure || "parser returned no usable program");
  return null;
}

/** Depth-first pre-order visit of every ESTree node, in document order. */
function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) walk(item, visit);
    } else if (child && typeof child.type === "string") {
      walk(child, visit);
    }
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

/**
 * Extract a static string from a literal, template, `+` concatenation, or —
 * when a `consts` map (name -> resolved string) is given — an identifier bound
 * to a same-file string const, including inside template expressions.
 */
function staticString(node, consts) {
  const n = unwrap(node);
  if (!n) return null;
  if (n.type === "Literal" && typeof n.value === "string") return n.value;
  if (n.type === "TemplateLiteral") {
    const parts = n.expressions.map((e) => staticString(e, consts));
    if (parts.some((p) => p === null)) return null;
    let text = "";
    n.quasis.forEach((q, i) => {
      text += q.value.cooked + (parts[i] ?? "");
    });
    return text;
  }
  if (n.type === "BinaryExpression" && n.operator === "+") {
    const left = staticString(n.left, consts);
    const right = staticString(n.right, consts);
    return left !== null && right !== null ? left + right : null;
  }
  if (n.type === "Identifier" && consts && consts.has(n.name)) return consts.get(n.name);
  return null;
}

/** Best-effort one-line source snippet for a node, for the audit trail. */
function snippet(code, node, max = 80) {
  const text = code.slice(node.start, node.end).replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/** Function-ish names referenced inside call arguments (`asyncHandler(requireAuth)`). */
function collectInnerNames(args, acc) {
  for (const arg of args) {
    const n = unwrap(arg);
    if (!n) continue;
    if (n.type === "Identifier") acc.push(n.name);
    else if (n.type === "MemberExpression") {
      const name = calleeName(n);
      if (name) acc.push(name);
    } else if (n.type === "CallExpression") {
      const name = calleeName(n.callee);
      if (name) acc.push(name);
      collectInnerNames(n.arguments, acc);
    } else if (n.type === "ArrayExpression") {
      collectInnerNames(n.elements.filter(Boolean), acc);
    }
  }
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
    const desc = descriptor({
      name: name || "<anonymous>",
      kind: "call",
      raw: snippet(code, node),
    });
    // A wrapper call (`asyncHandler(requireAuth)`) hides its payload behind the
    // wrapper's name; keep the inner names so the allowlist can still match.
    const inner = [];
    collectInnerNames(node.arguments, inner);
    if (inner.length > 0) desc.inner = inner;
    return desc;
  }
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
    return descriptor({ name: "<anonymous>", kind: "anonymous", raw: "<inline fn>" });
  }
  return descriptor({ name: "<anonymous>", kind: "unknown", raw: snippet(code, node) });
}

module.exports = {
  parse,
  walk,
  unwrap,
  calleeName,
  staticString,
  snippet,
  middlewareFromArg,
  HTTP_METHODS,
};
