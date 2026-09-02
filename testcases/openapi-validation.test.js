"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { validateOpenApiDocument } = require("../src/openapi-validation");

function document(version, schema = { type: "string" }) {
  return {
    openapi: version,
    info: { title: "Validation fixture", version: "1.0.0" },
    paths: {
      "/things": {
        get: {
          responses: {
            200: {
              description: "ok",
              content: { "application/json": { schema } },
            },
          },
        },
      },
    },
  };
}

test("OpenAPI validation uses the declared 3.0 or 3.1 dialect", () => {
  const nullableUnion = { type: ["string", "null"] };
  assert.throws(
    () => validateOpenApiDocument(document("3.0.3", nullableUnion)),
    /failed OpenAPI 3\.0 validation/,
  );
  assert.deepEqual(validateOpenApiDocument(document("3.1.0", nullableUnion)), {
    version: "3.1.0",
    family: "3.1",
  });
});

test("OpenAPI validation rejects structurally incomplete operations", () => {
  const invalid = document("3.1.0");
  invalid.paths["/things"].get.parameters = [{ name: "query" }];
  assert.throws(
    () => validateOpenApiDocument(invalid, "edited contract"),
    /edited contract failed OpenAPI 3\.1 validation.*required property/,
  );
});

test("OpenAPI validation rejects unsupported versions without network resolution", () => {
  assert.throws(() => validateOpenApiDocument(document("4.0.0")), /unsupported for validation/);
});

test("OpenAPI validation rejects non-documents and missing version declarations", () => {
  assert.throws(
    () => validateOpenApiDocument(null, "candidate"),
    /candidate must contain an object/,
  );
  assert.throws(
    () => validateOpenApiDocument({ paths: {} }, "candidate"),
    /candidate must declare an OpenAPI 3\.0\.x or 3\.1\.x version/,
  );
});
