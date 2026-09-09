"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createDiagnosticCollector,
  invalidSpecificationDiagnostic,
  DIAGNOSTICS_SCHEMA,
} = require("../src/report-diagnostics");
const Ajv = require("ajv/dist/2020");

test("diagnostics preserve legacy observations, normalize context and classify causes without duplicate counts", () => {
  const warnings = ["Optional integration unavailable"];
  const collector = createDiagnosticCollector(warnings);
  const item = invalidSpecificationDiagnostic(
    {
      path: "source.yaml",
      artifact: "raw.yaml",
      diagnostic: {
        message: "Offline validation requires self-contained OpenAPI references: other.yaml",
        reference: "other.yaml",
      },
    },
    "acme/api",
  );
  collector.add(item);
  collector.add(item);
  assert.equal(warnings.length, 3);
  assert.equal(collector.diagnostics.length, 2);
  assert.equal(collector.summary.invalidSpecifications, 1);
  assert.equal(collector.summary.affectedRepositories, 1);
  assert.equal(collector.summary.byCategory.render, 1);
  assert.equal(item.cause, "external-reference");
  assert.equal(
    invalidSpecificationDiagnostic({ reason: "Invalid JSON" }).cause,
    "invalid-document",
  );
  assert.equal(
    invalidSpecificationDiagnostic({ diagnostic: { message: {} } }).message,
    "Invalid source API specification",
  );
  collector.add({
    ...item,
    repository: null,
    sourcePath: null,
    artifactPath: null,
    applicationId: {},
  });
  const validate = new Ajv({ strict: false }).compile(DIAGNOSTICS_SCHEMA);
  assert.equal(
    validate({ diagnostics: collector.diagnostics, diagnosticSummary: collector.summary }),
    true,
    JSON.stringify(validate.errors),
  );
});
