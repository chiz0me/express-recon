"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".cjs", ".mjs"];
const TYPESCRIPT_SOURCE_FOR_OUTPUT = Object.freeze({
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
});

/** Strip JSONC comments without treating comment markers inside strings as syntax. */
function stripJsonComments(text) {
  let output = "";
  let string = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += character;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index++;
      } else if (character === "\n") {
        output += character;
      }
      continue;
    }
    if (string) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') string = false;
      continue;
    }
    if (character === '"') {
      string = true;
      output += character;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      index++;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      index++;
    } else {
      output += character;
    }
  }
  return output;
}

function stripTrailingCommas(text) {
  let output = "";
  let string = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (string) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') string = false;
      continue;
    }
    if (character === '"') {
      string = true;
      output += character;
      continue;
    }
    if (character === ",") {
      let cursor = index + 1;
      while (/\s/.test(text[cursor] || "")) cursor++;
      if (text[cursor] === "}" || text[cursor] === "]") continue;
    }
    output += character;
  }
  return output;
}

/** Parse ordinary JSON plus the comments and trailing commas allowed by JSONC. */
function tolerantJsonParse(text) {
  try {
    return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
  } catch {
    return null;
  }
}

function configCandidate(fromFile, reference, stopDir, observe = () => {}) {
  if (typeof reference !== "string" || !reference) return null;
  const directory = path.dirname(fromFile);
  const candidates = [];
  if (reference.startsWith(".") || path.isAbsolute(reference)) {
    const base = path.resolve(directory, reference);
    candidates.push(base, `${base}.json`, path.join(base, "tsconfig.json"));
  } else {
    let current = directory;
    for (let hops = 0; hops < 12; hops++) {
      const base = path.join(current, "node_modules", reference);
      candidates.push(base, `${base}.json`, path.join(base, "tsconfig.json"));
      if (current === stopDir) break;
      const parent = path.dirname(current);
      if (parent === current || !withinRoot(stopDir, parent)) break;
      current = parent;
    }
  }
  return (
    candidates.find((candidate) => {
      try {
        if (!withinRoot(stopDir, candidate)) return false;
        observe(candidate);
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    }) || null
  );
}

function loadTsconfigFile(file, stopDir, stack, depth, trace, observe) {
  if (depth >= 12) {
    trace.push({ file, outcome: "limited", reason: "tsconfig-extends-depth" });
    return null;
  }
  let canonical;
  try {
    observe(file);
    fs.statSync(file);
    canonical = path.resolve(file);
  } catch {
    trace.push({ file, outcome: "unresolved", reason: "tsconfig-not-readable" });
    return null;
  }
  if (stack.has(canonical)) {
    trace.push({ file: canonical, outcome: "cycle", reason: "tsconfig-extends-cycle" });
    return null;
  }
  const parsed = tolerantJsonParse(fs.readFileSync(canonical, "utf8"));
  if (!parsed || typeof parsed !== "object") {
    trace.push({ file: canonical, outcome: "invalid", reason: "invalid-jsonc" });
    return null;
  }
  const nextStack = new Set(stack).add(canonical);
  const references = Array.isArray(parsed.extends)
    ? parsed.extends
    : parsed.extends
      ? [parsed.extends]
      : [];
  let inherited = null;
  for (const reference of references) {
    const target = configCandidate(canonical, reference, stopDir, observe);
    if (!target) {
      trace.push({
        file: canonical,
        reference,
        outcome: "unresolved",
        reason: "tsconfig-extends-unresolved",
      });
      continue;
    }
    const loaded = loadTsconfigFile(target, stopDir, nextStack, depth + 1, trace, observe);
    if (loaded) inherited = loaded;
  }
  const options = parsed.compilerOptions || {};
  const configDir = path.dirname(canonical);
  const baseUrl = Object.hasOwn(options, "baseUrl")
    ? path.resolve(configDir, options.baseUrl || ".")
    : inherited?.baseUrl || configDir;
  const ownPaths = options.paths && typeof options.paths === "object" ? options.paths : null;
  const paths = ownPaths
    ? Object.fromEntries(
        Object.entries(ownPaths).map(([pattern, targets]) => [
          pattern,
          (Array.isArray(targets) ? targets : []).map((target) => path.resolve(baseUrl, target)),
        ]),
      )
    : inherited?.paths || {};
  trace.push({ file: canonical, outcome: "loaded" });
  return { baseUrl, paths, pathsAbsolute: true };
}

/**
 * Load tsconfig path-alias config by walking up from `rootDir`. Returns the
 * resolved `baseUrl` directory and `paths` map, or null if none is found.
 */
function loadTsconfig(rootDir, stopDir, observe = () => {}) {
  let dir = path.resolve(rootDir);
  const stop = path.resolve(stopDir || rootDir);
  for (let i = 0; i < 12; i++) {
    const file = path.join(dir, "tsconfig.json");
    observe(file);
    if (fs.existsSync(file)) {
      const trace = [];
      const loaded = loadTsconfigFile(file, stop, new Set(), 0, trace, observe);
      if (loaded) return { ...loaded, trace };
    }
    if (dir === stop) break;
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
function loadImports(rootDir, stopDir, observe = () => {}) {
  let dir = path.resolve(rootDir);
  const stop = stopDir && path.resolve(stopDir);
  for (let i = 0; i < 12; i++) {
    const file = path.join(dir, "package.json");
    observe(file);
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

function conditionalTargets(target, importKind) {
  if (target === null) return { matched: true, blocked: true, targets: [] };
  if (typeof target === "string") return { matched: true, blocked: false, targets: [target] };
  if (Array.isArray(target)) {
    const targets = [];
    let matched = false;
    for (const candidate of target) {
      const selected = conditionalTargets(candidate, importKind);
      matched ||= selected.matched;
      targets.push(...selected.targets);
    }
    return { matched, blocked: matched && targets.length === 0, targets };
  }
  if (!target || typeof target !== "object") {
    return { matched: false, blocked: false, targets: [] };
  }
  const active = new Set(["node", importKind === "require" ? "require" : "import", "default"]);
  for (const [condition, candidate] of Object.entries(target)) {
    if (!active.has(condition)) continue;
    const selected = conditionalTargets(candidate, importKind);
    // Node continues to the next active condition when a nested conditional
    // object contains no matching branch. A selected null/blocked target is a
    // real match and must still stop resolution.
    if (selected.matched) return selected;
  }
  return { matched: false, blocked: false, targets: [] };
}

function packageExportTargets(manifest, subpath, importKind) {
  const exports = manifest.exports;
  if (exports === undefined) return { matched: false, blocked: false, targets: [] };
  if (typeof exports === "string" || Array.isArray(exports)) {
    return subpath
      ? { matched: false, blocked: false, targets: [] }
      : conditionalTargets(exports, importKind);
  }
  if (!exports || typeof exports !== "object") {
    return { matched: true, blocked: true, targets: [] };
  }
  const key = subpath ? `./${subpath}` : ".";
  if (Object.hasOwn(exports, key)) return conditionalTargets(exports[key], importKind);
  const patterns = [];
  for (const [pattern, target] of Object.entries(exports)) {
    if (!pattern.startsWith("./") || !pattern.includes("*")) continue;
    const star = pattern.indexOf("*");
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    patterns.push({ pattern, target, prefix, suffix });
  }
  patterns.sort(
    (left, right) =>
      right.prefix.length - left.prefix.length ||
      right.suffix.length - left.suffix.length ||
      left.pattern.localeCompare(right.pattern),
  );
  if (patterns.length) {
    const { target, prefix, suffix } = patterns[0];
    const wildcard = key.slice(prefix.length, key.length - suffix.length);
    const selected = conditionalTargets(target, importKind);
    return {
      ...selected,
      targets: selected.targets.map((value) => value.replaceAll("*", wildcard)),
    };
  }
  // An object without subpath keys is a root conditional export.
  return !subpath && !Object.keys(exports).some((item) => item.startsWith("."))
    ? conditionalTargets(exports, importKind)
    : { matched: false, blocked: false, targets: [] };
}

function sourceTreeCandidate(packageDir, target) {
  const normalized = target.replace(/^\.\//, "");
  const parts = normalized.split("/");
  if (!["dist", "build", "lib", "out"].includes(parts[0])) return null;
  parts[0] = "src";
  return path.resolve(packageDir, ...parts);
}

function localPackageCandidates(source, packages, importKind) {
  const specifier = packageSpecifier(source);
  const item = specifier && packages.get(specifier.packageName);
  if (!item) return [];
  const candidates = [];
  const add = (candidate, strategy, heuristic = false) => {
    if (candidate && !candidates.some((item) => item.candidate === candidate)) {
      candidates.push({ candidate, strategy, heuristic });
    }
  };
  if (item.manifest.exports !== undefined) {
    const selected = packageExportTargets(item.manifest, specifier.subpath, importKind);
    for (const target of selected.targets) {
      if (!target.startsWith("./")) continue;
      const candidate = path.resolve(item.dir, target);
      add(sourceTreeCandidate(item.dir, target), "workspace-source-tree", true);
      add(candidate, "workspace-exports");
    }
    return candidates;
  }
  if (specifier.subpath) {
    add(path.resolve(item.dir, specifier.subpath), "workspace-subpath");
    add(path.resolve(item.dir, "src", specifier.subpath), "workspace-source-tree", true);
  } else {
    add(item.manifest.source && path.resolve(item.dir, item.manifest.source), "workspace-source");
    if (importKind === "import")
      add(item.manifest.module && path.resolve(item.dir, item.manifest.module), "workspace-module");
    add(item.manifest.main && path.resolve(item.dir, item.manifest.main), "workspace-main");
    add(path.resolve(item.dir, "src", "index"), "workspace-source-tree", true);
  }
  return candidates;
}

/** Index package names only from package roots that own analyzed source files. */
function collectLocalPackages(root, sourceFiles, observe = () => {}) {
  const packages = new Map();
  const inspected = new Set();
  for (const sourceFile of sourceFiles) {
    let dir = path.dirname(sourceFile);
    while (withinRoot(root, dir)) {
      if (!inspected.has(dir)) {
        inspected.add(dir);
        const manifestFile = path.join(dir, "package.json");
        observe(manifestFile);
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
          out.push(
            tsconfig.pathsAbsolute
              ? t.replace(/\*$/, "") + rest
              : path.resolve(tsconfig.baseUrl, t.replace(/\*$/, "") + rest),
          );
      }
    } else if (source === pattern) {
      for (const t of targets)
        out.push(tsconfig.pathsAbsolute ? t : path.resolve(tsconfig.baseUrl, t));
    }
  }
  return out;
}

/** Expand a `#alias` specifier through the package.json `imports` patterns. */
function importCandidates(source, pkgImports, importKind) {
  let match = null;
  if (Object.hasOwn(pkgImports.imports, source)) {
    match = { pattern: source, target: pkgImports.imports[source], wildcard: "" };
  } else {
    const matches = [];
    for (const [pattern, target] of Object.entries(pkgImports.imports)) {
      if (!pattern.includes("*")) continue;
      const star = pattern.indexOf("*");
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (!source.startsWith(prefix) || !source.endsWith(suffix)) continue;
      matches.push({
        pattern,
        target,
        prefix,
        suffix,
        wildcard: source.slice(prefix.length, source.length - suffix.length),
      });
    }
    matches.sort(
      (left, right) =>
        right.prefix.length - left.prefix.length ||
        right.suffix.length - left.suffix.length ||
        left.pattern.localeCompare(right.pattern),
    );
    match = matches[0] || null;
  }
  if (!match) return [];
  const selected = conditionalTargets(match.target, importKind);
  return selected.targets
    .filter((target) => target.startsWith("./"))
    .map((target) => path.resolve(pkgImports.dir, target.replaceAll("*", match.wildcard)));
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
  const explain = (fromFile, source, importKind = "import") => {
    if (source.startsWith(".")) {
      const file = firstExistingFile(path.resolve(path.dirname(fromFile), source));
      return {
        file,
        strategy: "relative",
        heuristic: false,
        reason: file ? null : "relative-target-not-found",
      };
    }
    // `#alias` is exclusively a package-imports specifier (Node spec): resolve
    // only through the imports map, never tsconfig or node_modules.
    if (source.startsWith("#")) {
      if (!pkgImports) {
        return {
          file: null,
          strategy: "package-imports",
          heuristic: false,
          reason: "package-imports-map-not-found",
        };
      }
      for (const candidate of importCandidates(source, pkgImports, importKind)) {
        const hit = firstExistingFile(candidate);
        if (hit) return { file: hit, strategy: "package-imports", heuristic: false, reason: null };
      }
      return {
        file: null,
        strategy: "package-imports",
        heuristic: false,
        reason: "package-imports-target-not-found-or-blocked",
      };
    }
    if (tsconfig) {
      for (const candidate of aliasCandidates(source, tsconfig)) {
        const hit = firstExistingFile(candidate);
        if (hit) return { file: hit, strategy: "tsconfig-paths", heuristic: false, reason: null };
      }
      const baseUrlHit = firstExistingFile(path.resolve(tsconfig.baseUrl, source));
      if (baseUrlHit)
        return { file: baseUrlHit, strategy: "tsconfig-base-url", heuristic: true, reason: null };
    }
    for (const candidate of localPackageCandidates(source, localPackages, importKind)) {
      const hit = firstExistingFile(candidate.candidate);
      if (hit) {
        return {
          file: hit,
          strategy: candidate.strategy,
          heuristic: candidate.heuristic,
          reason: null,
        };
      }
    }
    return {
      file: null,
      strategy: "external-or-unresolved",
      heuristic: false,
      reason: "no-first-party-target",
    };
  };
  const resolve = (fromFile, source, importKind = "import") =>
    explain(fromFile, source, importKind).file;
  resolve.explain = explain;
  return resolve;
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
  const dependencies = new Map();
  const observe = (file) => {
    const resolved = path.resolve(file);
    if (dependencies.has(resolved)) return;
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        dependencies.set(resolved, Object.freeze({ file: resolved, exists: true, isFile: false }));
        return;
      }
      const contents = fs.readFileSync(resolved);
      dependencies.set(
        resolved,
        Object.freeze({
          file: resolved,
          exists: true,
          isFile: true,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          ino: stat.ino,
          sha256: crypto.createHash("sha256").update(contents).digest("hex"),
        }),
      );
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      dependencies.set(resolved, Object.freeze({ file: resolved, exists: false }));
    }
  };
  const localPackages = collectLocalPackages(root, sourceFiles, observe);
  const cache = new Map();
  const traces = [];
  const traceKeys = new Set();
  const resolverFor = (fromFile) => {
    const dir = path.dirname(fromFile);
    let resolve = cache.get(dir);
    if (!resolve) {
      resolve = createResolver(
        loadTsconfig(dir, root, observe),
        loadImports(dir, root, observe),
        localPackages,
      );
      cache.set(dir, resolve);
    }
    return resolve;
  };
  const explain = (fromFile, source, importKind = "import") => {
    const detail = resolverFor(fromFile).explain(fromFile, source, importKind);
    if (detail.file && !withinRoot(root, detail.file)) {
      return { ...detail, file: null, reason: "target-outside-scan-root" };
    }
    return detail;
  };
  const scoped = (fromFile, source, importKind = "import") => {
    const detail = explain(fromFile, source, importKind);
    if (
      (detail.heuristic || (!detail.file && (source.startsWith(".") || source.startsWith("#")))) &&
      traces.length < 128
    ) {
      const trace = {
        from: path.relative(root, fromFile).split(path.sep).join("/"),
        specifier: source,
        importKind,
        outcome: detail.file ? "resolved" : "unresolved",
        strategy: detail.strategy,
        heuristic: detail.heuristic,
        target: detail.file ? path.relative(root, detail.file).split(path.sep).join("/") : null,
        reason: detail.reason,
      };
      const key = JSON.stringify(trace);
      if (!traceKeys.has(key)) {
        traceKeys.add(key);
        traces.push(trace);
      }
    }
    return detail.file;
  };
  scoped.explain = explain;
  scoped.traces = traces;
  scoped.dependencyManifest = () =>
    Object.freeze(
      [...dependencies.values()].sort((left, right) => left.file.localeCompare(right.file)),
    );
  return scoped;
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
