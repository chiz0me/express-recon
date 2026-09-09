"use strict";

const Ajv = require("ajv/dist/2020");
const pkg = require("../package.json");
const base = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" };
const version = { type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$" };
const sha = { type: "string", pattern: "^[a-f0-9]{64}$" };
const SOURCE_SCHEMA = {
  ...base,
  required: [
    "schemaVersion",
    "kind",
    "repository",
    "commit",
    "applicationId",
    "scanSettings",
    "settingsFingerprint",
    "toolVersion",
    "reportSchemaVersion",
    "inventoryToolVersion",
    "inventoryConfigHash",
    "inventoryScanHash",
  ],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: "1.0" },
    kind: { const: "express-recon-workspace-source" },
    repository: { type: "string", pattern: "^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$" },
    commit: { type: "string", pattern: "^[a-f0-9]{40,64}$" },
    applicationId: { type: "string", minLength: 1, maxLength: 1000 },
    scanSettings: {
      type: "object",
      required: ["config", "scan"],
      additionalProperties: false,
      properties: {
        config: { type: "object" },
        scan: { type: "object" },
        externalIgnore: {
          type: "object",
          required: ["name", "content"],
          additionalProperties: false,
          properties: { name: { type: "string" }, content: { type: "string", maxLength: 1048576 } },
        },
      },
    },
    settingsFingerprint: sha,
    toolVersion: version,
    inventoryToolVersion: version,
    reportSchemaVersion: { const: "2.0" },
    inventoryConfigHash: { anyOf: [sha, { type: "null" }] },
    inventoryScanHash: { anyOf: [sha, { type: "null" }] },
  },
};
const ORGANIZATION_MANIFEST_SCHEMA = {
  ...base,
  required: ["schemaVersion", "kind", "toolVersion", "integrity"],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: "1.0" },
    kind: { const: "express-recon-organization-manifest" },
    toolVersion: version,
    integrity: {
      type: "object",
      minProperties: 1,
      maxProperties: 200000,
      additionalProperties: {
        type: "object",
        required: ["bytes", "sha256"],
        additionalProperties: false,
        properties: { bytes: { type: "integer", minimum: 0, maximum: 134217728 }, sha256: sha },
      },
    },
  },
};
const ORGANIZATION_SCHEMA = {
  ...base,
  required: [
    "schemaVersion",
    "tool",
    "toolVersion",
    "kind",
    "organization",
    "repositories",
    "summary",
    "coverage",
  ],
  properties: {
    schemaVersion: { const: "1.0" },
    tool: { const: "express-recon" },
    toolVersion: version,
    kind: { const: "github-organization-inventory" },
    organization: {
      type: "object",
      required: ["login"],
      properties: { login: { type: "string", pattern: "^[A-Za-z0-9-]+$" } },
    },
    summary: { type: "object" },
    coverage: {
      type: "object",
      required: ["complete"],
      properties: { complete: { type: "boolean" } },
    },
    scanSettings: SOURCE_SCHEMA.properties.scanSettings,
    repositories: {
      type: "array",
      maxItems: 100000,
      items: {
        type: "object",
        required: ["repository", "status"],
        properties: {
          repository: {
            type: "object",
            required: ["name", "fullName"],
            properties: {
              name: { type: "string", minLength: 1 },
              fullName: { type: "string", pattern: "^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$" },
            },
          },
          status: { type: "string", minLength: 1 },
          commit: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{40,64}$" }, { type: "null" }] },
          artifacts: {
            type: "object",
            additionalProperties: { type: "string", minLength: 1 },
            properties: {
              specifications: {
                type: "array",
                items: {
                  type: "object",
                  required: ["artifact"],
                  properties: {
                    artifact: { type: "string", minLength: 1 },
                    reconciliation: { type: "object" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
const schemas = {
  source: SOURCE_SCHEMA,
  organization: ORGANIZATION_SCHEMA,
  organizationManifest: ORGANIZATION_MANIFEST_SCHEMA,
};
const validators = new Map();
function validateSavedContract(name, value) {
  if (!validators.has(name))
    validators.set(name, new Ajv({ strict: false }).compile(schemas[name]));
  const validate = validators.get(name);
  if (!validate(value))
    throw new Error(
      `Invalid saved ${name} schema: ${validate.errors[0].instancePath} ${validate.errors[0].message}`,
    );
}
function validateSavedToolVersion(versionValue) {
  if (typeof versionValue !== "string" || !new RegExp(version.pattern).test(versionValue))
    throw new Error("Invalid saved tool version");
  const requested = versionValue.split(/[.+-]/).slice(0, 3).map(Number);
  const current = pkg.version.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (requested[index] > current[index])
      throw new Error(
        "Saved state was produced by a newer tool version; upgrade before loading it",
      );
    if (requested[index] < current[index]) break;
  }
}
module.exports = {
  SOURCE_SCHEMA,
  ORGANIZATION_SCHEMA,
  ORGANIZATION_MANIFEST_SCHEMA,
  validateSavedContract,
  validateSavedToolVersion,
};
