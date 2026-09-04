"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { audit, buildReport, formatters, validateOpenApiDocument } = require("../src/index");
const { loadPackageInfo } = require("../src/static/resolve");

const FIXTURE = path.join(__dirname, "fixtures", "openapi-app");
const CONFIG = {
  authMiddleware: { requireAuth: "authenticated" },
  openapi: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      sessionCookie: { type: "apiKey", in: "cookie", name: "session" },
    },
    securityByTag: {
      authenticated: ["bearerAuth"],
      session: ["sessionCookie"],
    },
  },
};

function report() {
  const reg = audit({ mode: "static", src: FIXTURE }, CONFIG);
  return buildReport(reg, {
    command: "audit",
    mode: "static",
    target: loadPackageInfo(FIXTURE),
  });
}

function spec() {
  return JSON.parse(formatters.openapi.format(report()));
}

test("emits a valid OpenAPI 3.1 envelope with target info", () => {
  const doc = spec();
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.info.title, "openapi-fixture API");
  assert.equal(doc.info.version, "9.9.9");
  assert.equal(doc["x-express-recon"].schemasArePlaceholders, true);
});

test("templates Express path params and emits path parameters", () => {
  const doc = spec();
  const op = doc.paths["/items/{id}"].get;
  const idParam = op.parameters.find((p) => p.in === "path" && p.name === "id");
  assert.ok(idParam);
  assert.equal(idParam.required, true);
});

test("maps request body hints to a placeholder object schema", () => {
  const doc = spec();
  const schema = doc.paths["/items"].post.requestBody.content["application/json"].schema;
  assert.equal(schema.type, "object");
  assert.deepEqual(Object.keys(schema.properties).sort(), ["name", "price"]);
});

test("maps query hints to query parameters", () => {
  const doc = spec();
  const names = doc.paths["/items"].get.parameters
    .filter((p) => p.in === "query")
    .map((p) => p.name)
    .sort();
  assert.deepEqual(names, ["limit", "status"]);
});

test("maps response statuses and always adds a default", () => {
  const doc = spec();
  const responses = doc.paths["/items"].post.responses;
  assert.ok(responses["201"]);
  assert.ok(responses.default);
});

test("emits only explicitly mapped security schemes", () => {
  const doc = spec();
  assert.deepEqual(doc.components.securitySchemes.bearerAuth, {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
  });
  assert.deepEqual(doc.paths["/items"].post.security, [{ bearerAuth: [] }]);
  // a public route gets an explicit empty security requirement
  assert.deepEqual(doc.paths["/items"].get.security, []);
});

test("unmapped auth tags stay as audit evidence instead of becoming invented bearer schemes", () => {
  const value = report();
  delete value.openapi;
  const doc = JSON.parse(formatters.openapi.format(value));
  assert.equal(doc.components, undefined);
  assert.equal(doc.paths["/items"].post.security, undefined);
  assert.deepEqual(doc.paths["/items"].post["x-express-recon"].unmappedAuthTags, ["authenticated"]);
});

test("multiple mapped guards are conjunctive in one security requirement", () => {
  const value = report();
  const route = value.routes.find((item) => item.method === "POST" && item.path === "/items");
  route.tags.push("session");
  const doc = JSON.parse(formatters.openapi.format(value));
  assert.deepEqual(doc.paths["/items"].post.security, [{ bearerAuth: [], sessionCookie: [] }]);
});

test("prototype-like schema fields and security schemes remain ordinary data", () => {
  const value = report();
  const route = value.routes.find((item) => item.method === "POST" && item.path === "/items");
  route.io.request.body = ["__proto__"];
  value.openapi = {
    securitySchemes: Object.fromEntries([
      ["__proto__", { type: "apiKey", in: "header", name: "x-auth" }],
    ]),
    securityByTag: { authenticated: ["__proto__"] },
  };
  const doc = formatters.openapi.build(value);
  const properties =
    doc.paths["/items"].post.requestBody.content["application/json"].schema.properties;
  const requirement = doc.paths["/items"].post.security[0];
  assert.equal(Object.hasOwn(properties, "__proto__"), true);
  assert.deepEqual(properties.__proto__, {});
  assert.equal(Object.hasOwn(requirement, "__proto__"), true);
  assert.deepEqual(requirement.__proto__, []);
  assert.equal(Object.hasOwn(doc.components.securitySchemes, "__proto__"), true);
});

test("non-slash catch-all paths become valid OpenAPI path keys", () => {
  const value = report();
  const existing = value.routes.find((item) => item.method === "GET" && item.path === "/items");
  value.routes = [{ ...structuredClone(existing), path: "*" }];
  const doc = formatters.openapi.build(value);
  assert.ok(doc.paths["/{wildcard}"].get);
  assert.equal(Object.hasOwn(doc.paths, "{wildcard}"), false);
});

test("carries x-express-recon traceback metadata per operation", () => {
  const doc = spec();
  const ext = doc.paths["/items/{id}"].get["x-express-recon"];
  assert.ok(ext.source.file.endsWith("app.js"));
  assert.equal(ext.authStatus, "public");
  assert.equal(ext.handlerResolved, true);
  assert.ok(ext.handlerSource.file.endsWith("app.js"));
  assert.equal(typeof ext.handlerSource.line, "number");
  assert.equal(ext.method, "GET");
  assert.match(ext.applicationId, /^app:/);
});

test("surfaces the handler name for controller-backed operations", () => {
  const doc = spec();
  assert.equal(
    doc.paths["/members/{id}"].get["x-express-recon"].handlerName,
    "controllers.getUser",
  );
  // inline handlers report a null name
  assert.equal(doc.paths["/items"].get["x-express-recon"].handlerName, null);
});

test("expands router.all() across concrete verbs, flagged as ALL", () => {
  const doc = spec();
  const wild = doc.paths["/wild"];
  for (const verb of ["get", "post", "put", "patch", "delete", "head", "options", "trace"]) {
    assert.ok(wild[verb], `expected ${verb} on /wild`);
    assert.equal(wild[verb]["x-express-recon"].method, "ALL");
  }
});

test("duplicate operations are reported instead of disappearing silently", () => {
  const value = report();
  const existing = value.routes.find((item) => item.method === "GET" && item.path === "/items");
  value.routes.push({
    ...structuredClone(existing),
    source: { file: "/tmp/duplicate.js", line: 9 },
  });
  const doc = JSON.parse(formatters.openapi.format(value));
  assert.deepEqual(doc["x-express-recon"].duplicateOperations, [
    {
      keptApplicationId: existing.applicationId,
      droppedApplicationId: existing.applicationId,
      method: "GET",
      path: "/items",
      keptSource: existing.source,
      droppedSource: { file: "/tmp/duplicate.js", line: 9 },
    },
  ]);
});

test("operationIds are unique across the document", () => {
  const doc = spec();
  const ids = [];
  for (const item of Object.values(doc.paths))
    for (const op of Object.values(item)) ids.push(op.operationId);
  assert.equal(new Set(ids).size, ids.length);
});

test("inventory specs carry no security section", () => {
  const { inventory } = require("../src/index");
  const report = buildReport(inventory({ mode: "static", src: FIXTURE }), {
    command: "inventory",
    mode: "static",
  });
  const doc = JSON.parse(formatters.openapi.format(report));
  assert.equal(doc.components, undefined);
  assert.equal(doc.paths["/items"].get.security, undefined);
});

test("templates path parameters with extensions, prefixes, and multiple segments", () => {
  const value = report();
  value.routes.push(
    {
      method: "GET",
      path: "/reports/:id.pdf",
      middlewares: [],
      source: { file: "/tmp/report.js", line: 1 },
      pathConfidence: "full",
      authStatus: "public",
      tags: ["public"],
      roles: [],
      scopes: [],
      authEvidence: { matched: [] },
      io: { responses: [], statusCodes: [], schemas: { request: {}, responses: [] } },
    },
    {
      method: "GET",
      path: "/items/item-:itemId",
      middlewares: [],
      source: { file: "/tmp/item.js", line: 1 },
      pathConfidence: "full",
      authStatus: "public",
      tags: ["public"],
      roles: [],
      scopes: [],
      authEvidence: { matched: [] },
      io: { responses: [], statusCodes: [], schemas: { request: {}, responses: [] } },
    },
  );
  const doc = JSON.parse(formatters.openapi.format(value));
  assert.ok(doc.paths["/reports/{id}.pdf"]);
  assert.ok(doc.paths["/items/item-{itemId}"]);
  const pdfParam = doc.paths["/reports/{id}.pdf"].get.parameters.find((p) => p.name === "id");
  assert.ok(pdfParam);
  assert.equal(pdfParam.required, true);
  const itemParam = doc.paths["/items/item-{itemId}"].get.parameters.find(
    (p) => p.name === "itemId",
  );
  assert.ok(itemParam);
  assert.equal(itemParam.required, true);
});

test("formats Express 5 optional brace groups without nested braces and validates them", () => {
  const value = report();
  value.routes.push(
    {
      applicationId: "app",
      method: "GET",
      path: "/files/:file{.:ext}",
      middlewares: [],
      source: { file: "/tmp/file.js", line: 1 },
      pathConfidence: "full",
      authStatus: "public",
      tags: ["public"],
      roles: [],
      scopes: [],
      authEvidence: { matched: [] },
      io: { responses: [], statusCodes: [], schemas: { request: {}, responses: [] } },
    },
    {
      applicationId: "app",
      method: "GET",
      path: "/user{/:id}",
      middlewares: [],
      source: { file: "/tmp/user.js", line: 1 },
      pathConfidence: "full",
      authStatus: "public",
      tags: ["public"],
      roles: [],
      scopes: [],
      authEvidence: { matched: [] },
      io: { responses: [], statusCodes: [], schemas: { request: {}, responses: [] } },
    },
  );
  const doc = JSON.parse(formatters.openapi.format(value));
  assert.ok(doc.paths["/files/{file}.{ext}"]);
  assert.ok(doc.paths["/user/{id}"]);
  assert.equal(doc.paths["/files/{file}{.{ext}}"], undefined);
  const validated = validateOpenApiDocument(doc);
  assert.equal(validated.family, "3.1");

  assert.throws(
    () =>
      validateOpenApiDocument({
        openapi: "3.0.3",
        info: { title: "Bad", version: "1.0.0" },
        paths: { "/files/{file}{.{ext}}": { get: { responses: { 200: { description: "ok" } } } } },
      }),
    /nested or malformed parameter braces/,
  );

  // Missing path parameter declaration throws
  assert.throws(
    () =>
      validateOpenApiDocument({
        openapi: "3.0.3",
        info: { title: "Missing Param", version: "1.0.0" },
        paths: {
          "/users/{id}": {
            get: {
              responses: { 200: { description: "ok" } },
            },
          },
        },
      }),
    /missing required path parameter declaration for '\{id\}'/,
  );

  // Path parameter declaration not in template throws
  assert.throws(
    () =>
      validateOpenApiDocument({
        openapi: "3.0.3",
        info: { title: "Extra Param", version: "1.0.0" },
        paths: {
          "/users": {
            get: {
              parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
              responses: { 200: { description: "ok" } },
            },
          },
        },
      }),
    /declares path parameter 'id' which is not in the path template/,
  );
});

test("converts Express 5 splat, grouped pairs, and optional extension paths cleanly", () => {
  const value = report();
  value.routes.push(
    {
      applicationId: "app",
      method: "GET",
      path: "/{*splat}",
      middlewares: [],
      source: { file: "/tmp/splat.js", line: 1 },
      pathConfidence: "full",
      authStatus: "public",
      tags: ["public"],
      roles: [],
      scopes: [],
      authEvidence: { matched: [] },
      io: { responses: [], statusCodes: [], schemas: { request: {}, responses: [] } },
    },
    {
      applicationId: "app",
      method: "GET",
      path: "/pair{/:left-:right}",
      middlewares: [],
      source: { file: "/tmp/pair.js", line: 1 },
      pathConfidence: "full",
      authStatus: "public",
      tags: ["public"],
      roles: [],
      scopes: [],
      authEvidence: { matched: [] },
      io: { responses: [], statusCodes: [], schemas: { request: {}, responses: [] } },
    },
    {
      applicationId: "app",
      method: "GET",
      path: "/file/:id{.json}",
      middlewares: [],
      source: { file: "/tmp/file.js", line: 1 },
      pathConfidence: "full",
      authStatus: "public",
      tags: ["public"],
      roles: [],
      scopes: [],
      authEvidence: { matched: [] },
      io: { responses: [], statusCodes: [], schemas: { request: {}, responses: [] } },
    },
  );
  const doc = JSON.parse(formatters.openapi.format(value));
  assert.ok(doc.paths["/{splat}"]);
  assert.equal(doc.paths["/{{splat}}"], undefined);
  const splatParam = doc.paths["/{splat}"].get.parameters.find((p) => p.name === "splat");
  assert.ok(splatParam && splatParam.in === "path");

  assert.ok(doc.paths["/pair/{left}-{right}"]);
  assert.equal(doc.paths["/pair/{left}-:right"], undefined);
  const leftParam = doc.paths["/pair/{left}-{right}"].get.parameters.find((p) => p.name === "left");
  const rightParam = doc.paths["/pair/{left}-{right}"].get.parameters.find(
    (p) => p.name === "right",
  );
  assert.ok(leftParam && leftParam.in === "path");
  assert.ok(rightParam && rightParam.in === "path");

  assert.ok(doc.paths["/file/{id}.json"]);
  assert.equal(doc.paths["/file/{id}{.json}"], undefined);
  const idParam = doc.paths["/file/{id}.json"].get.parameters.find((p) => p.name === "id");
  assert.ok(idParam && idParam.in === "path");
  assert.equal(
    doc.paths["/file/{id}.json"].get.parameters.find((p) => p.name === ".json"),
    undefined,
  );

  const validated = validateOpenApiDocument(doc);
  assert.equal(validated.family, "3.1");
});

test("expands Express 5 optional groups into all path variants including nested groups", () => {
  const value = report();
  value.routes = [
    {
      applicationId: "app",
      method: "GET",
      path: "/user{/:id}",
      middlewares: [],
      source: { file: "/tmp/user.js", line: 1 },
      pathConfidence: "full",
      authStatus: "public",
      tags: ["public"],
      roles: [],
      scopes: [],
      authEvidence: { matched: [] },
      io: { responses: [], statusCodes: [], schemas: { request: {}, responses: [] } },
    },
    {
      applicationId: "app",
      method: "GET",
      path: "/{*splat}",
      middlewares: [],
      source: { file: "/tmp/splat.js", line: 1 },
      pathConfidence: "full",
      authStatus: "public",
      tags: ["public"],
      roles: [],
      scopes: [],
      authEvidence: { matched: [] },
      io: { responses: [], statusCodes: [], schemas: { request: {}, responses: [] } },
    },
    {
      applicationId: "app",
      method: "GET",
      path: "/users{/:id{.:ext}}",
      middlewares: [],
      source: { file: "/tmp/users.js", line: 1 },
      pathConfidence: "full",
      authStatus: "public",
      tags: ["public"],
      roles: [],
      scopes: [],
      authEvidence: { matched: [] },
      io: { responses: [], statusCodes: [], schemas: { request: {}, responses: [] } },
    },
  ];

  const doc = JSON.parse(formatters.openapi.format(value));

  // /user{/:id} emits both /user and /user/{id}
  assert.ok(doc.paths["/user"]);
  assert.ok(doc.paths["/user/{id}"]);
  assert.equal(
    doc.paths["/user"].get.parameters?.find((p) => p.in === "path"),
    undefined,
  );
  const userIdParam = doc.paths["/user/{id}"].get.parameters.find((p) => p.name === "id");
  assert.ok(userIdParam && userIdParam.in === "path" && userIdParam.required);

  // /{*splat} emits both / and /{splat}
  assert.ok(doc.paths["/"]);
  assert.ok(doc.paths["/{splat}"]);
  assert.equal(
    doc.paths["/"].get.parameters?.find((p) => p.in === "path"),
    undefined,
  );
  const splatParam = doc.paths["/{splat}"].get.parameters.find((p) => p.name === "splat");
  assert.ok(splatParam && splatParam.in === "path" && splatParam.required);

  // /users{/:id{.:ext}} emits /users, /users/{id}, and /users/{id}.{ext}
  assert.ok(doc.paths["/users"]);
  assert.ok(doc.paths["/users/{id}"]);
  assert.ok(doc.paths["/users/{id}.{ext}"]);
  assert.equal(
    doc.paths["/users"].get.parameters?.find((p) => p.in === "path"),
    undefined,
  );
  const nestedId = doc.paths["/users/{id}"].get.parameters.find((p) => p.name === "id");
  assert.ok(nestedId && nestedId.in === "path" && nestedId.required);
  assert.equal(
    doc.paths["/users/{id}"].get.parameters.find((p) => p.name === "ext"),
    undefined,
  );
  const nestedBothId = doc.paths["/users/{id}.{ext}"].get.parameters.find((p) => p.name === "id");
  const nestedBothExt = doc.paths["/users/{id}.{ext}"].get.parameters.find((p) => p.name === "ext");
  assert.ok(nestedBothId && nestedBothId.in === "path" && nestedBothId.required);
  assert.ok(nestedBothExt && nestedBothExt.in === "path" && nestedBothExt.required);

  const validated = validateOpenApiDocument(doc);
  assert.equal(validated.family, "3.1");
});

test("preserves escaped Express path literals and expands Express 4 optional parameters", () => {
  assert.deepEqual(formatters.openapi.toOpenApiPaths(String.raw`/literal\:name`), [
    { path: "/literal:name", params: [] },
  ]);
  assert.deepEqual(formatters.openapi.toOpenApiPaths(String.raw`/literal\{name\}`), [
    { path: "/literal%7Bname%7D", params: [] },
  ]);
  assert.deepEqual(formatters.openapi.toOpenApiPaths("/users/:id?"), [
    { path: "/users", params: [] },
    { path: "/users/{id}", params: ["id"] },
  ]);
  assert.deepEqual(formatters.openapi.toOpenApiPaths("/literal/{word}"), [
    { path: "/literal", params: [] },
    { path: "/literal/word", params: [] },
  ]);
  assert.deepEqual(formatters.openapi.toOpenApiPaths(String.raw`/asset/:id(\d+)?`), [
    { path: "/asset", params: [] },
    { path: "/asset/{id}", params: ["id"] },
  ]);
});

test("bounds optional path expansion and discloses incomplete variants", () => {
  const value = report();
  const route = structuredClone(value.routes[0]);
  route.path =
    "/bounded" + Array.from({ length: 20 }, (_unused, index) => `{/:part${index}}`).join("");
  value.routes = [route];

  const doc = formatters.openapi.build(value);
  assert.equal(Object.keys(doc.paths).length, 128);
  assert.deepEqual(doc["x-express-recon"].pathVariantTruncations, [
    {
      applicationId: route.applicationId,
      method: route.method,
      path: route.path,
      source: route.source,
      maxVariants: 128,
      reason: "variant-limit",
    },
  ]);
  assert.doesNotThrow(() => validateOpenApiDocument(doc));
});

test("bounds deeply nested optional groups without exhausting the call stack", () => {
  const value = report();
  const route = structuredClone(value.routes[0]);
  route.path = `/deep${"{".repeat(34)}/:id${"}".repeat(34)}`;
  value.routes = [route];

  const doc = formatters.openapi.build(value);
  assert.equal(
    doc["x-express-recon"].pathVariantTruncations[0].reason,
    "optional-group-depth-limit",
  );
  assert.doesNotThrow(() => validateOpenApiDocument(doc));
});
