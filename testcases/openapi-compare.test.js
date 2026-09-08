"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { compareOpenApiDocuments } = require("../src/openapi-compare");
const { validateOpenApiDocument } = require("../src/openapi-validation");

function contract() {
  return {
    openapi: "3.1.0",
    info: { title: "Comparison fixture", version: "1.0.0" },
    paths: {
      "/things/{id}": {
        get: {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: {
              description: "ok",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Thing" } },
              },
            },
          },
          "x-express-recon": { enrichmentFingerprint: "old" },
        },
      },
    },
    components: {
      schemas: {
        Thing: { type: "object", properties: { id: { type: "string" } } },
      },
    },
  };
}

test("OpenAPI comparison ignores scanner provenance and fingerprints real contract edits", () => {
  const before = contract();
  const provenanceOnly = structuredClone(before);
  provenanceOnly.paths["/things/{id}"].get["x-express-recon"].enrichmentFingerprint = "new";
  assert.equal(compareOpenApiDocuments(before, provenanceOnly).summary.changedOperations, 0);

  const after = structuredClone(before);
  after.paths["/things/{id}"].get.summary = "Get a thing";
  const delta = compareOpenApiDocuments(before, after);
  assert.equal(delta.summary.changedOperations, 1);
  assert.deepEqual(delta.changedOperations[0].changedFields, ["summary"]);
  assert.equal(delta.summary.breakingChanges, 0);
});

test("OpenAPI comparison separates definite from potential breaking changes", () => {
  const before = contract();
  const after = structuredClone(before);
  after.paths["/things/{id}"].get.parameters.push({
    name: "tenant",
    in: "header",
    required: true,
    schema: { type: "string" },
  });
  delete after.paths["/things/{id}"].get.responses[200];
  after.paths["/things/{id}"].get.responses[204] = { description: "empty" };
  after.components.schemas.Thing.required = ["id"];
  const delta = compareOpenApiDocuments(before, after);
  assert.ok(delta.breakingChanges.some((entry) => entry.kind === "required-parameter-added"));
  assert.ok(delta.breakingChanges.some((entry) => entry.kind === "response-removed"));
  assert.ok(
    delta.potentiallyBreakingChanges.some((entry) => entry.kind === "referenced-schema-changed"),
  );
});

test("OpenAPI comparison treats removal as breaking only when a baseline exists", () => {
  const initial = compareOpenApiDocuments(null, contract());
  assert.equal(initial.baselineAvailable, false);
  assert.equal(initial.summary.addedOperations, 1);
  assert.equal(initial.summary.breakingChanges, 0);

  const empty = contract();
  empty.paths = {};
  const removed = compareOpenApiDocuments(contract(), empty);
  assert.equal(removed.summary.removedOperations, 1);
  assert.ok(removed.breakingChanges.some((entry) => entry.kind === "operation-removed"));
});

test("OpenAPI comparison identifies required input and path-level contract changes", () => {
  const before = contract();
  const pathItem = before.paths["/things/{id}"];
  pathItem.parameters = [
    { name: "locale", in: "query", required: false, schema: { type: "string" } },
  ];
  pathItem.servers = [{ url: "https://api.example.test" }];
  pathItem.get.requestBody = {
    required: false,
    content: { "application/json": { schema: { type: "object" } } },
  };

  const after = structuredClone(before);
  after.paths["/things/{id}"].parameters[0].required = true;
  after.paths["/things/{id}"].servers[0].url = "https://v2.example.test";
  after.paths["/things/{id}"].get.parameters[0].schema.type = "integer";
  after.paths["/things/{id}"].get.requestBody.required = true;

  const delta = compareOpenApiDocuments(before, after);
  assert.deepEqual(delta.changedOperations[0].changedFields, [
    "parameters",
    "pathParameters",
    "pathServers",
    "requestBody",
  ]);
  assert.ok(delta.breakingChanges.some((entry) => entry.kind === "parameter-became-required"));
  assert.ok(
    delta.breakingChanges.some((entry) => entry.kind === "required-parameter-contract-changed"),
  );
  assert.ok(delta.breakingChanges.some((entry) => entry.kind === "request-body-became-required"));
});

test("OpenAPI comparison flags ambiguous optional changes and malformed encoded references", () => {
  const before = contract();
  before.paths["/things/{id}"].get.parameters.push({
    name: "filter",
    in: "query",
    schema: { type: "string" },
  });
  before.components.schemas["%E0%A4%A"] = { type: "string" };
  before.paths["/things/{id}"].get.responses[200].content["application/json"].schema = {
    $ref: "#/components/schemas/%E0%A4%A",
  };

  const after = structuredClone(before);
  after.paths["/things/{id}"].get.parameters[1].schema.type = "number";
  delete after.components.schemas["%E0%A4%A"];

  const delta = compareOpenApiDocuments(before, after);
  assert.ok(
    delta.potentiallyBreakingChanges.some((entry) => entry.kind === "operation-contract-changed"),
  );
  assert.ok(
    delta.breakingChanges.some(
      (entry) => entry.kind === "referenced-schema-removed" && entry.schema === "%E0%A4%A",
    ),
  );
});

test("OpenAPI comparison evaluates inherited security and referenced scheme contracts", () => {
  const before = contract();
  before.components.securitySchemes = {
    bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
  };
  const secured = structuredClone(before);
  secured.security = [{ bearer: [] }];
  const securedDelta = compareOpenApiDocuments(before, secured);
  assert.ok(
    securedDelta.breakingChanges.some((entry) => entry.kind === "security-requirement-added"),
  );
  assert.ok(securedDelta.changedOperations[0].changedFields.includes("security"));

  const changedScheme = structuredClone(secured);
  changedScheme.components.securitySchemes.bearer.scheme = "basic";
  const schemeDelta = compareOpenApiDocuments(secured, changedScheme);
  assert.ok(schemeDelta.changedOperations[0].changedFields.includes("securitySchemes"));
  assert.ok(
    schemeDelta.potentiallyBreakingChanges.some(
      (entry) => entry.kind === "security-scheme-changed",
    ),
  );
});

test("OpenAPI comparison applies directional request and response schema compatibility", () => {
  const before = contract();
  before.paths["/things/{id}"].get.requestBody = {
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: { mode: { type: "string", enum: ["safe", "fast"] } },
        },
      },
    },
  };
  before.components.schemas.Thing.required = ["id"];
  const after = structuredClone(before);
  after.paths["/things/{id}"].get.requestBody.content[
    "application/json"
  ].schema.properties.mode.enum = ["safe"];
  after.components.schemas.Thing.required = [];
  const delta = compareOpenApiDocuments(before, after);
  assert.ok(delta.breakingChanges.some((entry) => entry.kind === "request-schema-narrowed"));
  assert.ok(delta.breakingChanges.some((entry) => entry.kind === "response-schema-widened"));
});

test("OpenAPI comparison surfaces external reference uncertainty", () => {
  const document = contract();
  document.paths["/things/{id}"].get.parameters.push({ $ref: "./parameters.yaml#/Tenant" });
  const delta = compareOpenApiDocuments(document, structuredClone(document));
  assert.ok(
    delta.uncertainties.some(
      (entry) =>
        entry.kind === "external-reference-unresolved" &&
        entry.reference === "./parameters.yaml#/Tenant",
    ),
  );
  assert.ok(delta.summary.uncertainties > 0);
});

test("OpenAPI comparison scopes reference uncertainty to the affected operation", () => {
  const before = contract();
  before.paths["/things/{id}"].get.parameters.push({ $ref: "./parameters.yaml#/Tenant" });
  before.paths["/things/{id}"].post = { responses: { 200: { description: "ok" } } };

  const removed = structuredClone(before);
  delete removed.paths["/things/{id}"].post;
  const removedDelta = compareOpenApiDocuments(before, removed);
  assert.deepEqual(removedDelta.removedOperations, [{ method: "POST", path: "/things/{id}" }]);
  assert.ok(
    removedDelta.breakingChanges.some(
      (entry) => entry.kind === "operation-removed" && entry.operation === "POST /things/{id}",
    ),
  );
  assert.ok(
    removedDelta.uncertainties.every(
      (entry) => entry.path === undefined && entry.operation === "GET /things/{id}",
    ),
  );

  const secured = structuredClone(before);
  secured.components.securitySchemes = { bearer: { type: "http", scheme: "bearer" } };
  secured.paths["/things/{id}"].post.security = [{ bearer: [] }];
  const securedDelta = compareOpenApiDocuments(before, secured);
  assert.deepEqual(securedDelta.changedOperations[0].changedFields, [
    "security",
    "securitySchemes",
  ]);
  assert.ok(
    securedDelta.breakingChanges.some(
      (entry) =>
        entry.kind === "security-requirement-added" && entry.operation === "POST /things/{id}",
    ),
  );
});

test("OpenAPI comparison scopes uncertainty to the affected operation field", () => {
  const before = contract();
  before.paths["/things/{id}"].get.responses[200].content["application/json"].schema = {
    $ref: "./schemas.yaml#/Thing",
  };
  const after = structuredClone(before);
  after.paths["/things/{id}"].get.parameters.push({
    name: "x-key",
    in: "header",
    required: true,
    schema: { type: "string" },
  });

  const delta = compareOpenApiDocuments(before, after);
  assert.ok(
    delta.breakingChanges.some(
      (entry) =>
        entry.kind === "required-parameter-added" && entry.operation === "GET /things/{id}",
    ),
  );
  assert.ok(
    delta.uncertainties.some(
      (entry) =>
        entry.kind === "external-reference-unresolved" &&
        entry.operation === "GET /things/{id}" &&
        entry.reference === "./schemas.yaml#/Thing",
    ),
  );

  delete after.paths["/things/{id}"].get.responses[200];
  after.paths["/things/{id}"].get.responses[204] = { description: "empty" };
  const mixed = compareOpenApiDocuments(before, after);
  assert.ok(mixed.breakingChanges.some((entry) => entry.kind === "required-parameter-added"));
  assert.equal(
    mixed.breakingChanges.some((entry) => entry.kind === "response-removed"),
    false,
  );
  assert.ok(
    mixed.potentiallyBreakingChanges.some((entry) => entry.kind === "operation-contract-changed"),
  );
});

test("OpenAPI comparison preserves shallow schema reuse at different depths", () => {
  const before = contract();
  before.components.schemas.Base = {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  };
  before.paths["/things/{id}"].get.responses[200].content["application/json"].schema = {
    type: "object",
    properties: {
      direct: { $ref: "#/components/schemas/Base" },
      nested: {
        type: "object",
        properties: {
          value: { $ref: "#/components/schemas/Base", description: "nested use" },
        },
      },
    },
  };
  before.paths["/things/{id}"].get.responses[204] = { description: "empty" };
  const after = structuredClone(before);
  delete after.paths["/things/{id}"].get.responses[204];
  validateOpenApiDocument(before);
  validateOpenApiDocument(after);

  const delta = compareOpenApiDocuments(before, after);
  assert.ok(delta.breakingChanges.some((entry) => entry.kind === "response-removed"));
  assert.equal(delta.summary.uncertainties, 0);
});

function cachedUncertainReferenceDocument(reference, parametersFirst) {
  const parameters = [{ $ref: "#/components/parameters/Key" }];
  const responses = {
    200: {
      description: "ok",
      content: {
        "application/json": {
          schema: { $ref: "#/components/parameters/Key/schema" },
        },
      },
    },
  };
  return {
    openapi: "3.1.0",
    info: { title: "Cached uncertainty fixture", version: "1" },
    components: {
      parameters: {
        Key: {
          name: "x-key",
          in: "header",
          required: true,
          schema: { $ref: reference },
        },
      },
    },
    paths: {
      "/cache": {
        get: parametersFirst ? { parameters, responses } : { responses, parameters },
      },
    },
  };
}

test("OpenAPI comparison propagates cached uncertainty independent of field order", () => {
  for (const parametersFirst of [false, true]) {
    const before = cachedUncertainReferenceDocument("./schemas.yaml#/Before", parametersFirst);
    const after = cachedUncertainReferenceDocument("./schemas.yaml#/After", parametersFirst);
    validateOpenApiDocument(before);
    validateOpenApiDocument(after);

    const delta = compareOpenApiDocuments(before, after);
    assert.equal(delta.summary.breakingChanges, 0);
    assert.ok(
      delta.potentiallyBreakingChanges.some((entry) => entry.kind === "operation-contract-changed"),
    );
    assert.equal(
      delta.uncertainties.some((entry) => entry.kind === "reference-expansion-limited"),
      false,
    );
  }
});

test("recursive reference fingerprints ignore object key insertion order", () => {
  const before = contract();
  before.components.schemas.A = {
    type: "object",
    properties: { b: { $ref: "#/components/schemas/B" } },
  };
  before.components.schemas.B = {
    type: "object",
    properties: { a: { $ref: "#/components/schemas/A" } },
  };
  const schema = {
    type: "object",
    properties: {
      a: { $ref: "#/components/schemas/A" },
      b: { $ref: "#/components/schemas/B" },
    },
  };
  before.paths["/things/{id}"].get.responses[200].content["application/json"].schema = schema;
  function reverseKeys(value) {
    if (Array.isArray(value)) return value.map(reverseKeys);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseKeys(child)]),
    );
  }
  const after = reverseKeys(before);
  validateOpenApiDocument(before);
  validateOpenApiDocument(after);
  const delta = compareOpenApiDocuments(before, after);
  assert.equal(delta.summary.changedOperations, 0);
  assert.equal(delta.summary.changedSchemas, 0);
  assert.equal(delta.summary.uncertainties, 0);
});

test("required parameter edits use request-direction compatibility", () => {
  for (const useContent of [false, true]) {
    const before = contract();
    const parameter = { name: "mode", in: "query", required: true };
    const schema = { type: "string", enum: ["safe", "fast"] };
    if (useContent) parameter.content = { "application/json": { schema } };
    else parameter.schema = schema;
    before.paths["/things/{id}"].parameters = [parameter];
    for (const [edit, definite] of [
      [(value) => value.enum.push("new"), false],
      [
        (value) => {
          value.description = "Clarified documentation";
        },
        false,
      ],
      [
        (value) => {
          value.required = ["ignoredForStrings"];
          value.additionalProperties = false;
        },
        false,
      ],
      [
        (value) => {
          value.enum = ["safe"];
        },
        true,
      ],
    ]) {
      const after = structuredClone(before);
      const changed = after.paths["/things/{id}"].parameters[0];
      edit(useContent ? changed.content["application/json"].schema : changed.schema);
      validateOpenApiDocument(before);
      validateOpenApiDocument(after);
      const delta = compareOpenApiDocuments(before, after);
      assert.equal(
        delta.breakingChanges.some((entry) => entry.kind === "required-parameter-contract-changed"),
        definite,
      );
      assert.equal(delta.summary.changedOperations, 1);
      if (!definite) assert.ok(delta.summary.potentiallyBreakingChanges > 0);
    }
  }
});

test("numeric subtype compatibility respects request and response direction", () => {
  for (const [beforeType, afterType, requestBreak, responseBreak] of [
    ["integer", "number", false, true],
    ["number", "integer", true, false],
  ]) {
    const before = contract();
    before.paths["/things/{id}"].get.parameters[0].schema = { type: beforeType };
    before.paths["/things/{id}"].get.responses[200].content["application/json"].schema = {
      type: beforeType,
    };
    const after = structuredClone(before);
    after.paths["/things/{id}"].get.parameters[0].schema.type = afterType;
    after.paths["/things/{id}"].get.responses[200].content["application/json"].schema.type =
      afterType;
    const delta = compareOpenApiDocuments(before, after);
    assert.equal(
      delta.breakingChanges.some((entry) => entry.kind === "required-parameter-contract-changed"),
      requestBreak,
    );
    assert.equal(
      delta.breakingChanges.some((entry) => entry.kind === "response-schema-widened"),
      responseBreak,
    );
  }
});

test("security comparison distinguishes anonymous alternatives from required authentication", () => {
  const before = contract();
  before.components.securitySchemes = { bearer: { type: "http", scheme: "bearer" } };
  for (const security of [[{}], [{}, { bearer: [] }]]) {
    const optional = structuredClone(before);
    optional.security = security;
    validateOpenApiDocument(optional);
    assert.equal(compareOpenApiDocuments(before, optional).summary.breakingChanges, 0);

    const required = structuredClone(optional);
    required.security = [{ bearer: [] }];
    assert.ok(
      compareOpenApiDocuments(optional, required).breakingChanges.some(
        (entry) => entry.kind === "security-requirement-added",
      ),
    );

    const override = structuredClone(required);
    override.paths["/things/{id}"].get.security = security;
    assert.equal(compareOpenApiDocuments(required, override).summary.breakingChanges, 0);
  }
});

function repeatedReferenceDocument(depth) {
  const schemas = { Leaf: { type: "string" } };
  for (let index = 0; index < depth; index++) {
    const child = index === 0 ? "Leaf" : `Node${index - 1}`;
    schemas[`Node${index}`] = {
      type: "object",
      properties: {
        left: { $ref: `#/components/schemas/${child}` },
        right: { $ref: `#/components/schemas/${child}` },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Reference budget fixture", version: "1" },
    components: { schemas },
    paths: {
      "/tree": {
        get: {
          responses: {
            200: {
              description: "ok",
              content: {
                "application/json": {
                  schema: { $ref: `#/components/schemas/Node${depth - 1}` },
                },
              },
            },
          },
        },
      },
    },
  };
}

test("OpenAPI comparison handles repeated non-cyclic references without exponential expansion", () => {
  const document = repeatedReferenceDocument(24);
  const delta = compareOpenApiDocuments(document, structuredClone(document));
  assert.equal(delta.summary.changedOperations, 0);
  assert.equal(delta.summary.uncertainties, 0);
});

function cachedReferenceGraphDocument(depth) {
  const schemas = { N0: { type: "string" } };
  for (let index = 1; index <= depth; index++) {
    schemas[`N${index}`] = {
      type: "object",
      properties: { child: { $ref: `#/components/schemas/N${index - 1}` } },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Cached reference graph fixture", version: "1" },
    components: { schemas },
    paths: {
      "/graph": {
        get: {
          responses: {
            200: {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      z: {
                        allOf: Array.from({ length: depth + 1 }, (_, index) => ({
                          $ref: `#/components/schemas/N${index}`,
                        })),
                      },
                      a: { $ref: `#/components/schemas/N${depth}` },
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
}

test("OpenAPI comparison bounds deep graphs assembled from cached references", () => {
  const document = cachedReferenceGraphDocument(1_800);
  validateOpenApiDocument(document);

  const delta = compareOpenApiDocuments(document, structuredClone(document));
  assert.equal(delta.summary.changedOperations, 0);
  assert.equal(delta.summary.breakingChanges, 0);
  assert.ok(
    delta.uncertainties.some(
      (entry) => entry.kind === "reference-expansion-limited" && entry.limit === "depth",
    ),
  );
});

test("OpenAPI comparison reports uncertainty when reference expansion reaches its depth limit", () => {
  const document = repeatedReferenceDocument(300);
  const delta = compareOpenApiDocuments(document, structuredClone(document));
  assert.ok(
    delta.uncertainties.some(
      (entry) => entry.kind === "reference-expansion-limited" && entry.limit === "depth",
    ),
  );
});

test("OpenAPI comparison bounds oversized reference containers and reports node uncertainty", () => {
  const document = contract();
  document.paths["/things/{id}"].get.parameters = Array.from({ length: 50_001 });
  const delta = compareOpenApiDocuments(document, document);
  assert.equal(delta.summary.changedOperations, 0);
  assert.ok(
    delta.uncertainties.some(
      (entry) => entry.kind === "reference-expansion-limited" && entry.limit === "nodes",
    ),
  );
});

test("OpenAPI comparison does not infer removals from a truncated path-item reference", () => {
  const before = contract();
  const after = structuredClone(before);
  const pathItem = after.paths["/things/{id}"];
  after.components.pathItems = {};
  for (let index = 0; index < 300; index++) {
    after.components.pathItems[`Path${index}`] =
      index === 299 ? pathItem : { $ref: `#/components/pathItems/Path${index + 1}` };
  }
  after.paths["/things/{id}"] = { $ref: "#/components/pathItems/Path0" };

  const delta = compareOpenApiDocuments(before, after);
  assert.equal(delta.summary.removedOperations, 0);
  assert.equal(delta.summary.breakingChanges, 0);
  assert.ok(
    delta.uncertainties.some(
      (entry) =>
        entry.kind === "reference-expansion-limited" &&
        entry.side === "current" &&
        entry.path === "/things/{id}" &&
        entry.limit === "depth",
    ),
  );
});

test("OpenAPI comparison does not infer removals from an unresolved path-item reference", () => {
  const before = contract();
  const after = structuredClone(before);
  after.paths["/things/{id}"] = { $ref: "./paths.yaml#/Thing" };

  const delta = compareOpenApiDocuments(before, after);
  assert.equal(delta.summary.removedOperations, 0);
  assert.equal(delta.summary.breakingChanges, 0);
  assert.ok(
    delta.uncertainties.some(
      (entry) =>
        entry.kind === "external-reference-unresolved" &&
        entry.side === "current" &&
        entry.path === "/things/{id}" &&
        entry.reference === "./paths.yaml#/Thing",
    ),
  );
});

test("OpenAPI comparison treats circular path-item references as uncertainty", () => {
  const before = contract();
  const after = structuredClone(before);
  after.components.pathItems = { Loop: { $ref: "#/components/pathItems/Loop" } };
  after.paths["/things/{id}"] = { $ref: "#/components/pathItems/Loop" };
  validateOpenApiDocument(after);

  const delta = compareOpenApiDocuments(before, after);
  assert.equal(delta.summary.removedOperations, 0);
  assert.equal(delta.summary.breakingChanges, 0);
  assert.ok(
    delta.uncertainties.some(
      (entry) =>
        entry.kind === "local-reference-unresolved" &&
        entry.side === "current" &&
        entry.path === "/things/{id}" &&
        entry.reference === "#/components/pathItems/Loop",
    ),
  );
});

test("OpenAPI comparison does not infer response removals from node-limited contracts", () => {
  const before = contract();
  const after = structuredClone(before);
  after.paths["/things/{id}"].get.parameters.push(
    ...Array.from({ length: 8_000 }, (_, index) => ({
      name: `optional-${index}`,
      in: "query",
      schema: { type: "string" },
    })),
  );

  const delta = compareOpenApiDocuments(before, after);
  assert.ok(
    delta.uncertainties.some(
      (entry) => entry.kind === "reference-expansion-limited" && entry.limit === "nodes",
    ),
  );
  assert.equal(
    delta.breakingChanges.some((entry) => entry.kind === "response-removed"),
    false,
  );
  assert.equal(delta.summary.breakingChanges, 0);
  assert.ok(
    delta.potentiallyBreakingChanges.some((entry) => entry.kind === "operation-contract-changed"),
  );
});

test("OpenAPI comparison preserves prototype-like JSON schema property names", () => {
  const before = contract();
  before.paths["/things/{id}"].get.responses[200].content["application/json"].schema = JSON.parse(
    '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
  );
  const after = structuredClone(before);
  after.paths["/things/{id}"].get.responses[200].content[
    "application/json"
  ].schema.properties.__proto__.type = "number";

  const delta = compareOpenApiDocuments(before, after);
  assert.equal(delta.summary.changedOperations, 1);
  assert.ok(delta.changedOperations[0].changedFields.includes("responses"));
  assert.ok(delta.breakingChanges.some((entry) => entry.kind === "response-schema-widened"));
});

function deeplyNestedSchema(depth) {
  let schema = { type: "string" };
  for (let index = 0; index < depth; index++) schema = { type: "array", items: schema };
  return schema;
}

function deeplyNestedRequiredSchema(depth) {
  let schema = { type: "string" };
  for (let index = 0; index < depth; index++) {
    schema = {
      type: "object",
      required: ["child"],
      properties: { child: schema },
    };
  }
  return schema;
}

test("OpenAPI comparison safely evaluates changes beside a truncated schema", () => {
  const before = contract();
  before.paths["/things/{id}"].get.responses[200].content["application/json"].schema =
    deeplyNestedRequiredSchema(300);
  const after = contract();
  after.paths["/things/{id}"].get.responses[200].content["application/json"].schema =
    deeplyNestedRequiredSchema(300);
  after.paths["/things/{id}"].get.summary = "Updated summary";
  validateOpenApiDocument(before);
  validateOpenApiDocument(after);

  const delta = compareOpenApiDocuments(before, after);
  assert.deepEqual(delta.changedOperations[0].changedFields, ["summary"]);
  assert.equal(delta.summary.breakingChanges, 0);
  assert.ok(delta.summary.uncertainties > 0);
});

test("OpenAPI comparison bounds deeply nested valid schema traversal", () => {
  const inline = contract();
  inline.paths["/things/{id}"].get.responses[200].content["application/json"].schema =
    deeplyNestedSchema(2_200);
  const component = contract();
  component.components.schemas.Deep = deeplyNestedSchema(2_200);
  const pathServer = contract();
  pathServer.paths["/things/{id}"].servers = [
    { url: "https://api.example.test", "x-deep": deeplyNestedSchema(2_200) },
  ];

  for (const document of [inline, component, pathServer]) {
    validateOpenApiDocument(document);
    const delta = compareOpenApiDocuments(document, document);
    assert.equal(delta.summary.changedOperations, 0);
    assert.equal(delta.summary.changedSchemas, 0);
    assert.equal(delta.summary.breakingChanges, 0);
    assert.ok(delta.summary.uncertainties > 0);
  }
});
