"use strict";

const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { validateAuthMiddleware, validateAuthWrappers } = require("./classify");
const { normalizePolicies } = require("./policies");
const { runtimeLimits } = require("./runtime/execute");

const CONFIG_KEYS = new Set([
  "acceptedPublic",
  "authMiddleware",
  "authWrappers",
  "boot",
  "policies",
  "scan",
]);
const SCAN_KEYS = new Set(["exclude", "ignoreFile", "include"]);

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

function validateConfig(value) {
  if (!plainObject(value)) throw new Error("configuration must be an object");
  knownKeys(value, CONFIG_KEYS, "configuration");
  validateAuthMiddleware(value.authMiddleware || {});
  validateAuthWrappers(value.authWrappers || []);

  if (value.acceptedPublic !== undefined) {
    stringArray(value.acceptedPublic, "acceptedPublic");
    const invalid = value.acceptedPublic.find(
      (entry) => !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ALL) \/.*/.test(entry),
    );
    if (invalid) {
      throw new Error(
        `acceptedPublic entry "${invalid}" must use the form "METHOD /path" with an uppercase method`,
      );
    }
    if (new Set(value.acceptedPublic).size !== value.acceptedPublic.length) {
      throw new Error("acceptedPublic must not contain duplicate entries");
    }
  }

  normalizePolicies(value.policies);

  if (value.scan !== undefined) {
    if (!plainObject(value.scan)) throw new Error("scan must be an object");
    knownKeys(value.scan, SCAN_KEYS, "scan");
    if (value.scan.include !== undefined) stringArray(value.scan.include, "scan.include");
    if (value.scan.exclude !== undefined) stringArray(value.scan.exclude, "scan.exclude");
    if (
      value.scan.ignoreFile !== undefined &&
      value.scan.ignoreFile !== false &&
      (typeof value.scan.ignoreFile !== "string" || !value.scan.ignoreFile.trim())
    ) {
      throw new Error("scan.ignoreFile must be a non-empty string or false");
    }
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
