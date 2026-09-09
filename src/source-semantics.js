"use strict";

const path = require("node:path");
const crypto = require("node:crypto");
const { parse } = require("./static/ast");
const cache = new Map();

function stableAst(value, syntax = true) {
  if (typeof value === "bigint") return { bigint: value.toString() };
  if (Array.isArray(value)) return value.map((item) => stableAst(item, syntax));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => !syntax || !["start", "end", "loc", "range", "raw"].includes(key))
      .map((key) => [key, stableAst(value[key], syntax)]),
  );
}

function semanticSourceHash(file, bytes) {
  const raw = crypto.createHash("sha256").update(bytes).digest("hex");
  const key = `${path.extname(file)}:${raw}`;
  if (cache.has(key)) return cache.get(key);
  let evidence = bytes;
  const text = bytes.toString("utf8");
  if (/\.[cm]?[jt]sx?$/.test(file)) {
    const ast = parse(text, file);
    if (ast) {
      // Documentation comments can affect generated contracts. Ordinary comments,
      // source coordinates, whitespace, and quote style do not change semantics.
      evidence = JSON.stringify({
        version: 2,
        ast: stableAst(ast),
        documentation: (ast.__comments || [])
          .filter((comment) => text.slice(comment.start, comment.start + 3) === "/**")
          .map((comment) => text.slice(comment.start, comment.end)),
      });
    }
  } else if (path.extname(file) === ".json") {
    try {
      evidence = JSON.stringify(stableAst(JSON.parse(text), false));
    } catch {
      /* Keep raw evidence for invalid/unknown dependencies. */
    }
  }
  const result = `sha256:${crypto.createHash("sha256").update(evidence).digest("hex")}`;
  if (cache.size >= 1000) cache.clear();
  cache.set(key, result);
  return result;
}

function stableSourceLocations(value) {
  if (Array.isArray(value)) return value.map(stableSourceLocations);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !(typeof value.file === "string" && ["line", "column", "start", "end"].includes(key)),
      )
      .map(([key, child]) => [key, stableSourceLocations(child)]),
  );
}

module.exports = { semanticSourceHash, stableSourceLocations };
