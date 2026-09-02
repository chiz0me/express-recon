"use strict";

const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { scan, scanLimits, createScanScope, listSourceFiles } = require("./static/scan");
const { MODULE_EXTENSIONS, loadStaticDocumentModule } = require("./static/document-module");
const pkg = require("../package.json");

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".express-recon",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
]);
const TEST_DIRS = new Set([
  "test",
  "tests",
  "testcases",
  "spec",
  "specs",
  "__tests__",
  "__mocks__",
]);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const DOC_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".cjs", ".mjs", ".ts", ".tsx", ".cts", ".mts"]);
// Swagger UI's browser distributions contain OpenAPI-shaped strings and export
// wrappers, but they are render-time code rather than authored API contracts.
const SWAGGER_UI_RUNTIME_ASSET =
  /^swagger-ui(?:-es-bundle(?:-core)?|-bundle|-standalone-preset)?(?:\.min)?\.[cm]?js$/i;

function relevantRepositoryFile(name) {
  const extension = path.extname(name).toLowerCase();
  return (
    name === "package.json" || DOC_EXTENSIONS.has(extension) || SOURCE_EXTENSIONS.has(extension)
  );
}

function posixRelative(root, file) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  return relative || ".";
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep));
}

function collectRepositoryFiles(root, limits, diagnostics, opts = {}) {
  const files = [];
  const scope = createScanScope(root, opts);
  const result = (complete) => ({ files: files.sort(), complete, scope: scope.evidence });
  const stack = [root];
  const started = Date.now();
  let complete = true;
  while (stack.length) {
    if (Date.now() - started > limits.timeoutMs) {
      diagnostics.push(
        `discover: stopped repository discovery at scan.timeoutMs (${limits.timeoutMs}ms)`,
      );
      return result(false);
    }
    const dir = stack.pop();
    let entries;
    try {
      entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch (err) {
      diagnostics.push(
        `discover: could not read directory ${posixRelative(root, dir)}: ${err.message}`,
      );
      complete = false;
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          SKIP_DIRS.has(entry.name) ||
          (!opts.includeHidden && entry.name.startsWith(".")) ||
          (!opts.includeTests && TEST_DIRS.has(entry.name))
        ) {
          continue;
        }
        stack.push(full);
      } else if (
        entry.isFile() &&
        relevantRepositoryFile(entry.name) &&
        (opts.includeTests || !TEST_FILE.test(entry.name))
      ) {
        if (!scope.matches(full)) continue;
        if (files.length >= limits.maxFiles) {
          diagnostics.push(
            `discover: stopped repository discovery at scan.maxFiles (${limits.maxFiles})`,
          );
          return result(false);
        }
        files.push(full);
      }
    }
  }
  return result(complete);
}

function readJson(file, limits, diagnostics) {
  try {
    const size = fs.statSync(file).size;
    if (size > limits.maxFileBytes) {
      diagnostics.push(
        `discover: skipped ${file}: ${size} bytes exceeds scan.maxFileBytes (${limits.maxFileBytes})`,
      );
      return null;
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    diagnostics.push(`discover: could not parse ${file}: ${err.message}`);
    return null;
  }
}

const DEPENDENCY_FIELDS = Object.freeze([
  ["dependencies", "runtime", "strong"],
  ["optionalDependencies", "optional", "strong"],
  ["peerDependencies", "peer", "supporting"],
  ["devDependencies", "development", "weak"],
]);

function packageDependency(manifest, packageName) {
  for (const [field, scope, strength] of DEPENDENCY_FIELDS) {
    if (manifest[field] && typeof manifest[field][packageName] === "string") {
      return {
        package: packageName,
        field,
        range: manifest[field][packageName],
        direct: true,
        scope,
        strength,
      };
    }
  }
  return null;
}

function expressDependency(manifest) {
  const dependency = packageDependency(manifest, "express");
  if (!dependency) return null;
  const { package: _package, ...evidence } = dependency;
  return evidence;
}

function dependencyClassification(packages) {
  const rank = { weak: 1, supporting: 2, strong: 3 };
  const strength = packages.reduce(
    (selected, dependency) =>
      rank[dependency.strength] > rank[selected] ? dependency.strength : selected,
    "weak",
  );
  return {
    signal: "package-json-direct-dependency",
    direct: true,
    strength,
    scopes: [...new Set(packages.map((dependency) => dependency.scope))].sort(),
  };
}

function frameworkDependencies(manifest) {
  const definitions = [
    ["express", ["express"]],
    ["fastify", ["fastify"]],
    [
      "nestjs",
      ["@nestjs/core", "@nestjs/common", "@nestjs/platform-express", "@nestjs/platform-fastify"],
    ],
  ];
  return definitions
    .map(([name, packageNames]) => {
      const packages = packageNames
        .map((packageName) => packageDependency(manifest, packageName))
        .filter(Boolean);
      return {
        name,
        packages,
        classification: packages.length ? dependencyClassification(packages) : null,
      };
    })
    .filter((framework) => framework.packages.length > 0);
}

function discoverPackages(root, files, limits, diagnostics) {
  let totalBytes = 0;
  let complete = true;
  const packages = files
    .filter((file) => path.basename(file) === "package.json")
    .map((file) => {
      let size;
      try {
        size = fs.statSync(file).size;
      } catch (err) {
        diagnostics.push(`discover: could not stat ${file}: ${err.message}`);
        complete = false;
        return null;
      }
      if (totalBytes + size > limits.maxTotalBytes) {
        if (complete) {
          diagnostics.push(
            `discover: stopped package discovery at scan.maxTotalBytes (${limits.maxTotalBytes})`,
          );
        }
        complete = false;
        return null;
      }
      totalBytes += size;
      const manifest = readJson(file, limits, diagnostics);
      if (!manifest || typeof manifest !== "object") {
        complete = false;
        return null;
      }
      const packageRoot = path.dirname(file);
      const relativeRoot = posixRelative(root, packageRoot);
      return {
        id: `package:${relativeRoot}`,
        root: relativeRoot,
        file: posixRelative(root, file),
        name: typeof manifest.name === "string" ? manifest.name : null,
        version: typeof manifest.version === "string" ? manifest.version : null,
        express: expressDependency(manifest),
        frameworks: frameworkDependencies(manifest),
        manifest,
        absoluteRoot: packageRoot,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
  return { packages, complete };
}

function owningPackage(file, packages) {
  return packages
    .filter((candidate) => inside(candidate.absoluteRoot, file))
    .sort((a, b) => b.absoluteRoot.length - a.absoluteRoot.length)[0];
}

function targetStrings(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => targetStrings(item, output));
  else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => targetStrings(item, output));
  }
  return output;
}

function resolveEntry(packageRoot, target) {
  if (typeof target !== "string" || !target.startsWith(".")) return null;
  const base = path.resolve(packageRoot, target);
  const candidates = [base, ...[...SOURCE_EXTENSIONS].map((extension) => base + extension)];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next deterministic candidate.
    }
  }
  return null;
}

function sourceSignals(file) {
  let code = "";
  try {
    code = fs.readFileSync(file, "utf8");
  } catch {
    return { exported: false, listens: false };
  }
  return {
    exported:
      /module\.exports\s*=|exports\.[A-Za-z_$][\w$]*\s*=|export\s+default\b|export\s*\{/.test(code),
    listens: /\.listen\s*\(/.test(code),
  };
}

function addCandidate(candidates, root, file, score, reasons) {
  if (!file || !inside(root, file)) return;
  const key = posixRelative(root, file);
  const existing = candidates.get(key) || { path: key, score: 0, reasons: [] };
  existing.score = Math.max(existing.score, score);
  existing.reasons.push(...reasons.filter((reason) => !existing.reasons.includes(reason)));
  candidates.set(key, existing);
}

function entryCandidates(root, application, owner) {
  const sourceFile = application.source?.file;
  const candidates = new Map();
  if (sourceFile) {
    const signals = sourceSignals(sourceFile);
    let score = 60;
    const framework = application.framework || "express";
    const frameworkName =
      framework === "nestjs" ? "NestJS" : framework === "fastify" ? "Fastify" : "Express";
    const reasons = [`declares a ${frameworkName} application`];
    if (signals.exported) {
      score += 25;
      reasons.push("exports application/module state");
    }
    if (signals.listens) {
      score += 5;
      reasons.push("contains listen() boot wiring");
    }
    addCandidate(candidates, root, sourceFile, score, reasons);
  }
  if (owner) {
    const targets = [owner.manifest.main, ...targetStrings(owner.manifest.exports)];
    for (const target of targets) {
      const resolved = resolveEntry(owner.absoluteRoot, target);
      if (!resolved) continue;
      const same = sourceFile && path.resolve(sourceFile) === path.resolve(resolved);
      addCandidate(candidates, root, resolved, same ? 100 : 75, [
        same ? "package entry exports the detected app" : "declared package entry",
      ]);
    }
  }
  return [...candidates.values()]
    .map((candidate) => ({
      ...candidate,
      score: Math.min(candidate.score, 100),
      confidence: candidate.score >= 80 ? "high" : candidate.score >= 50 ? "medium" : "low",
    }))
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
}

function looksLikeSpec(file, maxFileBytes, diagnostics) {
  const extension = path.extname(file).toLowerCase();
  if (!DOC_EXTENSIONS.has(extension)) return null;
  let text;
  try {
    const size = fs.statSync(file).size;
    if (size > maxFileBytes) return null;
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    diagnostics.push(`discover: could not inspect ${file}: ${err.message}`);
    return null;
  }
  if (!/(^|[\s,{])["']?(openapi|swagger)["']?\s*:/m.test(text)) return null;
  try {
    const value = extension === ".json" ? JSON.parse(text) : YAML.parse(text);
    if (value && typeof value.openapi === "string")
      return { format: "openapi", version: value.openapi };
    if (value && typeof value.swagger === "string")
      return { format: "swagger", version: value.swagger };
  } catch {
    return { format: "candidate", version: null };
  }
  return null;
}

function moduleSpecSignal(file, code) {
  if (!MODULE_EXTENSIONS.has(path.extname(file).toLowerCase())) return false;
  if (SWAGGER_UI_RUNTIME_ASSET.test(path.basename(file))) return false;
  if (!/(?:module\.exports\s*=|export\s+default\b)/.test(code)) return false;
  if (!/(^|[\s,{])["']?(openapi|swagger)["']?\s*:/m.test(code)) return false;
  return /openapi|swagger|api[-_.]?docs?/i.test(file.split(path.sep).join("/"));
}

function inspectModuleSpec(root, file, code, opts, diagnostics) {
  if (!moduleSpecSignal(file, code)) return null;
  try {
    const loaded = loadStaticDocumentModule(file, { root, ...opts });
    const value = loaded.value;
    if (value && typeof value.openapi === "string") {
      return { format: "openapi-module", version: value.openapi };
    }
    if (value && typeof value.swagger === "string") {
      return { format: "swagger-module", version: value.swagger };
    }
    return null;
  } catch (err) {
    diagnostics.push(
      `discover: could not statically resolve OpenAPI module ${file}: ${err.message}`,
    );
    return { format: "openapi-module-candidate", version: null, incomplete: true };
  }
}

function discoverDocumentation(root, files, opts, diagnostics, packages = []) {
  const specifications = [];
  let complete = true;
  let totalBytes = 0;
  const deadline = Date.now() + opts.timeoutMs;
  for (const file of files) {
    if (!DOC_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    if (Date.now() >= deadline) {
      complete = false;
      diagnostics.push(
        `discover: stopped specification discovery at scan.timeoutMs (${opts.timeoutMs}ms)`,
      );
      break;
    }
    let size;
    try {
      size = fs.statSync(file).size;
    } catch (err) {
      complete = false;
      diagnostics.push(`discover: could not stat documentation candidate ${file}: ${err.message}`);
      continue;
    }
    if (size > opts.maxFileBytes) {
      complete = false;
      diagnostics.push(
        `discover: skipped documentation candidate ${file}: ${size} bytes exceeds scan.maxFileBytes (${opts.maxFileBytes})`,
      );
      continue;
    }
    if (totalBytes + size > opts.maxTotalBytes) {
      complete = false;
      diagnostics.push(
        `discover: stopped documentation discovery at scan.maxTotalBytes (${opts.maxTotalBytes})`,
      );
      break;
    }
    totalBytes += size;
    const detected = looksLikeSpec(file, opts.maxFileBytes || 5 * 1024 * 1024, diagnostics);
    if (detected) {
      specifications.push({
        path: posixRelative(root, file),
        ...detected,
        packageId: owningPackage(file, packages)?.id || null,
      });
    }
  }
  const jsdoc = [];
  const sourceFiles = listSourceFiles(root, {
    ...opts,
    maxFiles: opts.maxFiles,
    deadline,
    onTraversalError(current, err) {
      complete = false;
      diagnostics.push(
        `discover: could not read source directory ${posixRelative(root, current)}: ${err.message}`,
      );
    },
    onLimit(file) {
      complete = false;
      diagnostics.push(
        `discover: stopped JSDoc discovery at scan.maxFiles (${opts.maxFiles}); first omitted file: ${posixRelative(root, file)}`,
      );
    },
    onTimeout(current) {
      complete = false;
      diagnostics.push(
        `discover: stopped JSDoc discovery at scan.timeoutMs (${opts.timeoutMs}ms) while reading ${posixRelative(root, current)}`,
      );
    },
  });
  for (const file of sourceFiles) {
    if (Date.now() >= deadline) {
      complete = false;
      diagnostics.push(
        `discover: stopped JSDoc inspection at scan.timeoutMs (${opts.timeoutMs}ms)`,
      );
      break;
    }
    try {
      const size = fs.statSync(file).size;
      if (size > (opts.maxFileBytes || 5 * 1024 * 1024)) {
        complete = false;
        continue;
      }
      if (totalBytes + size > opts.maxTotalBytes) {
        complete = false;
        diagnostics.push(
          `discover: stopped JSDoc inspection at scan.maxTotalBytes (${opts.maxTotalBytes})`,
        );
        break;
      }
      totalBytes += size;
      const code = fs.readFileSync(file, "utf8");
      if (/@(?:openapi|swagger)\b/.test(code)) {
        jsdoc.push(posixRelative(root, file));
      }
      const detected = inspectModuleSpec(root, file, code, opts, diagnostics);
      if (detected) {
        if (detected.incomplete) complete = false;
        const { incomplete: _incomplete, ...specification } = detected;
        specifications.push({
          path: posixRelative(root, file),
          ...specification,
          packageId: owningPackage(file, packages)?.id || null,
        });
      }
    } catch (err) {
      complete = false;
      diagnostics.push(`discover: could not inspect JSDoc source ${file}: ${err.message}`);
    }
  }
  specifications.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return { documentation: { specifications, jsdoc: jsdoc.sort() }, complete };
}

/** Discover repository packages, supported HTTP applications, entry candidates, and API docs. */
function discover(rootDir, opts = {}) {
  const root = path.resolve(rootDir);
  const limits = scanLimits(opts);
  const diagnostics = [];
  const collection = collectRepositoryFiles(root, limits, diagnostics, opts);
  const files = collection.files;
  const packageDiscovery = discoverPackages(root, files, limits, diagnostics);
  const packages = packageDiscovery.packages;
  const registry = scan(root, opts);
  const applications = registry.applications.map((application) => {
    const owner = application.source?.file
      ? owningPackage(application.source.file, packages)
      : null;
    const candidates = entryCandidates(root, application, owner);
    return {
      ...application,
      source: application.source
        ? { ...application.source, file: posixRelative(root, application.source.file) }
        : null,
      packageId: owner?.id || null,
      entryCandidates: candidates,
      recommendedEntry:
        candidates.length === 1 && candidates[0].confidence === "high" ? candidates[0].path : null,
    };
  });
  const documentation = discoverDocumentation(
    root,
    files,
    { ...opts, ...limits },
    diagnostics,
    packages,
  );
  return {
    schemaVersion: "1.0",
    tool: "express-recon",
    toolVersion: pkg.version,
    packages: packages.map((item) => ({
      id: item.id,
      root: item.root,
      file: item.file,
      name: item.name,
      version: item.version,
      express: item.express,
      frameworks: item.frameworks,
    })),
    applications,
    documentation: documentation.documentation,
    discoveryCoverage: {
      files: files.length,
      complete: collection.complete && packageDiscovery.complete && documentation.complete,
      scope: collection.scope,
    },
    orphanRoutes: registry.routes.filter((route) => route.applicationId === null).length,
    scanCoverage: registry.scanCoverage,
    routeGraph: registry.routeGraph,
    diagnostics: [...diagnostics, ...(registry.diagnostics || [])].map((message) =>
      message.split(root).join("."),
    ),
  };
}

module.exports = { discover };
