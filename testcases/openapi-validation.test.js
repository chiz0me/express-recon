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

test("OpenAPI validation requires matching path parameter declarations in operations", () => {
  const doc = document("3.1.0");
  doc.paths["/items/{itemId}"] = {
    get: {
      responses: { 200: { description: "ok" } },
    },
  };
  assert.throws(
    () => validateOpenApiDocument(doc, "contract"),
    /contract path "\/items\/\{itemId\}" operation GET is missing required path parameter declaration for '\{itemId\}'/,
  );

  // When properly declared, validation succeeds
  doc.paths["/items/{itemId}"].get.parameters = [
    { name: "itemId", in: "path", required: true, schema: { type: "string" } },
  ];
  assert.doesNotThrow(() => validateOpenApiDocument(doc, "contract"));

  // Extraneous path parameter declaration in operation fails
  doc.paths["/items/{itemId}"].get.parameters.push({
    name: "extra",
    in: "path",
    required: true,
    schema: { type: "string" },
  });
  assert.throws(
    () => validateOpenApiDocument(doc, "contract"),
    /contract path "\/items\/\{itemId\}" operation GET declares path parameter 'extra' which is not in the path template/,
  );
});

test("OpenAPI validation resolves parameter $ref references", () => {
  const doc = document("3.1.0");
  doc.paths["/users/{userId}"] = {
    get: {
      parameters: [{ $ref: "#/components/parameters/UserId" }],
      responses: { 200: { description: "ok" } },
    },
  };
  doc.components = {
    parameters: {
      UserId: {
        name: "userId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    },
  };
  assert.doesNotThrow(() => validateOpenApiDocument(doc, "contract with $ref"));
});

test("OpenAPI validation preserves external parameter and path-item references", () => {
  const doc = document("3.1.0");
  doc.paths["/users/{userId}"] = {
    get: {
      parameters: [{ $ref: "./parameters.yaml#/UserId" }],
      responses: { 200: { description: "ok" } },
    },
  };
  doc.paths["/teams/{teamId}"] = { $ref: "./paths.yaml#/Team" };
  assert.doesNotThrow(() => validateOpenApiDocument(doc, "contract with external $refs"));
});

test("OpenAPI semantic checks avoid false claims for unresolved or cyclic local references", () => {
  const doc = document("3.1.0");
  doc.paths["/users/{userId}"] = {
    get: {
      parameters: [{ $ref: "#/components/parameters/A" }],
      responses: { 200: { description: "ok" } },
    },
  };
  doc.components = {
    parameters: {
      A: { $ref: "#/components/parameters/B" },
      B: { $ref: "#/components/parameters/A" },
    },
  };
  assert.doesNotThrow(() => validateOpenApiDocument(doc, "contract with cyclic $refs"));

  doc.paths["/users/{userId}"].get.parameters = [{ $ref: "#/components/parameters/Missing" }];
  assert.doesNotThrow(() => validateOpenApiDocument(doc, "contract with unresolved $ref"));

  doc.paths["/users/{userId}"].get.parameters = [{ $ref: "#/components/parameters/%ZZ" }];
  assert.throws(
    () => validateOpenApiDocument(doc, "contract with malformed $ref"),
    (error) =>
      error instanceof Error && error.name !== "URIError" && /failed OpenAPI/.test(error.message),
  );
});
