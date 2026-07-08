"use strict";

const fs = require("node:fs");
const path = require("node:path");

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".cjs", ".mjs"];

/** Strip // and /* *​/ comments and trailing commas so tsconfig.json parses. */
function tolerantJsonParse(text) {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const noLine = noBlock.replace(/(^|[^:])\/\/.*$/gm, "$1");
  const noTrailingComma = noLine.replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(noTrailingComma);
  } catch {
    return null;
  }
}

/**
 * Load tsconfig path-alias config by walking up from `rootDir`. Returns the
 * resolved `baseUrl` directory and `paths` map, or null if none is found.
 */
function loadTsconfig(rootDir) {
  let dir = rootDir;
  for (let i = 0; i < 12; i++) {
    const file = path.join(dir, "tsconfig.json");
    if (fs.existsSync(file)) {
      const parsed = tolerantJsonParse(fs.readFileSync(file, "utf8"));
      const opts = (parsed && parsed.compilerOptions) || {};
      if (opts.baseUrl || opts.paths) {
        return { baseUrl: path.resolve(dir, opts.baseUrl || "."), paths: opts.paths || {} };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Load the nearest package.json `imports` map (subpath imports, `#alias`) by
 * walking up from `rootDir`. Stops at the first package.json — that is the
 * package scope whose imports apply. Returns `{ dir, imports }` where paths are
 * relative to `dir`, or null if none is found or it has no `imports`.
 */
function loadImports(rootDir) {
  let dir = rootDir;
  for (let i = 0; i < 12; i++) {
    const file = path.join(dir, "package.json");
    if (fs.existsSync(file)) {
      const parsed = tolerantJsonParse(fs.readFileSync(file, "utf8"));
      const imports = parsed && parsed.imports;
      return imports && typeof imports === "object" ? { dir, imports } : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function firstExistingFile(base) {
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  for (const ext of EXTENSIONS) {
    const withExt = base + ext;
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) return withExt;
  }
  for (const ext of EXTENSIONS) {
    const index = path.join(base, "index" + ext);
    if (fs.existsSync(index)) return index;
  }
  return null;
}

/** Expand a non-relative specifier through tsconfig `paths` patterns. */
function aliasCandidates(source, tsconfig) {
  const out = [];
  for (const [pattern, targets] of Object.entries(tsconfig.paths)) {
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1);
      if (source.startsWith(prefix)) {
        const rest = source.slice(prefix.length);
        for (const t of targets)
          out.push(path.resolve(tsconfig.baseUrl, t.replace(/\*$/, "") + rest));
      }
    } else if (source === pattern) {
      for (const t of targets) out.push(path.resolve(tsconfig.baseUrl, t));
    }
  }
  return out;
}

/** Collect every string leaf of an `imports` target (a string, or a conditions object). */
function importTargetStrings(target, acc) {
  if (typeof target === "string") acc.push(target);
  else if (target && typeof target === "object")
    for (const v of Object.values(target)) importTargetStrings(v, acc);
  return acc;
}

/** Expand a `#alias` specifier through the package.json `imports` patterns. */
function importCandidates(source, pkgImports) {
  const out = [];
  for (const [pattern, target] of Object.entries(pkgImports.imports)) {
    const targets = importTargetStrings(target, []);
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1);
      if (source.startsWith(prefix)) {
        const rest = source.slice(prefix.length);
        for (const t of targets)
          out.push(path.resolve(pkgImports.dir, t.replace(/\*$/, "") + rest));
      }
    } else if (source === pattern) {
      for (const t of targets) out.push(path.resolve(pkgImports.dir, t));
    }
  }
  return out;
}

/**
 * Build a module resolver for one scan. Resolves relative specifiers,
 * package.json `#imports` subpath aliases, tsconfig `paths` aliases, and
 * `baseUrl`-relative imports to an on-disk source file. Returns null for
 * bare/node_modules specifiers (treated as external).
 *
 * @param {object|null} tsconfig  from `loadTsconfig`
 * @param {object|null} pkgImports  from `loadImports`
 * @returns {(fromFile: string, source: string) => string|null}
 */
function createResolver(tsconfig, pkgImports) {
  return (fromFile, source) => {
    if (source.startsWith(".")) {
      return firstExistingFile(path.resolve(path.dirname(fromFile), source));
    }
    // `#alias` is exclusively a package-imports specifier (Node spec): resolve
    // only through the imports map, never tsconfig or node_modules.
    if (source.startsWith("#")) {
      if (!pkgImports) return null;
      for (const candidate of importCandidates(source, pkgImports)) {
        const hit = firstExistingFile(candidate);
        if (hit) return hit;
      }
      return null;
    }
    if (!tsconfig) return null;
    for (const candidate of aliasCandidates(source, tsconfig)) {
      const hit = firstExistingFile(candidate);
      if (hit) return hit;
    }
    return firstExistingFile(path.resolve(tsconfig.baseUrl, source));
  };
}

module.exports = { loadTsconfig, loadImports, createResolver, EXTENSIONS };
