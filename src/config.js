"use strict";

const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { validateAuthMiddleware, validateAuthWrappers } = require("./classify");
const { normalizePolicies } = require("./policies");
const { runtimeLimits } = require("./runtime/execute");
const { scanLimits } = require("./static/scan");

const CONFIG_KEYS = new Set([
  "acceptedPublic",
  "authMiddleware",
  "authWrappers",
  "boot",
  "openapi",
  "policies",
  "scan",
]);
const SCAN_KEYS = new Set([
  "exclude",
  "ignoreFile",
  "include",
  "includeHidden",
  "maxFileBytes",
  "maxFiles",
  "maxTotalBytes",
  "timeoutMs",
]);
const OPENAPI_KEYS = new Set(["securityByTag", "securitySchemes"]);
const ACCEPTED_PUBLIC_KEYS = new Set(["applicationId", "method", "path"]);
const ROUTE_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ALL"]);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function knownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unknown field(s): ${unknown.join(", ")}`);
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
}

function acceptedPublicKey(entry, index) {
  if (typeof entry === "string") {
    if (
      entry !== entry.trim() ||
      !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ALL) \/[^\r\n]*$/.test(entry)
    ) {
      throw new Error(
        `acceptedPublic entry "${entry}" must use the form "METHOD /path" with an uppercase method`,
      );
    }
    return `global\0${entry}`;
  }

  const label = `acceptedPublic[${index}]`;
  if (!plainObject(entry)) {
    throw new Error(
      'acceptedPublic must contain "METHOD /path" strings or application-scoped route objects',
    );
  }
  knownKeys(entry, ACCEPTED_PUBLIC_KEYS, label);
  if (
    typeof entry.applicationId !== "string" ||
    !entry.applicationId.trim() ||
    entry.applicationId !== entry.applicationId.trim()
  ) {
    throw new Error(`${label}.applicationId must be a non-empty string`);
  }
  if (typeof entry.method !== "string" || !ROUTE_METHODS.has(entry.method)) {
    throw new Error(`${label}.method must be a supported uppercase HTTP method`);
  }
  if (
    typeof entry.path !== "string" ||
    !entry.path.startsWith("/") ||
    entry.path !== entry.path.trim() ||
    /[\r\n]/.test(entry.path)
  ) {
    throw new Error(`${label}.path must start with "/"`);
  }
  return `application\0${entry.applicationId}\0${entry.method}\0${entry.path}`;
}

function validateOpenApi(value) {
  if (value === undefined) return;
  if (!plainObject(value)) throw new Error("openapi must be an object");
  knownKeys(value, OPENAPI_KEYS, "openapi");

  const schemes = value.securitySchemes || {};
  if (!plainObject(schemes)) throw new Error("openapi.securitySchemes must be an object");
  for (const [name, scheme] of Object.entries(schemes)) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error(`openapi.securitySchemes contains invalid component name "${name}"`);
    }
    if (!plainObject(scheme) || typeof scheme.type !== "string" || !scheme.type.trim()) {
      throw new Error(`openapi.securitySchemes.${name} must be an OpenAPI Security Scheme object`);
    }
  }

  const byTag = value.securityByTag || {};
  if (!plainObject(byTag)) throw new Error("openapi.securityByTag must be an object");
  for (const [tag, names] of Object.entries(byTag)) {
    if (!tag.trim()) throw new Error("openapi.securityByTag tags must not be empty");
    stringArray(names, `openapi.securityByTag.${tag}`);
    if (names.length === 0) throw new Error(`openapi.securityByTag.${tag} must not be empty`);
    if (new Set(names).size !== names.length) {
      throw new Error(`openapi.securityByTag.${tag} must not contain duplicates`);
    }
    const missing = names.find((name) => !Object.hasOwn(schemes, name));
    if (missing) {
      throw new Error(
        `openapi.securityByTag.${tag} references undefined security scheme "${missing}"`,
      );
    }
  }
}

function validateConfig(value) {
  if (!plainObject(value)) throw new Error("configuration must be an object");
  knownKeys(value, CONFIG_KEYS, "configuration");
  validateAuthMiddleware(value.authMiddleware || {});
  validateAuthWrappers(value.authWrappers || []);

  if (value.acceptedPublic !== undefined) {
    if (!Array.isArray(value.acceptedPublic)) {
      throw new Error("acceptedPublic must be an array");
    }
    const keys = value.acceptedPublic.map(acceptedPublicKey);
    if (new Set(keys).size !== keys.length) {
      throw new Error("acceptedPublic must not contain duplicate entries");
    }
  }

  normalizePolicies(value.policies);
  validateOpenApi(value.openapi);

  if (value.scan !== undefined) {
    if (!plainObject(value.scan)) throw new Error("scan must be an object");
    knownKeys(value.scan, SCAN_KEYS, "scan");
    if (value.scan.include !== undefined) stringArray(value.scan.include, "scan.include");
    if (value.scan.exclude !== undefined) stringArray(value.scan.exclude, "scan.exclude");
    if (value.scan.includeHidden !== undefined && typeof value.scan.includeHidden !== "boolean") {
      throw new Error("scan.includeHidden must be a boolean");
    }
    if (
      value.scan.ignoreFile !== undefined &&
      value.scan.ignoreFile !== false &&
      (typeof value.scan.ignoreFile !== "string" || !value.scan.ignoreFile.trim())
    ) {
      throw new Error("scan.ignoreFile must be a non-empty string or false");
    }
    scanLimits(value.scan);
  }

  runtimeLimits(value.boot || {});
  return value;
}

function configObject(value, file) {
  if (Array.isArray(value)) return validateConfig({ policies: value });
  if (!value || typeof value !== "object") {
    throw new Error(`Configuration ${file} must contain an object or a policy array`);
  }
  return validateConfig(value);
}

/**
 * Load executable CommonJS config or data-only JSON/YAML. A top-level array in
 * a data file is shorthand for `{ policies: [...] }`.
 */
function loadConfig(configPath) {
  if (!configPath) return {};
  const resolved = path.resolve(configPath);
  const extension = path.extname(resolved).toLowerCase();
  try {
    if (extension === ".json") {
      return configObject(JSON.parse(fs.readFileSync(resolved, "utf8")), resolved);
    }
    if (extension === ".yaml" || extension === ".yml") {
      return configObject(YAML.parse(fs.readFileSync(resolved, "utf8")), resolved);
    }
    return configObject(require(resolved), resolved);
  } catch (err) {
    throw new Error(`Could not load configuration ${resolved}: ${err.message}`);
  }
}

module.exports = { loadConfig, validateConfig };
