"use strict";

const fs = require("node:fs");
const path = require("node:path");

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".cjs", ".mjs"];
const TYPESCRIPT_SOURCE_FOR_OUTPUT = Object.freeze({
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
});

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
function loadTsconfig(rootDir, stopDir) {
  let dir = path.resolve(rootDir);
  const stop = stopDir && path.resolve(stopDir);
  for (let i = 0; i < 12; i++) {
    const file = path.join(dir, "tsconfig.json");
    if (fs.existsSync(file)) {
      const parsed = tolerantJsonParse(fs.readFileSync(file, "utf8"));
      const opts = (parsed && parsed.compilerOptions) || {};
      if (opts.baseUrl || opts.paths) {
        return { baseUrl: path.resolve(dir, opts.baseUrl || "."), paths: opts.paths || {} };
      }
    }
    if (stop && dir === stop) break;
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
function loadImports(rootDir, stopDir) {
  let dir = path.resolve(rootDir);
  const stop = stopDir && path.resolve(stopDir);
  for (let i = 0; i < 12; i++) {
    const file = path.join(dir, "package.json");
    if (fs.existsSync(file)) {
      const parsed = tolerantJsonParse(fs.readFileSync(file, "utf8"));
      const imports = parsed && parsed.imports;
      return imports && typeof imports === "object" ? { dir, imports } : null;
    }
    if (stop && dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function firstExistingFile(base) {
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  // TypeScript's NodeNext/Node16 modes require emitted extensions in source
  // imports (`./app.js`) even when the checked-in file is `app.ts`. Mirror that
  // resolution before trying extension-appending fallbacks such as `.js.ts`.
  const parsed = path.parse(base);
  for (const ext of TYPESCRIPT_SOURCE_FOR_OUTPUT[parsed.ext.toLowerCase()] || []) {
    const source = path.join(parsed.dir, parsed.name + ext);
    if (fs.existsSync(source) && fs.statSync(source).isFile()) return source;
  }
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

function packageSpecifier(source) {
  const parts = source.split("/");
  const packageName = source.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (!packageName || (source.startsWith("@") && parts.length < 2)) return null;
  return {
    packageName,
    subpath: parts.slice(source.startsWith("@") ? 2 : 1).join("/"),
  };
}

function packageExportTargets(manifest, subpath) {
  const exports = manifest.exports;
  if (!exports) return [];
  if (typeof exports === "string" || Array.isArray(exports)) {
    return subpath ? [] : importTargetStrings(exports, []);
  }
  if (typeof exports !== "object") return [];
  const key = subpath ? `./${subpath}` : ".";
  if (Object.hasOwn(exports, key)) return importTargetStrings(exports[key], []);
  for (const [pattern, target] of Object.entries(exports)) {
    if (!pattern.startsWith("./") || !pattern.includes("*")) continue;
    const [prefix, suffix] = pattern.split("*");
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    const matched = key.slice(prefix.length, key.length - suffix.length);
    return importTargetStrings(target, []).map((value) => value.replaceAll("*", matched));
  }
  // An object without subpath keys is a root conditional export.
  return !subpath && !Object.keys(exports).some((item) => item.startsWith("."))
    ? importTargetStrings(exports, [])
    : [];
}

function sourceTreeCandidate(packageDir, target) {
  const normalized = target.replace(/^\.\//, "");
  const parts = normalized.split("/");
  if (!["dist", "build", "lib", "out"].includes(parts[0])) return null;
  parts[0] = "src";
  return path.resolve(packageDir, ...parts);
}

function localPackageCandidates(source, packages) {
  const specifier = packageSpecifier(source);
  const item = specifier && packages.get(specifier.packageName);
  if (!item) return [];
  const candidates = [];
  const add = (candidate) => {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };
  if (specifier.subpath) {
    add(path.resolve(item.dir, specifier.subpath));
    add(path.resolve(item.dir, "src", specifier.subpath));
  } else {
    add(item.manifest.source && path.resolve(item.dir, item.manifest.source));
    add(path.resolve(item.dir, "src", "index"));
    add(item.manifest.main && path.resolve(item.dir, item.manifest.main));
    add(item.manifest.module && path.resolve(item.dir, item.manifest.module));
  }
  for (const target of packageExportTargets(item.manifest, specifier.subpath)) {
    const candidate = path.resolve(item.dir, target);
    add(candidate);
    add(sourceTreeCandidate(item.dir, target));
  }
  return candidates;
}

/** Index package names only from package roots that own analyzed source files. */
function collectLocalPackages(root, sourceFiles) {
  const packages = new Map();
  const inspected = new Set();
  for (const sourceFile of sourceFiles) {
    let dir = path.dirname(sourceFile);
    while (withinRoot(root, dir)) {
      if (!inspected.has(dir)) {
        inspected.add(dir);
        const manifestFile = path.join(dir, "package.json");
        if (fs.existsSync(manifestFile)) {
          const manifest = tolerantJsonParse(fs.readFileSync(manifestFile, "utf8"));
          if (typeof manifest?.name === "string") {
            const existing = packages.get(manifest.name);
            packages.set(
              manifest.name,
              existing && existing.dir !== dir ? null : { dir, manifest },
            );
          }
        }
      }
      if (dir === root) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return packages;
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
function createResolver(tsconfig, pkgImports, localPackages = new Map()) {
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
    if (tsconfig) {
      for (const candidate of aliasCandidates(source, tsconfig)) {
        const hit = firstExistingFile(candidate);
        if (hit) return hit;
      }
      const baseUrlHit = firstExistingFile(path.resolve(tsconfig.baseUrl, source));
      if (baseUrlHit) return baseUrlHit;
    }
    for (const candidate of localPackageCandidates(source, localPackages)) {
      const hit = firstExistingFile(candidate);
      if (hit) return hit;
    }
    return null;
  };
}

function withinRoot(root, file) {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== "..");
}

/**
 * Resolve each importing file against its own nearest tsconfig and package
 * `imports` scope. A repository-wide resolver incorrectly applies the root
 * package's aliases to every workspace in a monorepo. Resolved files are kept
 * inside the requested scan root so aliases cannot silently pull unrelated
 * source from a parent checkout into an offline/remote inventory.
 */
function createScopedResolver(rootDir, sourceFiles = []) {
  const root = path.resolve(rootDir);
  const localPackages = collectLocalPackages(root, sourceFiles);
  const cache = new Map();
  return (fromFile, source) => {
    const dir = path.dirname(fromFile);
    let resolve = cache.get(dir);
    if (!resolve) {
      resolve = createResolver(loadTsconfig(dir, root), loadImports(dir, root), localPackages);
      cache.set(dir, resolve);
    }
    const hit = resolve(fromFile, source);
    return hit && withinRoot(root, hit) ? hit : null;
  };
}

/**
 * Read `{ name, version }` from the nearest package.json (walking up from
 * `rootDir`), for the OpenAPI `info` block. Returns null if none is found.
 */
function loadPackageInfo(rootDir) {
  let dir = rootDir;
  for (let i = 0; i < 12; i++) {
    const file = path.join(dir, "package.json");
    if (fs.existsSync(file)) {
      const parsed = tolerantJsonParse(fs.readFileSync(file, "utf8"));
      if (!parsed) return null;
      const info = {};
      if (typeof parsed.name === "string") info.name = parsed.name;
      if (typeof parsed.version === "string") info.version = parsed.version;
      return info.name || info.version ? info : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

module.exports = {
  loadTsconfig,
  loadImports,
  loadPackageInfo,
  createResolver,
  createScopedResolver,
  EXTENSIONS,
};
