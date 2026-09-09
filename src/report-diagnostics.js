"use strict";

const nullableText = { type: ["string", "null"] };
const nonnegative = { type: "integer", minimum: 0 };
const DIAGNOSTICS_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Express Recon report diagnostics (additive fields, v1)",
  type: "object",
  required: ["diagnostics", "diagnosticSummary"],
  properties: {
    diagnostics: {
      type: "array",
      items: {
        type: "object",
        required: [
          "code",
          "category",
          "repository",
          "applicationId",
          "sourcePath",
          "artifactPath",
          "message",
        ],
        additionalProperties: false,
        properties: {
          code: {
            enum: ["invalid-source-specification", "artifact-unavailable", "render-warning"],
          },
          category: { enum: ["invalid-api-specification", "artifact", "render"] },
          repository: nullableText,
          applicationId: nullableText,
          sourcePath: nullableText,
          artifactPath: nullableText,
          message: { type: "string" },
          reference: { type: "string" },
          cause: {
            enum: [
              "unresolved-reference",
              "external-reference",
              "invalid-schema",
              "invalid-document",
            ],
          },
        },
      },
    },
    diagnosticSummary: {
      type: "object",
      additionalProperties: false,
      required: ["total", "byCategory", "invalidSpecifications", "affectedRepositories"],
      properties: {
        total: nonnegative,
        invalidSpecifications: nonnegative,
        affectedRepositories: nonnegative,
        byCategory: {
          type: "object",
          additionalProperties: false,
          required: ["invalid-api-specification", "artifact", "render"],
          properties: {
            "invalid-api-specification": nonnegative,
            artifact: nonnegative,
            render: nonnegative,
          },
        },
      },
    },
  },
};
const textOrNull = (value) => (typeof value === "string" && value ? value : null);

function invalidSpecificationDiagnostic(specification, repository = null) {
  const original = specification.diagnostic || {};
  const message =
    textOrNull(original.message) ||
    textOrNull(specification.reason) ||
    "Invalid source API specification";
  const cause = /Unresolved OpenAPI reference|does not resolve/.test(message)
    ? "unresolved-reference"
    : /self-contained OpenAPI references/.test(message)
      ? "external-reference"
      : /schema validation|schema is invalid/i.test(message)
        ? "invalid-schema"
        : "invalid-document";
  return {
    code: "invalid-source-specification",
    category: "invalid-api-specification",
    repository: repository || original.repository || null,
    applicationId: specification.applicationId || original.applicationId || null,
    sourcePath: specification.path || original.sourcePath || null,
    artifactPath: specification.artifact || original.artifactPath || null,
    message,
    ...(original.reference !== undefined ? { reference: original.reference } : {}),
    cause,
  };
}

function summarizeDiagnostics(diagnostics) {
  const byCategory = { "invalid-api-specification": 0, artifact: 0, render: 0 };
  const specifications = new Set();
  const repositories = new Set();
  for (const item of diagnostics) {
    byCategory[item.category]++;
    if (item.category === "invalid-api-specification") {
      specifications.add(
        JSON.stringify([item.repository?.toLowerCase(), item.artifactPath || item.sourcePath]),
      );
      if (item.repository) repositories.add(item.repository.toLowerCase());
    }
  }
  return {
    total: diagnostics.length,
    byCategory,
    invalidSpecifications: specifications.size,
    affectedRepositories: repositories.size,
  };
}

// Legacy warnings remain strings. Classification is explicit at the producer;
// unclassified legacy notices are render notices, never guessed artifact errors.
function createDiagnosticCollector(warnings) {
  const records = new Map();
  const classified = new Set();
  const normalize = (item) => ({
    code: item.code,
    category: item.category,
    repository: textOrNull(item.repository),
    applicationId: textOrNull(item.applicationId),
    sourcePath: textOrNull(item.sourcePath),
    artifactPath: textOrNull(item.artifactPath),
    message: item.message,
    ...(typeof item.reference === "string" ? { reference: item.reference } : {}),
    ...(item.cause ? { cause: item.cause } : {}),
  });
  return {
    add(item, warning = item.message) {
      const value = normalize(item);
      records.set(JSON.stringify(value), value);
      classified.add(warning);
      warnings.push(warning);
    },
    get diagnostics() {
      const all = new Map(records);
      for (const message of warnings) {
        if (classified.has(message)) continue;
        const value = normalize({ code: "render-warning", category: "render", message });
        all.set(JSON.stringify(value), value);
      }
      return [...all.values()].sort((a, b) => {
        const left = JSON.stringify(a),
          right = JSON.stringify(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });
    },
    get summary() {
      return summarizeDiagnostics(this.diagnostics);
    },
  };
}

module.exports = {
  DIAGNOSTICS_SCHEMA,
  invalidSpecificationDiagnostic,
  summarizeDiagnostics,
  createDiagnosticCollector,
};
