"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const { audit, buildReport, discover, formatters, inventory, REPORT_SCHEMA } = require("../src");
const { scanOrganization } = require("../src/organization");

const CLI = path.join(__dirname, "..", "src", "cli.js");

function temporaryRepository(files, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-framework-"));
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

function routeIndex(routes) {
  return Object.fromEntries(routes.map((route) => [`${route.method} ${route.path}`, route]));
}

function validateReport(report) {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(REPORT_SCHEMA);
  assert.equal(validate(report), true, JSON.stringify(validate.errors));
}

test("Express discovery accepts require aliases, inline factories, JSX-in-JS, and empty apps", () =>
  temporaryRepository(
    {
      "aliased.js": `
        const load = require;
        const express = load("express");
        const app = express();
        app.get("/aliased", (_request, response) => response.send("ok"));
      `,
      "inline.js": `
        const app = require("express")();
        app.get("/inline", (_request, response) => response.send("ok"));
      `,
      "jsx-server.js": `
        const express = require("express");
        const app = express();
        const view = <main>ready</main>;
        app.get("/jsx", (_request, response) => response.send(String(view)));
      `,
      "listener.js": `
        const express = require("express");
        const app = express();
        app.listen(3000);
      `,
      "registrar-app.js": `
        const express = require("express");
        const registerRoutes = require("./register-routes");
        const app = express();
        registerRoutes(app);
      `,
      "register-routes.js": `
        module.exports = function registerRoutes(server) {
          server.get("/registered", (_request, response) => response.send("ok"));
        };
      `,
    },
    (root) => {
      const registry = inventory({ mode: "static", src: root });
      assert.deepEqual(registry.routes.map((route) => route.path).sort(), [
        "/aliased",
        "/inline",
        "/jsx",
        "/registered",
      ]);
      assert.equal(registry.applications.length, 5);
      assert.ok(
        registry.applications.some((application) => application.name === "listener.js#app"),
      );
      assert.equal(
        registry.routes.find((route) => route.path === "/registered").pathConfidence,
        "full",
      );
      assert.equal(registry.scanCoverage.complete, true);
      assert.ok(!registry.diagnostics.some((message) => message.includes("could not parse")));
    },
  ));

const FASTIFY_FILES = {
  "package.json": JSON.stringify({
    name: "fastify-service",
    version: "1.0.0",
    dependencies: { fastify: "^5.0.0", "fastify-plugin": "^5.0.0" },
  }),
  "app.js": `
    import Fastify from "fastify";
    import autoload from "@fastify/autoload";
    import users from "./users.js";

    function requestContext() {}
    function health(_request, reply) { reply.send({ ok: true }); }

    const app = Fastify();
    app.addHook("onRequest", requestContext);
    app.register(users, { prefix: "/v1" });
    app.register(autoload, { dir: "./generated" });
    app.get("/health", health);
    export default app;
  `,
  "users.js": `
    function validateTenant() {}
    function requireSession() {}
    function createUser(request, reply) {
      return reply.code(201).send({ id: request.body.name });
    }

    export default async function usersPlugin(server) {
      server.addHook("preValidation", validateTenant);
      server.get(
        "/users/:id",
        { preHandler: [requireSession] },
        (request, reply) => reply.send({ id: request.params.id }),
      );
      server.route({
        method: ["POST", "DELETE"],
        url: "/users",
        preHandler: requireSession,
        handler: createUser,
      });
      server.trace(
        "/diagnostics",
        { preHandler: requireSession },
        (_request, reply) => reply.send(),
      );
    }
  `,
};

test("Fastify adapter resolves plugins, prefixes, hooks, route options, and OpenAPI provenance", () =>
  temporaryRepository(FASTIFY_FILES, (root) => {
    const registry = audit(
      { mode: "static", src: root },
      { authMiddleware: { requireSession: "session", validateTenant: "tenant" } },
    );
    const routes = routeIndex(registry.routes);

    assert.deepEqual(Object.keys(routes).sort(), [
      "DELETE /v1/users",
      "GET /health",
      "GET /v1/users/:id",
      "POST /v1/users",
      "TRACE /v1/diagnostics",
    ]);
    assert.ok(Object.values(routes).every((route) => route.framework === "fastify"));
    assert.equal(routes["GET /health"].authStatus, "public");
    assert.equal(routes["GET /v1/users/:id"].authStatus, "proven");
    assert.deepEqual(
      routes["GET /v1/users/:id"].middlewares.map(({ name, stage }) => ({ name, stage })),
      [
        { name: "requestContext", stage: "hook" },
        { name: "validateTenant", stage: "hook" },
        { name: "requireSession", stage: "hook" },
      ],
    );
    assert.deepEqual(routes["GET /v1/users/:id"].io.request.params, ["id"]);
    assert.deepEqual(routes["POST /v1/users"].io.request.body, ["name"]);
    assert.ok(routes["POST /v1/users"].io.responses.some((response) => response.status === 201));
    assert.equal(registry.applications.length, 1);
    assert.equal(registry.applications[0].framework, "fastify");
    assert.equal(registry.applications[0].adapter, "fastify");
    assert.equal(registry.routeGraph.complete, false);
    assert.equal(registry.routeGraph.opaqueMounts.length, 1);

    const discovery = discover(root);
    assert.deepEqual(
      discovery.packages[0].frameworks.map((item) => item.name),
      ["fastify"],
    );
    assert.equal(discovery.applications[0].framework, "fastify");

    const report = buildReport(registry, {
      command: "audit",
      mode: "static",
      sourceRoot: root,
    });
    validateReport(report);
    const openapi = formatters.openapi.build(report);
    assert.deepEqual(openapi["x-express-recon"].frameworks, ["fastify"]);
    assert.equal(openapi.paths["/v1/users/{id}"].get["x-express-recon"].framework, "fastify");
    assert.deepEqual(openapi.paths["/v1/users/{id}"].get["x-express-recon"].middlewareStages, [
      "hook",
      "hook",
      "hook",
    ]);
  }));

test("Fastify plugin packages retain unmounted routes as partial evidence", () =>
  temporaryRepository(
    {
      "plugin.js": `
        module.exports = async function diagnosticsPlugin(server) {
          server.get("/health", async () => ({ ok: true }));
        };
      `,
    },
    (root) => {
      const registry = inventory({ mode: "static", src: root });
      assert.equal(registry.routes.length, 1);
      assert.equal(registry.routes[0].framework, "fastify");
      assert.equal(registry.routes[0].applicationId, null);
      assert.equal(registry.routes[0].pathConfidence, "partial");
      assert.equal(registry.routeGraph.complete, false);
      assert.ok(registry.diagnostics.some((message) => message.includes("Fastify plugin route")));
    },
  ));

test("Fastify adapter respects hook order and fastify-plugin transparency", () =>
  temporaryRepository(
    {
      "app.js": `
        const Fastify = require("fastify");
        const fp = require("fastify-plugin");
        function authenticate() {}
        async function sharedRoutes(server) {
          server.get("/shared", async () => ({ ok: true }));
        }
        const app = Fastify();
        app.get("/before", async () => ({ ok: true }));
        app.register(sharedRoutes, { prefix: "/raw" });
        app.register(fp(sharedRoutes), { prefix: "/ignored" });
        app.register(fp(async function authenticationPlugin(server) {
          server.addHook("onRequest", authenticate);
          server.get("/inside", async () => ({ ok: true }));
        }), { prefix: "/ignored" });
        app.get("/after", async () => ({ ok: true }));
      `,
    },
    (root) => {
      const registry = audit(
        { mode: "static", src: root },
        { authMiddleware: { authenticate: "authenticated" } },
      );
      const routes = routeIndex(registry.routes);
      assert.deepEqual(Object.keys(routes).sort(), [
        "GET /after",
        "GET /before",
        "GET /inside",
        "GET /raw/shared",
        "GET /shared",
      ]);
      assert.equal(routes["GET /before"].authStatus, "public");
      assert.equal(routes["GET /inside"].authStatus, "proven");
      assert.equal(routes["GET /after"].authStatus, "proven");
      assert.ok(
        registry.diagnostics.some(
          (message) => message.includes("prefix") && message.includes("ignored"),
        ),
      );
    },
  ));

test("Fastify adapter connects direct instance registrars and nested plugin prefixes", () =>
  temporaryRepository(
    {
      "app.js": `
        const Fastify = require("fastify");
        const cors = require("@fastify/cors");
        const sensible = require("@fastify/sensible");
        const configure = require("./configure");
        const server = Fastify();
        configure(server, cors, sensible);
        server.get("/health", async () => ({ ok: true }));
      `,
      "configure.js": `
        const routes = require("./routes")({ source: "fixture" });
        module.exports = function configure(instance, cors, sensible) {
          instance.register(cors);
          instance.register(sensible);
          instance.register(routes, { prefix: "/api/v1" });
        };
      `,
      "routes.js": `
        module.exports = function createRoutes(_dependencies) {
          return async function routes(server) {
            server.get("/users", async () => []);
          };
        };
      `,
    },
    (root) => {
      const registry = inventory({ mode: "static", src: root });
      assert.deepEqual(registry.routes.map((route) => `${route.method} ${route.path}`).sort(), [
        "GET /api/v1/users",
        "GET /health",
      ]);
      assert.ok(registry.routes.every((route) => route.applicationId));
      assert.equal(registry.routeGraph.complete, true);
      assert.equal(registry.routeGraph.orphanRoutes, 0);
    },
  ));

test("Fastify no-route plugin handling uses call-site imports, not parameter names", () =>
  temporaryRepository(
    {
      "app.js": `
        const Fastify = require("fastify");
        const app = Fastify();
        const routeProvider = selectAtRuntime();
        function configure(instance, cors) {
          instance.register(cors);
        }
        configure(app, routeProvider);
      `,
    },
    (root) => {
      const registry = inventory({ mode: "static", src: root });
      assert.equal(registry.applications.length, 1);
      assert.equal(registry.routeGraph.opaqueMounts.length, 1);
      assert.equal(registry.routeGraph.complete, false);
    },
  ));

test("Fastify adapter ignores generic route methods and deduplicates orphan plugin evidence", () =>
  temporaryRepository(
    {
      "browser.js": `
        async function intercept(page) {
          await page.route("**/*", async (route) => route.continue());
        }
        module.exports = intercept;
      `,
      "alternative-server.ts": `
        import type { TemplatedApp } from "uWebSockets.js";
        export class AlternativeRouter {
          constructor(app: TemplatedApp) {
            app.get("/health", () => undefined).ws("/*", {});
          }
        }
      `,
      "a-child.js": `
        module.exports = async function childPlugin(server) {
          server.get("/child", async () => ({ ok: true }));
        };
      `,
      "z-parent.js": `
        const childPlugin = require("./a-child");
        module.exports = async function parentPlugin(server) {
          server.register(childPlugin);
        };
      `,
    },
    (root) => {
      const registry = inventory({ mode: "static", src: root });
      assert.equal(registry.routes.length, 1);
      assert.equal(registry.routes[0].path, "/child");
      assert.equal(registry.routes[0].framework, "fastify");
      assert.ok(!registry.diagnostics.some((message) => message.includes("browser.js")));
      assert.equal(registry.routeGraph.opaqueMounts.length, 0);
    },
  ));

const NEST_FILES = {
  "package.json": JSON.stringify({
    name: "nest-service",
    version: "1.0.0",
    dependencies: {
      "@nestjs/common": "^11.0.0",
      "@nestjs/core": "^11.0.0",
      "@nestjs/platform-fastify": "^11.0.0",
    },
  }),
  "main.ts": `
    import { NestFactory } from "@nestjs/core";
    import { FastifyAdapter } from "@nestjs/platform-fastify";
    import type { NestFastifyApplication } from "@nestjs/platform-fastify";
    import { AppModule } from "./app.module";

    class GlobalGuard {}
    async function bootstrap() {
      const app = await NestFactory.create<NestFastifyApplication>(
        AppModule,
        new FastifyAdapter(),
      );
      app.setGlobalPrefix("api");
      app.useGlobalGuards(GlobalGuard);
    }
    bootstrap();
  `,
  "app.module.ts": `
    import { Module } from "@nestjs/common";
    import { APP_INTERCEPTOR, RouterModule } from "@nestjs/core";
    import { UsersModule } from "./users.module";

    class AuditInterceptor {}
    @Module({
      imports: [
        UsersModule,
        RouterModule.register([{ path: "v2", module: UsersModule }]),
      ],
      providers: [{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
    })
    export class AppModule {}
  `,
  "users.module.ts": `
    import {
      MiddlewareConsumer,
      Module,
      NestModule,
      RequestMethod,
    } from "@nestjs/common";
    import { UsersController } from "./users.controller";
    import { HealthModule } from "./health.module";
    class TenantMiddleware {}
    @Module({ controllers: [UsersController], imports: [HealthModule] })
    export class UsersModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer
          .apply(TenantMiddleware)
          .exclude({ path: "users/health", method: RequestMethod.GET })
          .forRoutes(UsersController);
      }
    }
  `,
  "users.controller.ts": `
    import {
      Body,
      Controller,
      Get,
      Headers,
      HttpCode,
      HttpStatus,
      Param,
      Post,
      UseGuards,
      UsePipes,
    } from "@nestjs/common";

    class ClassGuard {}
    class RouteGuard {}
    class ValidationPipe {}

    @Controller("users")
    @UseGuards(ClassGuard)
    export class UsersController {
      @Get(":id")
      @UseGuards(RouteGuard)
      find(@Param("id") id: string, @Headers("x-tenant") tenant: string) {
        return { id, tenant };
      }

      @Get("health")
      health() {
        return { ok: true };
      }

      @Get("health/details")
      healthDetails() {
        return { ready: true };
      }

      @Post()
      @HttpCode(HttpStatus.ACCEPTED)
      @UsePipes(ValidationPipe)
      create(@Body("name") name: string) {
        return { id: "new", name };
      }
    }
  `,
  "health.module.ts": `
    import { Controller, Get, Module } from "@nestjs/common";
    @Controller("meta")
    class HealthController {
      @Get("ping")
      ping() { return { ok: true }; }
    }
    @Module({ controllers: [HealthController] })
    export class HealthModule {}
  `,
};

test("NestJS adapter resolves modules, router/global prefixes, lifecycle stages, and Fastify platform", () =>
  temporaryRepository(NEST_FILES, (root) => {
    const registry = audit(
      { mode: "static", src: root },
      { authMiddleware: { GlobalGuard: "authenticated" } },
    );
    const routes = routeIndex(registry.routes);

    assert.deepEqual(Object.keys(routes).sort(), [
      "GET /api/v2/meta/ping",
      "GET /api/v2/users/:id",
      "GET /api/v2/users/health",
      "GET /api/v2/users/health/details",
      "POST /api/v2/users",
    ]);
    assert.ok(Object.values(routes).every((route) => route.framework === "nestjs"));
    assert.ok(Object.values(routes).every((route) => route.authStatus === "proven"));
    assert.deepEqual(
      routes["GET /api/v2/users/:id"].middlewares.map(({ name, stage }) => ({ name, stage })),
      [
        { name: "TenantMiddleware", stage: "middleware" },
        { name: "GlobalGuard", stage: "guard" },
        { name: "AuditInterceptor", stage: "interceptor" },
        { name: "ClassGuard", stage: "guard" },
        { name: "RouteGuard", stage: "guard" },
      ],
    );
    assert.deepEqual(routes["GET /api/v2/users/:id"].io.request.params, ["id"]);
    assert.deepEqual(routes["GET /api/v2/users/:id"].io.request.headers, ["x-tenant"]);
    assert.deepEqual(routes["POST /api/v2/users"].io.request.body, ["name"]);
    assert.deepEqual(routes["POST /api/v2/users"].io.statusCodes, [202]);
    assert.ok(
      !routes["GET /api/v2/users/health"].middlewares.some(
        (middleware) => middleware.name === "TenantMiddleware",
      ),
    );
    assert.ok(
      routes["GET /api/v2/users/health/details"].middlewares.some(
        (middleware) => middleware.name === "TenantMiddleware",
      ),
    );
    assert.equal(registry.applications[0].framework, "nestjs");
    assert.equal(registry.applications[0].adapter, "fastify");

    const discovery = discover(root);
    assert.deepEqual(
      discovery.packages[0].frameworks.map((item) => item.name),
      ["nestjs"],
    );
    assert.equal(discovery.applications[0].framework, "nestjs");

    const automaticRuntime = spawnSync(
      process.execPath,
      [
        CLI,
        "inventory",
        "--mode",
        "hybrid",
        "--src",
        root,
        "--app",
        "auto",
        "--allow-exec",
        "--format",
        "json",
      ],
      { encoding: "utf8" },
    );
    assert.equal(automaticRuntime.status, 1);
    assert.match(automaticRuntime.stderr, /found a nestjs application/);
    assert.match(automaticRuntime.stderr, /use --mode static/);

    const report = buildReport(registry, {
      command: "audit",
      mode: "static",
      sourceRoot: root,
    });
    validateReport(report);
    const openapi = formatters.openapi.build(report);
    assert.deepEqual(openapi["x-express-recon"].frameworks, ["nestjs"]);

    const applicationId = registry.applications[0].id;
    assert.throws(
      () =>
        inventory({
          mode: "hybrid",
          src: root,
          runtimeEntry: path.join(root, "main.ts"),
          applicationId,
          runtimeRegistry: {
            routes: [],
            applications: [],
            globalMiddleware: [],
          },
        }),
      /supports Express applications only/,
    );
  }));

test("dynamic NestJS middleware scopes fail closed as needs-review evidence", () =>
  temporaryRepository(
    {
      "main.ts": `
        import { NestFactory } from "@nestjs/core";
        import { AppModule } from "./module";
        async function bootstrap() {
          const app = await NestFactory.create(AppModule);
        }
      `,
      "module.ts": `
        import { Controller, Get, MiddlewareConsumer, Module } from "@nestjs/common";
        import { RouterModule } from "@nestjs/core";
        class AuthMiddleware {}
        const dynamicRoutes = getRoutesFromConfiguration();
        @Controller("accounts")
        export class AccountsController {
          @Get()
          list() { return []; }
        }
        @Module({
          controllers: [AccountsController],
          imports: [RouterModule.register(getDynamicMappings())],
        })
        export class AppModule {
          configure(consumer: MiddlewareConsumer) {
            consumer.apply(AuthMiddleware).forRoutes(...dynamicRoutes);
          }
        }
      `,
    },
    (root) => {
      const registry = audit({ mode: "static", src: root }, {});
      assert.equal(registry.routes.length, 1);
      assert.equal(registry.routes[0].authStatus, "unknown");
      assert.equal(registry.routes[0].middlewares[0].kind, "unknown");
      assert.equal(registry.routes[0].pathConfidence, "partial");
      assert.ok(
        registry.diagnostics.some(
          (message) =>
            message.includes("middleware scope") && message.includes("runtime confirmation"),
        ),
      );
    },
  ));

test("unknown NestJS platform adapters remain explicit partial evidence", () =>
  temporaryRepository(
    {
      "app.ts": `
        import { Controller, Get, Module } from "@nestjs/common";
        import { NestFactory } from "@nestjs/core";
        class CustomAdapter {}
        @Controller("status")
        class StatusController {
          @Get()
          status() { return { ok: true }; }
        }
        @Module({ controllers: [StatusController] })
        class AppModule {}
        async function bootstrap() {
          const app = await NestFactory.create(AppModule, new CustomAdapter());
        }
      `,
    },
    (root) => {
      const registry = inventory({ mode: "static", src: root });
      assert.equal(registry.applications[0].adapter, "unknown");
      assert.equal(registry.routes[0].pathConfidence, "partial");
      assert.ok(registry.diagnostics.some((message) => message.includes("platform adapter")));
      validateReport(
        buildReport(registry, { command: "inventory", mode: "static", sourceRoot: root }),
      );
    },
  ));

test("NestJS resolves default-exported modules through NodeNext JavaScript specifiers", () =>
  temporaryRepository(
    {
      "main.ts": `
        import { NestFactory } from "@nestjs/core";
        import AppModule from "./app.module.js";
        async function bootstrap() {
          const app = await NestFactory.create(AppModule);
        }
        bootstrap();
      `,
      "app.module.ts": `
        import { Controller, Get, Module } from "@nestjs/common";
        @Controller("health")
        class HealthController {
          @Get()
          ready() { return { ready: true }; }
        }
        @Module({ controllers: [HealthController] })
        export default class AppModule {}
      `,
    },
    (root) => {
      const registry = inventory({ mode: "static", src: root });
      assert.equal(registry.applications.length, 1);
      assert.equal(registry.applications[0].framework, "nestjs");
      assert.deepEqual(
        registry.routes.map((route) => `${route.method} ${route.path}`),
        ["GET /health"],
      );
      assert.equal(registry.routes[0].pathConfidence, "full");
      assert.equal(registry.routeGraph.complete, true);
    },
  ));

test("NestJS resolves local workspace packages and static dynamic-module metadata", () =>
  temporaryRepository(
    {
      "package.json": JSON.stringify({
        name: "workspace",
        private: true,
        workspaces: ["apps/*", "packages/*"],
      }),
      "apps/api/package.json": JSON.stringify({ name: "@example/api", private: true }),
      "apps/api/main.ts": `
        import { NestFactory } from "@nestjs/core";
        import { AppModule } from "./app.module.js";
        async function bootstrap() {
          const app = await NestFactory.create(AppModule);
        }
        bootstrap();
      `,
      "apps/api/app.module.ts": `
        import { Module } from "@nestjs/common";
        import { FeatureModule } from "@example/feature/main.module";
        @Module({ imports: [FeatureModule.register({ enabled: true })] })
        export class AppModule {}
      `,
      "packages/feature/package.json": JSON.stringify({
        name: "@example/feature",
        private: true,
        exports: { "./*": "./dist/*.js" },
      }),
      "packages/feature/src/main.module.ts": `
        import { Controller, Get, Module } from "@nestjs/common";
        @Controller("features")
        class FeatureController {
          @Get()
          list() { return []; }
        }
        @Module({})
        export class FeatureModule {
          static register(_options: object) {
            return { module: FeatureModule, controllers: [FeatureController] };
          }
        }
      `,
    },
    (root) => {
      const registry = inventory({ mode: "static", src: root });
      assert.deepEqual(
        registry.routes.map((route) => `${route.method} ${route.path}`),
        ["GET /features"],
      );
      assert.ok(registry.routes[0].applicationId);
      assert.equal(registry.routes[0].pathConfidence, "full");
      assert.equal(registry.routeGraph.complete, true);
    },
  ));

function githubResponse(repositories) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(repositories),
  };
}

function organizationScan(frameworks, routeGraphComplete = true) {
  const applications = frameworks.map((framework, index) => ({
    id: `${framework}:src/app-${index}.js#app`,
    framework,
    adapter: framework === "fastify" ? "fastify" : "express",
    source: { file: `src/app-${index}.js`, line: 1 },
    routeCount: 1,
    globalMiddleware: [],
  }));
  return {
    repository: { commit: "a".repeat(40), acquisition: { complete: true } },
    discovery: {
      packages: [],
      applications,
      documentation: { specifications: [], jsdoc: [] },
      discoveryCoverage: { complete: true },
      scanCoverage: { complete: true },
    },
    inventory: {
      command: "inventory",
      applications,
      routes: applications.map((application) => ({
        applicationId: application.id,
        framework: application.framework,
        method: "GET",
        path: "/health",
        middlewares: [],
        source: application.source,
        pathConfidence: "full",
      })),
      scanCoverage: { complete: true },
      routeGraph: {
        complete: routeGraphComplete,
        orphanRoutes: 0,
        partialRoutes: routeGraphComplete ? 0 : 1,
        registrarRoutes: 0,
        opaqueMounts: [],
      },
    },
    documentation: { status: "needs-input" },
  };
}

test("organization scans classify Fastify, NestJS, mixed, and unsupported repositories", async () => {
  const names = ["fastify-api", "nest-api", "mixed-api", "other"];
  const result = await scanOrganization("acme", {
    maxRepositories: names.length,
    retainScans: false,
    fetchImpl: async () =>
      githubResponse(
        names.map((name, index) => ({
          id: index + 1,
          name,
          full_name: `acme/${name}`,
          default_branch: "main",
          private: false,
          visibility: "public",
          archived: false,
          disabled: false,
          fork: false,
          size: 1,
        })),
      ),
    scanRepositoryImpl: async (source) => {
      if (source.endsWith("fastify-api")) return organizationScan(["fastify"], false);
      if (source.endsWith("nest-api")) return organizationScan(["nestjs"]);
      if (source.endsWith("mixed-api")) return organizationScan(["express", "fastify"]);
      return organizationScan([]);
    },
  });

  assert.deepEqual(
    Object.fromEntries(result.repositories.map((entry) => [entry.repository.name, entry.status])),
    {
      "fastify-api": "fastify",
      "nest-api": "nestjs",
      "mixed-api": "multi-framework",
      other: "not-express",
    },
  );
  assert.equal(result.summary.supportedRepositories, 3);
  assert.equal(result.summary.applicationRepositories, 3);
  assert.equal(result.summary.dependencyOnlyRepositories, 0);
  assert.equal(result.summary.expressRepositories, 1);
  assert.equal(result.summary.fastifyRepositories, 2);
  assert.equal(result.summary.nestjsRepositories, 1);
  assert.equal(result.summary.nonExpressRepositories, 1);
  assert.equal(result.summary.applications, 4);
  assert.equal(result.summary.routes, 4);
  assert.equal(result.summary.incompleteRouteGraphs, 1);
  assert.equal(result.coverage.complete, false);
  assert.deepEqual(result.coverage.incompleteRepositories, ["acme/fastify-api"]);
  assert.equal(
    result.repositories.find((entry) => entry.repository.name === "fastify-api").routeGraphComplete,
    false,
  );
  const nestEvidence = result.repositories.find((entry) => entry.repository.name === "nest-api")
    .frameworks.items[0];
  assert.equal(nestEvidence.classification.role, "application");
  assert.equal(nestEvidence.classification.confidence, "high");
});

test("organization classification distinguishes runtime dependencies from applications", async () => {
  const packageOnly = organizationScan([]);
  packageOnly.discovery.packages = [
    {
      id: "package:.",
      root: ".",
      name: "middleware-library",
      version: "1.0.0",
      frameworks: [
        {
          name: "express",
          packages: [
            {
              package: "express",
              field: "dependencies",
              range: "^5.0.0",
              direct: true,
              scope: "runtime",
              strength: "strong",
            },
          ],
        },
      ],
    },
  ];
  const result = await scanOrganization("acme", {
    maxRepositories: 1,
    retainScans: false,
    fetchImpl: async () =>
      githubResponse([
        {
          id: 1,
          name: "middleware-library",
          full_name: "acme/middleware-library",
          default_branch: "main",
          private: false,
          visibility: "public",
          archived: false,
          disabled: false,
          fork: false,
          size: 1,
        },
      ]),
    scanRepositoryImpl: async () => packageOnly,
  });

  const entry = result.repositories[0];
  assert.equal(entry.status, "express");
  assert.equal(result.summary.applicationRepositories, 0);
  assert.equal(result.summary.dependencyOnlyRepositories, 1);
  const evidence = entry.frameworks.items[0];
  assert.equal(evidence.classification.role, "runtime-dependency");
  assert.equal(evidence.classification.confidence, "medium");
  assert.deepEqual(evidence.classification.directDependencies, {
    signal: "package-json-direct-dependency",
    count: 1,
    rootCount: 1,
    runtimeCount: 1,
    optionalCount: 0,
    peerCount: 0,
    developmentCount: 0,
  });
});
