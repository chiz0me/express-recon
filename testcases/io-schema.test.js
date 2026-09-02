"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const {
  buildReport,
  formatters,
  inventory,
  reconcileDocumentation,
  REPORT_SCHEMA,
} = require("../src");
const { parse, walk } = require("../src/static/ast");
const {
  addInferredSchemas,
  addRequestSchema,
  addResponseSchema,
  contract,
  evidence,
  mergeSchemas,
  schemaFromExpression,
  staticValue,
} = require("../src/static/schema-evidence");

function temporaryRepository(files, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-io-schema-"));
  try {
    for (const [relative, contents] of Object.entries(files)) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
    }
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function reportFor(root) {
  return buildReport(inventory({ mode: "static", src: root }), {
    command: "inventory",
    mode: "static",
    sourceRoot: root,
  });
}

function validateReport(report) {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(REPORT_SCHEMA);
  assert.equal(validate(report), true, JSON.stringify(validate.errors));
}

function constBindings(program) {
  const output = new Map();
  walk(program, (node) => {
    if (node.type !== "VariableDeclaration" || node.kind !== "const") return;
    for (const declaration of node.declarations) {
      if (declaration.id.type === "Identifier" && declaration.init) {
        output.set(declaration.id.name, declaration.init);
      }
    }
  });
  return output;
}

test("bounded schema primitives interpret data and retain evidence conflicts", () => {
  const program = parse(
    [
      "const base = { enabled: true };",
      'const config = Object.freeze({ ...base, ["negative"]: -2, list: [true, , null], text: `v${"1"}`, skipped: unknown });',
      "const sealed = Object.seal({ count: 2 });",
      "const invalidArray = [unknown];",
      "const invalidSpread = { ...1 };",
      "const dynamicKey = { [unknown]: true };",
      "const cycle = cycle;",
      "const returned = { integer: 1, decimal: 1.5, nil: null, nested: { ok: true } };",
      'const choices = flag ? { left: 1 } : { right: "yes" };',
      'const mixed = [1, "two"];',
      'const textValue = "x" + value;',
      "const unknownPlus = left + right;",
      "const numericValue = 1 * value;",
      "const comparison = value >= 1;",
      'const logical = value || "fallback";',
      "const negated = !value;",
      "const asString = String(value);",
      "const asNumber = Number(value);",
      "const asBoolean = Boolean(value);",
      "const asDate = new Date();",
      "const unsupported = factory();",
    ].join("\n"),
    "schema-primitives.js",
  );
  const bindings = constBindings(program);
  const options = { bindings, partialObjects: true };
  assert.deepEqual(staticValue(bindings.get("config"), options), {
    enabled: true,
    negative: -2,
    list: [true, null, null],
    text: "v1",
  });
  assert.deepEqual(staticValue(bindings.get("sealed"), options), { count: 2 });
  assert.equal(staticValue(bindings.get("invalidArray"), options), undefined);
  assert.equal(staticValue(bindings.get("invalidSpread"), options), undefined);
  assert.equal(staticValue(bindings.get("dynamicKey"), options), undefined);
  assert.equal(staticValue(bindings.get("cycle"), options), undefined);
  assert.equal(staticValue(bindings.get("unsupported"), options), undefined);
  assert.equal(
    staticValue(bindings.get("base"), options, { depth: 17, nodes: 0, seen: new Set() }),
    undefined,
  );

  const returned = schemaFromExpression(bindings.get("returned"), options);
  assert.equal(returned.properties.integer.type, "integer");
  assert.equal(returned.properties.decimal.type, "number");
  assert.equal(returned.properties.nil.type, "null");
  assert.deepEqual(returned.required, ["integer", "decimal", "nil", "nested"]);
  assert.equal(schemaFromExpression(bindings.get("choices"), options).anyOf.length, 2);
  assert.equal(schemaFromExpression(bindings.get("mixed"), options).items.anyOf.length, 2);
  assert.equal(schemaFromExpression(bindings.get("textValue"), options).type, "string");
  assert.deepEqual(schemaFromExpression(bindings.get("unknownPlus"), options), {});
  assert.equal(schemaFromExpression(bindings.get("numericValue"), options).type, "number");
  assert.equal(schemaFromExpression(bindings.get("comparison"), options).type, "boolean");
  assert.equal(schemaFromExpression(bindings.get("logical"), options).anyOf.length, 2);
  assert.equal(schemaFromExpression(bindings.get("negated"), options).type, "boolean");
  assert.equal(schemaFromExpression(bindings.get("asString"), options).type, "string");
  assert.equal(schemaFromExpression(bindings.get("asNumber"), options).type, "number");
  assert.equal(schemaFromExpression(bindings.get("asBoolean"), options).type, "boolean");
  assert.equal(schemaFromExpression(bindings.get("asDate"), options).format, "date-time");
  assert.deepEqual(schemaFromExpression(bindings.get("cycle"), options), {});

  const io = {
    request: { body: ["observed"], query: [], params: [], headers: [] },
    responses: [],
    statusCodes: [],
  };
  addInferredSchemas(io, { file: "handler.js", line: 1 });
  addRequestSchema(
    io,
    "body",
    contract(
      {
        type: "object",
        properties: { declared: { type: "string", minLength: 1 } },
        required: ["declared"],
      },
      evidence("fastify-schema", "high", { file: "routes.js", line: 2 }),
    ),
  );
  addRequestSchema(
    io,
    "body",
    contract(
      { type: "object", properties: { declared: { type: "number" } } },
      evidence("fastify-schema", "high", { file: "routes.js", line: 3 }),
    ),
  );
  addRequestSchema(
    io,
    "body",
    contract(
      {
        type: "object",
        properties: { declared: { type: "string", minLength: 2 } },
        required: ["declared"],
      },
      evidence("fastify-schema", "high", { file: "routes.js", line: 4 }),
    ),
  );
  addResponseSchema(
    io,
    202,
    contract(
      { type: "object", properties: { accepted: { type: "boolean" } } },
      evidence("response-literal", "medium", { file: "handler.js", line: 4 }),
    ),
  );
  assert.deepEqual(io.request.body, ["declared", "observed"]);
  assert.equal(io.schemas.request.body.schema.properties.declared.type, "string");
  assert.ok(io.schemas.conflicts.some((item) => item.kind === "field-not-described"));
  assert.ok(io.schemas.conflicts.some((item) => item.kind === "type-mismatch"));
  assert.ok(io.schemas.conflicts.some((item) => item.kind === "requiredness-mismatch"));
  assert.ok(io.schemas.conflicts.some((item) => item.kind === "constraint-mismatch"));
  assert.deepEqual(io.responses, [{ status: 202, bodyKeys: ["accepted"] }]);
  assert.deepEqual(io.statusCodes, [202]);

  const target = {
    request: { body: [], query: [], params: [], headers: [] },
    responses: [],
    statusCodes: [],
  };
  mergeSchemas(target, io);
  assert.equal(target.schemas.responses[0].status, 202);
  assert.equal(target.schemas.conflicts.length, io.schemas.conflicts.length);
});

test("Express schemas combine express-validator, Zod, Joi, and response literals", () =>
  temporaryRepository(
    {
      "package.json": JSON.stringify({
        name: "validator-service",
        dependencies: { express: "^5", "express-validator": "^7", joi: "^18", zod: "^4" },
      }),
      "app.js": `
        const express = require("express");
        const { body, checkSchema, param, query } = require("express-validator");
        const { z } = require("zod");
        const Joi = require("joi");
        const app = express();
        const bodySchema = z.object({
          name: z.string().min(2),
          age: z.number().int().optional(),
        });
        const filterSchema = Joi.object({
          sort: Joi.string().valid("asc", "desc").required(),
          cursor: Joi.string(),
        });
        const headerSchema = z.object({
          tags: z.string().array().min(1).max(3),
          requestId: z.string().uuid(),
          callback: z.string().url(),
          sentAt: z.string().datetime(),
          exact: z.literal("fixed"),
          kind: z.enum(["one", "two"]),
          enabled: z.boolean().nullable().default(true),
          pair: z.array(z.number()).length(2),
          custom: z.string().refine(() => true),
        });
        const pathSchema = Joi.object({
          version: Joi.number().integer().min(1).max(5).required(),
          parts: Joi.array().items(Joi.string()).length(2),
          opaque: Joi.any().allow(null),
        });
        app.post(
          "/users/:id",
          param("id").isUUID(),
          body("email").isEmail().notEmpty(),
          body("contacts.*.email").isEmail(),
          query("limit").optional().isInt({ min: 1, max: 100 }),
          checkSchema({
            profile: { in: ["body"], optional: true, isString: true, isLength: { options: { min: 3 } } },
            mode: { in: ["query"], isIn: { options: [["active", "archived"]] } },
          }),
          (req, res) => {
            bodySchema.parse(req.body);
            filterSchema.validate(req.query);
            headerSchema.safeParse(req.headers);
            pathSchema.validateAsync(req.params);
            res.status(201).json({ id: "created", count: 1, active: true });
          },
        );
      `,
    },
    (root) => {
      const report = reportFor(root);
      validateReport(report);
      const route = report.routes[0];
      const body = route.io.schemas.request.body;
      assert.deepEqual(Object.keys(body.schema.properties).sort(), [
        "age",
        "contacts",
        "email",
        "name",
        "profile",
      ]);
      assert.deepEqual(body.schema.required, ["contacts", "email", "name"]);
      assert.equal(body.schema.properties.profile.minLength, 3);
      assert.equal(body.schema.properties.contacts.type, "array");
      assert.equal(body.schema.properties.contacts.items.properties.email.format, "email");
      assert.deepEqual([...new Set(body.evidence.map((item) => item.kind))].sort(), [
        "express-validator",
        "zod",
      ]);
      const querySchema = route.io.schemas.request.query.schema;
      assert.deepEqual(Object.keys(querySchema.properties).sort(), [
        "cursor",
        "limit",
        "mode",
        "sort",
      ]);
      assert.deepEqual(querySchema.required, ["mode", "sort"]);
      assert.deepEqual(querySchema.properties.mode.enum, ["active", "archived"]);
      assert.equal(querySchema.properties.limit.type, "integer");
      assert.equal(querySchema.properties.limit.minimum, 1);
      assert.equal(querySchema.properties.limit.maximum, 100);
      assert.equal(route.io.schemas.request.params.schema.properties.id.format, "uuid");
      const headers = route.io.schemas.request.headers.schema.properties;
      assert.equal(headers.tags.type, "array");
      assert.equal(headers.tags.minItems, 1);
      assert.equal(headers.requestId.format, "uuid");
      assert.equal(headers.callback.format, "uri");
      assert.equal(headers.sentAt.format, "date-time");
      assert.equal(headers.exact.const, "fixed");
      assert.deepEqual(headers.kind.enum, ["one", "two"]);
      assert.deepEqual(headers.enabled.type, ["boolean", "null"]);
      assert.equal(headers.enabled.default, true);
      assert.equal(headers.pair.minItems, 2);
      assert.equal(headers.custom.type, "string");
      assert.equal(route.io.schemas.request.headers.evidence[0].confidence, "medium");
      const params = route.io.schemas.request.params.schema.properties;
      assert.equal(params.version.type, "integer");
      assert.equal(params.version.minimum, 1);
      assert.equal(params.parts.items.type, "string");
      assert.equal(params.parts.minItems, 2);
      assert.deepEqual(params.opaque.anyOf, [{}, { type: "null" }]);
      assert.deepEqual(route.io.schemas.conflicts, []);

      const response = route.io.schemas.responses.find((item) => item.status === 201);
      assert.equal(response.contract.schema.properties.count.type, "integer");
      assert.equal(response.contract.schema.properties.active.type, "boolean");

      const openapi = formatters.openapi.build(report);
      const operation = openapi.paths["/users/{id}"].post;
      assert.equal(
        operation.requestBody.content["application/json"].schema.properties.email.format,
        "email",
      );
      assert.equal(operation.parameters.find((item) => item.name === "id").schema.format, "uuid");
      assert.equal(operation.parameters.find((item) => item.name === "sort").required, true);
      assert.equal(operation["x-express-recon"].schemaEvidence.length, 5);
    },
  ));

test("Express TypeScript generics and ordinary handler JSDoc enrich OpenAPI conservatively", () =>
  temporaryRepository(
    {
      "package.json": JSON.stringify({
        name: "typed-handler-service",
        dependencies: { express: "^5" },
      }),
      "app.ts": `
        import express, { Request, Response, RequestHandler } from "express";
        interface Params { id: string }
        type Body = { name: string; age?: number };
        type Reply = { ok: boolean; id: string };
        type Query = { limit?: number };
        const app = express();
        const typed: RequestHandler<Params, Reply, Body, Query> = (req, res) => {
          res.status(201).json({ ok: true, id: req.params.id });
        };
        /**
         * Read a documented thing.
         * Includes authored handler details.
         * @param {string} req.params.slug - Stable slug.
         * @param {number} [req.query.limit] - Maximum rows.
         * @param {Array.<String>} [req.query.tags] - Optional tags.
         * @param {...String} [req.query.labels] - Variadic labels.
         * @param {?Boolean} [req.query.enabled] - Nullable feature switch.
         * @param {Object.<string, Number>} req.body.scores - Scores by key.
         * @returns {Promise<{ok: boolean, value?: string}>} Documented result.
         */
        async function documented(req: Request, res: Response) {
          res.json({ ok: true });
        }
        app.post("/things/:id", typed);
        app.get("/docs/:slug", documented);
        export default app;
      `,
    },
    (root) => {
      const report = reportFor(root);
      validateReport(report);
      const typed = report.routes.find((route) => route.path === "/things/:id");
      assert.equal(
        typed.io.schemas.request.params.schema.properties.id.type,
        "string",
        JSON.stringify(typed.io, null, 2),
      );
      assert.equal(typed.io.schemas.request.body.schema.properties.name.type, "string");
      assert.deepEqual(typed.io.schemas.request.body.schema.required, ["name"]);
      assert.equal(typed.io.schemas.request.query.schema.properties.limit.type, "number");
      assert.equal(typed.io.schemas.responses[0].status, 201);
      assert.deepEqual(typed.io.schemas.responses[0].contract.schema.required, ["ok", "id"]);
      assert.ok(
        typed.io.schemas.responses[0].contract.evidence.some((item) => item.kind === "typescript"),
      );

      const documented = report.routes.find((route) => route.path === "/docs/:slug");
      assert.equal(documented.io.documentation.summary, "Read a documented thing.");
      assert.match(documented.io.documentation.description, /authored handler details/);
      assert.equal(
        documented.io.schemas.request.params.schema.properties.slug.description,
        "Stable slug.",
      );
      assert.deepEqual(documented.io.schemas.request.query.schema.required, undefined);
      assert.equal(documented.io.schemas.request.query.schema.properties.tags.items.type, "string");
      assert.equal(
        documented.io.schemas.request.query.schema.properties.labels.items.type,
        "string",
      );
      assert.deepEqual(documented.io.schemas.request.query.schema.properties.enabled.anyOf, [
        { type: "boolean" },
        { type: "null" },
      ]);
      assert.equal(
        documented.io.schemas.request.body.schema.properties.scores.additionalProperties.type,
        "number",
      );
      assert.equal(
        documented.io.schemas.responses[0].contract.schema.properties.ok.type,
        "boolean",
      );
      assert.equal(
        documented.io.schemas.responses[0].contract.schema.description,
        "Documented result.",
      );

      const openapi = formatters.openapi.build(report);
      const typedOperation = openapi.paths["/things/{id}"].post;
      assert.equal(
        typedOperation.requestBody.content["application/json"].schema.required[0],
        "name",
      );
      assert.equal(
        typedOperation.responses["201"].content["application/json"].schema.properties.id.type,
        "string",
      );
      const documentedOperation = openapi.paths["/docs/{slug}"].get;
      assert.equal(documentedOperation.summary, "Read a documented thing.");
      assert.match(documentedOperation.description, /authored handler details/);
      assert.equal(
        documentedOperation.parameters.find((item) => item.name === "slug").description,
        "Stable slug.",
      );
      assert.equal(documentedOperation.responses["200"].description, "Documented result.");
    },
  ));

test("handler-local schema bindings stay isolated by lexical function", () =>
  temporaryRepository(
    {
      "package.json": JSON.stringify({
        name: "scoped-validator-service",
        dependencies: { express: "^5", zod: "^4" },
      }),
      "app.js": `
        const express = require("express");
        const { z } = require("zod");
        const app = express();
        app.post("/first", (req, res) => {
          const schema = z.object({ first: z.string() });
          const result = { accepted: req.body.first === "yes" };
          schema.parse(req.body);
          res.json(result);
        });
        app.post("/second", (req, res) => {
          const schema = z.object({ second: z.number() });
          schema.parse(req.body);
          res.json({ second: true });
        });
      `,
    },
    (root) => {
      const report = reportFor(root);
      validateReport(report);
      const first = report.routes.find((route) => route.path === "/first");
      const second = report.routes.find((route) => route.path === "/second");
      assert.deepEqual(Object.keys(first.io.schemas.request.body.schema.properties), ["first"]);
      assert.deepEqual(Object.keys(second.io.schemas.request.body.schema.properties), ["second"]);
      const response = first.io.schemas.responses.find((item) => item.status === 200);
      assert.equal(response.contract.schema.properties.accepted.type, "boolean");
    },
  ));

test("Fastify route schemas outrank handler reads and expose drift", () =>
  temporaryRepository(
    {
      "package.json": JSON.stringify({
        name: "fastify-schema-service",
        dependencies: { fastify: "^5" },
      }),
      "app.js": `
        const Fastify = require("fastify");
        const app = Fastify();
        app.post("/users", {
          schema: {
            body: {
              type: "object",
              additionalProperties: false,
              required: ["name"],
              properties: { name: { type: "string", minLength: 2 } },
            },
            response: {
              201: {
                type: "object",
                required: ["id"],
                properties: { id: { type: "integer" } },
              },
            },
          },
        }, (request, reply) => reply.code(201).send({ id: request.body.legacy }));
      `,
    },
    (root) => {
      const report = reportFor(root);
      validateReport(report);
      const route = report.routes[0];
      assert.deepEqual(Object.keys(route.io.schemas.request.body.schema.properties), ["name"]);
      assert.ok(
        route.io.schemas.conflicts.some(
          (item) => item.kind === "field-not-described" && item.location === "request.body.legacy",
        ),
      );
      const response = route.io.schemas.responses.find((item) => item.status === 201);
      assert.equal(response.contract.schema.properties.id.type, "integer");

      const operation = formatters.openapi.build(report).paths["/users"].post;
      const generated = operation.requestBody.content["application/json"].schema;
      assert.deepEqual(Object.keys(generated.properties), ["name"]);
      assert.equal(generated["x-express-recon-unrefined"], undefined);
      assert.equal(operation["x-express-recon"].schemaConflicts.length, 1);
      const reconciliation = reconcileDocumentation(report, { root });
      assert.equal(reconciliation.report.summary.schemaConflicts, 1);
      assert.equal(reconciliation.report.summary.conflicts, 1);
      assert.equal(reconciliation.report.schemaConflicts[0].operation, "POST /users");
    },
  ));

test("NestJS resolves imported DTO types and class-validator constraints", () =>
  temporaryRepository(
    {
      "package.json": JSON.stringify({
        name: "nest-dto-service",
        dependencies: {
          "@nestjs/common": "^11",
          "@nestjs/core": "^11",
          "@nestjs/swagger": "^11",
          "class-validator": "^0.14",
        },
      }),
      "create-user.dto.ts": `
        import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
        import {
          ArrayMaxSize,
          ArrayMinSize,
          IsArray,
          IsDateString,
          IsDefined,
          IsEmail,
          IsIn,
          IsInt,
          IsOptional,
          IsString,
          IsUrl,
          IsUUID,
          Length,
          Matches,
          Max,
          MaxLength,
          Min,
          MinLength,
        } from "class-validator";

        class AddressDto {
          @IsString()
          city!: string;
        }

        export class CreateUserDto {
          @IsEmail()
          email!: string;

          @IsOptional()
          @IsInt()
          @Min(18)
          age?: number;

          @IsUUID()
          id!: string;

          @IsUrl()
          website!: string;

          @IsDateString()
          createdAt!: Date;

          @Length(2, 20)
          username!: string;

          @MinLength(1)
          @MaxLength(8)
          nickname!: string;

          @IsInt()
          @Max(99)
          score!: number;

          @IsArray()
          @ArrayMinSize(1)
          @ArrayMaxSize(3)
          tags!: string[];

          @IsIn(["admin", "member"])
          role!: "admin" | "member";

          @Matches(/^usr_/)
          code!: string;

          @ApiProperty({
            description: "Account state",
            enum: ["enabled", "disabled"],
            nullable: true,
          })
          state!: string;

          @ApiPropertyOptional({ example: "public" })
          alias?: string;

          @IsDefined()
          forced?: boolean;

          address!: AddressDto;
          labels!: ReadonlyArray<string>;
          flags!: Record<string, boolean>;
          pair!: [string, number];
          metadata!: { active: boolean; note?: string };
        }
      `,
      "users.controller.ts": `
        import { Body, Controller, Post, Query } from "@nestjs/common";
        import { CreateUserDto } from "./create-user.dto";
        @Controller("users")
        export class UsersController {
          @Post()
          create(@Body() input: CreateUserDto, @Query("limit") limit?: number) {
            return { id: "created", email: input.email, limit };
          }
        }
      `,
      "app.module.ts": `
        import { Module } from "@nestjs/common";
        import { UsersController } from "./users.controller";
        @Module({ controllers: [UsersController] })
        export class AppModule {}
      `,
      "main.ts": `
        import { NestFactory } from "@nestjs/core";
        import { AppModule } from "./app.module";
        async function bootstrap() { return NestFactory.create(AppModule); }
        bootstrap();
      `,
    },
    (root) => {
      const report = reportFor(root);
      validateReport(report);
      const route = report.routes[0];
      const body = route.io.schemas.request.body;
      assert.ok(Object.keys(body.schema.properties).length > 15);
      assert.ok(body.schema.required.includes("email"));
      assert.ok(!body.schema.required.includes("age"));
      assert.ok(!body.schema.required.includes("alias"));
      assert.ok(body.schema.required.includes("forced"));
      assert.equal(body.schema.properties.email.format, "email");
      assert.equal(body.schema.properties.age.type, "integer");
      assert.equal(body.schema.properties.age.minimum, 18);
      assert.equal(body.schema.properties.website.format, "uri");
      assert.equal(body.schema.properties.createdAt.format, "date-time");
      assert.equal(body.schema.properties.username.minLength, 2);
      assert.equal(body.schema.properties.username.maxLength, 20);
      assert.equal(body.schema.properties.nickname.maxLength, 8);
      assert.equal(body.schema.properties.score.maximum, 99);
      assert.equal(body.schema.properties.tags.minItems, 1);
      assert.equal(body.schema.properties.tags.maxItems, 3);
      assert.deepEqual(body.schema.properties.role.enum, ["admin", "member"]);
      assert.equal(body.schema.properties.code.pattern, "^usr_");
      assert.deepEqual(body.schema.properties.state.type, ["string", "null"]);
      assert.equal(body.schema.properties.address.properties.city.type, "string");
      assert.equal(body.schema.properties.labels.items.type, "string");
      assert.equal(body.schema.properties.flags.additionalProperties.type, "boolean");
      assert.deepEqual(body.schema.properties.pair.prefixItems, [
        { type: "string" },
        { type: "number" },
      ]);
      assert.deepEqual(body.schema.properties.metadata.required, ["active"]);
      assert.ok(body.evidence.some((item) => item.kind === "class-validator"));
      assert.ok(body.evidence.some((item) => item.kind === "nestjs-swagger"));
      assert.ok(body.evidence.every((item) => item.confidence === "medium"));
      assert.equal(route.io.schemas.request.query.schema.properties.limit.type, "number");

      const operation = formatters.openapi.build(report).paths["/users"].post;
      assert.equal(
        operation.requestBody.content["application/json"].schema.properties.email.format,
        "email",
      );
      assert.equal(
        operation.requestBody.content["application/json"].schema["x-express-recon-unrefined"],
        true,
      );
      assert.equal(operation.parameters.find((item) => item.name === "limit").required, false);
    },
  ));
