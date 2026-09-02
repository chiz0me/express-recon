"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { compareOpenApiDocuments } = require("../src/openapi-compare");

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
