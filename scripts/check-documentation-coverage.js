#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const REFERENCE = path.join(ROOT, "docs", "reference.md");
const API_REFERENCE = path.join(ROOT, "docs", "api.md");
const CLI = path.join(ROOT, "src", "cli.js");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function literalSet(relativePath, name) {
  const source = read(relativePath);
  const match = source.match(
    new RegExp(`const\\s+${escapeRegex(name)}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\);`),
  );
  if (!match) throw new Error(`could not locate literal set ${name} in ${relativePath}`);
  return [...match[1].matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map((item) => item[1]);
}

function literalArray(relativePath, name) {
  const source = read(relativePath);
  const match = source.match(
    new RegExp(`const\\s+${escapeRegex(name)}\\s*=\\s*\\[([\\s\\S]*?)\\];`),
  );
  if (!match) throw new Error(`could not locate literal array ${name} in ${relativePath}`);
  return [...match[1].matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map((item) => item[1]);
}

function cliSurface() {
  const result = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`CLI help failed: ${result.stderr.trim()}`);
  const help = result.stdout;
  const commandBlock = help.match(/Commands:\n([\s\S]*?)\nOptions:/);
  if (!commandBlock) throw new Error("CLI help has no Commands/Options sections");
  return {
    commands: [...commandBlock[1].matchAll(/^  ([a-z][a-z-]+)(?:\s|$)/gm)].map((match) => match[1]),
    options: [
      ...new Set([...help.matchAll(/^  (--[a-z][a-z-]+)(?:[,\s]|$)/gm)].map((match) => match[1])),
    ],
    environment: [...new Set(help.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || [])],
  };
}

function configurationSurface() {
  const groups = [
    ["src/config.js", "CONFIG_KEYS", ""],
    ["src/config.js", "SCAN_KEYS", "scan."],
    ["src/config.js", "OPENAPI_KEYS", "openapi."],
    ["src/config.js", "ACCEPTED_PUBLIC_KEYS", "acceptedPublic[]."],
    ["src/runtime/execute.js", "BOOT_KEYS", "boot."],
    ["src/classify.js", "AUTH_GRANT_KEYS", "authMiddleware.<name>."],
    ["src/policies.js", "POLICY_KEYS", "policies[]."],
    ["src/policies.js", "MATCH_KEYS", "policies[].match."],
    ["src/policies.js", "REQUIREMENT_KEYS", "policies[].require."],
    ["src/policies.js", "EXCEPTION_KEYS", "policies[].exceptions[]."],
  ];
  const fields = groups.flatMap(([file, name, prefix]) =>
    literalSet(file, name).map((field) => `${prefix}${field}`),
  );
  fields.push(
    ...literalArray("src/policies.js", "ARRAY_REQUIREMENTS").map(
      (field) => `policies[].require.${field}`,
    ),
  );
  return fields;
}

function walkFiles(directory) {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walkFiles(target));
    else if (entry.isFile()) output.push(target);
  }
  return output;
}

function localLinks(markdownFile) {
  const markdown = fs.readFileSync(markdownFile, "utf8");
  const links = [];
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const decoded = decodeURIComponent(target.split("#", 1)[0]);
    links.push(path.resolve(path.dirname(markdownFile), decoded));
  }
  return links;
}

function exampleSurface() {
  const root = path.join(ROOT, "examples");
  const files = walkFiles(root);
  const readmes = files.filter((file) => path.basename(file) === "README.md");
  const linked = new Set(readmes.flatMap(localLinks));
  return {
    expected: files.filter((file) => file !== path.join(root, "README.md")),
    covered: linked,
  };
}

function documentationSurface() {
  const rootDocuments = ["README.md", "SECURITY.md", "CONTRIBUTING.md", "RELEASING.md"].map(
    (file) => path.join(ROOT, file),
  );
  const documents = [
    ...rootDocuments,
    ...["docs", "examples", "skills"].flatMap((directory) =>
      walkFiles(path.join(ROOT, directory)).filter((file) => file.endsWith(".md")),
    ),
  ];
  return {
    expected: documents.filter((file) => file !== path.join(ROOT, "README.md")),
    covered: new Set(documents.flatMap(localLinks)),
  };
}

function mcpTools() {
  return [...read("src/mcp/server.js").matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].map(
    (match) => match[1],
  );
}

function publicApiJSDoc(publicExports) {
  const index = read("src/index.js");
  const properties = new Set(
    [...index.matchAll(/@property\s+\{[^}]+\}\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g)].map(
      (match) => match[1],
    ),
  );
  return {
    covered: properties,
    unexpected: [...properties].filter((name) => !publicExports.includes(name)),
  };
}

function implementationJSDoc(functionNames) {
  const sources = walkFiles(path.join(ROOT, "src")).filter((file) => file.endsWith(".js"));
  const covered = new Set();
  const diagnostics = [];
  for (const name of functionNames) {
    const pattern = new RegExp(`(?:async\\s+)?function\\s+${escapeRegex(name)}\\s*\\(`, "g");
    const declarations = [];
    for (const file of sources) {
      const source = fs.readFileSync(file, "utf8");
      const match = pattern.exec(source);
      pattern.lastIndex = 0;
      if (match) declarations.push({ file, source, index: match.index });
    }
    if (declarations.length !== 1) {
      diagnostics.push(`${name}: expected one named implementation, found ${declarations.length}`);
      continue;
    }
    const declaration = declarations[0];
    const prefix = declaration.source.slice(0, declaration.index).trimEnd();
    if (!prefix.endsWith("*/")) {
      diagnostics.push(`${name}: implementation has no adjacent JSDoc comment`);
      continue;
    }
    const commentStart = prefix.lastIndexOf("/**");
    if (commentStart < 0 || prefix.slice(commentStart).includes("*/", 3) === false) {
      diagnostics.push(`${name}: adjacent block is not JSDoc`);
      continue;
    }
    covered.add(name);
  }
  return { covered, diagnostics };
}

function category(name, expected, predicate) {
  const unique = [...new Set(expected)];
  const missing = unique.filter((item) => !predicate(item));
  return { name, covered: unique.length - missing.length, total: unique.length, missing };
}

function collectCoverage() {
  const cli = cliSurface();
  const reference = fs.readFileSync(REFERENCE, "utf8");
  const apiReference = fs.readFileSync(API_REFERENCE, "utf8");
  const publicApi = require(path.join(ROOT, "src", "index.js"));
  const publicExports = Object.keys(publicApi);
  const publicFunctions = publicExports.filter((name) => typeof publicApi[name] === "function");
  const typedef = publicApiJSDoc(publicExports);
  const implementations = implementationJSDoc(publicFunctions);
  const examples = exampleSurface();
  const documents = documentationSurface();
  const packageJson = JSON.parse(read("package.json"));
  const mcpGuide = read("docs/ai-agent-guide.md");
  const contributing = read("CONTRIBUTING.md");
  const readme = read("README.md");
  const token = (document, value) => document.includes(`\`${value}\``);
  const categories = [
    category("CLI commands", cli.commands, (name) =>
      new RegExp("^### `" + escapeRegex(name) + "`$", "m").test(reference),
    ),
    category("CLI options", cli.options, (name) => token(reference, name)),
    category("environment variables", cli.environment, (name) => token(reference, name)),
    category("library exports", publicExports, (name) =>
      new RegExp("^### `" + escapeRegex(name) + "(?:\\([^\\n]*\\))?`$", "m").test(apiReference),
    ),
    category("configuration fields", configurationSurface(), (name) => token(reference, name)),
    category("report fields", Object.keys(publicApi.REPORT_SCHEMA.properties), (name) =>
      token(reference, name),
    ),
    category("MCP tools", mcpTools(), (name) => token(mcpGuide, name)),
    category("package binaries", Object.keys(packageJson.bin), (name) => token(readme, name)),
    category("development scripts", Object.keys(packageJson.scripts), (name) => {
      const command = name === "test" ? "npm test" : `npm run ${name}`;
      return token(contributing, command);
    }),
    category("bundled skills", fs.readdirSync(path.join(ROOT, "skills")), (name) =>
      token(readme, name),
    ),
    category("example files", examples.expected, (file) => examples.covered.has(file)),
    category("documentation navigation", documents.expected, (file) => documents.covered.has(file)),
    category("public API typedef comments", publicExports, (name) => typedef.covered.has(name)),
    category("public function JSDoc", publicFunctions, (name) => implementations.covered.has(name)),
  ];
  const diagnostics = [
    ...typedef.unexpected.map((name) => `index typedef documents non-export ${name}`),
    ...implementations.diagnostics,
  ];
  const total = categories.reduce((sum, item) => sum + item.total, 0);
  const covered = categories.reduce((sum, item) => sum + item.covered, 0);
  return { categories, covered, total, diagnostics };
}

function printCoverage(report) {
  for (const item of report.categories) {
    const percentage = item.total === 0 ? 100 : (item.covered / item.total) * 100;
    process.stdout.write(
      `${item.name}: ${percentage.toFixed(2)}% (${item.covered}/${item.total})\n`,
    );
    for (const missing of item.missing) {
      const label = path.isAbsolute(missing) ? path.relative(ROOT, missing) : missing;
      process.stderr.write(`missing ${item.name}: ${label}\n`);
    }
  }
  const percentage = report.total === 0 ? 100 : (report.covered / report.total) * 100;
  process.stdout.write(
    `documentation coverage: ${percentage.toFixed(2)}% (${report.covered}/${report.total})\n`,
  );
  for (const diagnostic of report.diagnostics) process.stderr.write(`${diagnostic}\n`);
}

if (require.main === module) {
  try {
    const report = collectCoverage();
    printCoverage(report);
    if (report.covered !== report.total || report.diagnostics.length) process.exitCode = 1;
  } catch (err) {
    process.stderr.write(`documentation coverage failed: ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { collectCoverage, printCoverage };
