"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { scan } = require("../src/static/scan");
const { createScopedResolver } = require("../src/static/resolve");

function fixture(files, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recon-connections-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
    }
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const router = `const router = require('express').Router();
router.get('/items', (req, res) => res.send('ok'));
module.exports = router;`;

test("local route maps resolve while export mutations and cycles stay unresolved", () => {
  for (const mode of ["local", "mutated", "cycle"])
    fixture(
      {
        "app.js": `const app = require('express')();
      ${mode === "local" ? "const routes = {catalog: require('./catalog')};" : "const routes = require('./routes');"}
      Object.keys(routes).forEach(key => app.use('/' + key, routes[key]));`,
        "routes.js":
          mode === "cycle"
            ? "const routes = {self: routes}; module.exports = routes;"
            : "module.exports = {catalog: require('./catalog')}; module.exports.catalog = selectRouter();",
        "catalog.js": router,
      },
      (root) => {
        const result = scan(root);
        if (mode === "local") assert.equal(result.routes[0].path, "/catalog/items");
        else assert.equal(result.routeGraph.complete, false);
      },
    );
});

test("package module aliases resolve exact and nested mounts without executing registration", () =>
  fixture(
    {
      "package.json": JSON.stringify({ _moduleAliases: { "@routes": "./routes" } }),
      "app.js": `require('module-alias/register'); const app = require('express')();
      app.use('/api', require('@routes')); app.use('/direct', require('@routes/catalog'));`,
      "routes/index.js": "module.exports = require('./catalog');",
      "routes/catalog.js": router,
    },
    (root) => {
      const result = scan(root);
      assert.deepEqual(result.routes.map((r) => r.path).sort(), ["/api/items", "/direct/items"]);
      assert.equal(result.routeGraph.complete, true);
    },
  ));

test("module aliases respect package scopes, segment boundaries, longest match and root bounds", () =>
  fixture(
    {
      "package.json": JSON.stringify({
        _moduleAliases: {
          "@routes": "./routes",
          "@routes/special": "./special",
          "@outside": "../outside",
          "@invalid": 42,
        },
      }),
      "app.js": "",
      "routes/index.js": "",
      "special/index.js": "",
      "nested/package.json": "{}",
      "nested/app.js": "",
    },
    (root) => {
      const resolve = createScopedResolver(root);
      const app = path.join(root, "app.js");
      assert.equal(resolve(app, "@routes/special", "require"), path.join(root, "special/index.js"));
      assert.equal(resolve(app, "@routesExtra", "require"), null);
      assert.equal(resolve(app, "@invalid", "require"), null);
      assert.equal(resolve(app, "@outside", "require"), null);
      assert.equal(resolve(path.join(root, "nested/app.js"), "@routes", "require"), null);
      assert.equal(resolve(app, "@routes/missing", "require"), null);
      assert.ok(
        resolve.traces.some((t) => t.specifier === "@routes/missing" && t.outcome === "unresolved"),
      );
    },
  ));

test("ESM import-then-export barrels preserve router identity and middleware order", () =>
  fixture(
    {
      "app.mjs": `import express from 'express'; import { catalog } from './routes.mjs';
      const app = express(); function authenticate(req,res,next) { next(); }
      app.use('/api', authenticate, catalog);`,
      "routes.mjs": "import imported from './catalog.js'; export { imported as catalog };",
      "catalog.js": router,
    },
    (root) => {
      const result = scan(root);
      assert.equal(result.routes[0].path, "/api/items");
      assert.ok(result.routes[0].applicationId);
      assert.equal(result.routes[0].source.line, 2);
      assert.deepEqual(
        result.routes[0].middlewares.map((m) => m.name),
        ["authenticate"],
      );
      assert.equal(result.routeGraph.complete, true);
    },
  ));

test("static Object.keys route maps expand quoted keys and prefixes", () =>
  fixture(
    {
      "app.js": `const app = require('express')(); const routes = require('./routes');
      Object.keys(routes).forEach(key => { app.use('/api/' + key, routes[key]); });`,
      "routes.js": `module.exports = { 'catalog': require('./catalog'), 'admin': require('./admin') };`,
      "catalog.js": router,
      "admin.js": router,
    },
    (root) => {
      const result = scan(root);
      assert.deepEqual(result.routes.map((r) => r.path).sort(), [
        "/api/admin/items",
        "/api/catalog/items",
      ]);
      assert.equal(result.routeGraph.complete, true);
    },
  ));

test("dynamic route maps and conditional loop mounts stay incomplete", () =>
  fixture(
    {
      "app.js": `const app = require('express')(); const routes = require('./routes');
      Object.keys(routes).forEach(key => { if (process.env.ENABLED) app.use('/' + key, routes[key]); });`,
      "routes.js": `module.exports = { ...chooseRoutes(), catalog: require('./catalog') };`,
      "catalog.js": router,
    },
    (root) => {
      const result = scan(root);
      assert.equal(result.routeGraph.complete, false);
      assert.ok(result.routes.every((r) => r.pathConfidence === "partial"));
    },
  ));

test("mutated and oversized route maps remain explicit incomplete evidence", () => {
  for (const mutate of [true, false])
    fixture(
      {
        "app.js": `const app = require('express')(); const routes = require('./routes');
      ${mutate ? "routes.catalog = selectRouter();" : ""}
      Object.keys(routes).forEach(key => app.use('/' + key, routes[key]));`,
        "routes.js": mutate
          ? "module.exports = {catalog: require('./catalog')};"
          : `module.exports = {${Array.from({ length: 257 }, (_, i) => `key${i}: require('./catalog')`).join(",")}};`,
        "catalog.js": router,
      },
      (root) => {
        const result = scan(root);
        assert.equal(result.routeGraph.complete, false);
        assert.ok(result.routes.every((r) => r.pathConfidence === "partial"));
      },
    );
});

test("route-map guards and unresolved targets preserve evidence without execution", () =>
  fixture(
    {
      "app.js": `const app = require('express')(); const routes = require('./routes');
    function authenticate(q,s,n) { n(); }
    Object.keys(routes).forEach(key => app.use('/' + key, authenticate, routes[key]));`,
      "routes.js": "module.exports = {catalog: require('./catalog'), unknown: chooseRouter()};",
      "catalog.js": router,
    },
    (root) => {
      const result = scan(root);
      assert.equal(result.routes[0].path, "/catalog/items");
      assert.equal(result.routes[0].middlewares[0].name, "authenticate");
      assert.equal(result.routeGraph.complete, false);
      assert.equal(result.routeGraph.opaqueMounts.length, 1);
    },
  ));

for (const prefix of ["'/api'", "process.env.BASE_PATH"]) {
  test(`factory-returned apps retain mounts with ${prefix}`, () =>
    fixture(
      {
        "factory.js": `const express = require('express');
      module.exports = { create: function() { const app = express(); return app; } };`,
        "app.js": `const Factory = require('./factory'); const routes = require('./routes');
      const app = Factory.create(); app.use(${prefix}, routes);`,
        "routes.js": router,
      },
      (root) => {
        const result = scan(root);
        assert.ok(result.routes[0].applicationId);
        assert.equal(
          result.routes[0].path,
          prefix === "'/api'" ? "/api/items" : "/<dynamic>/items",
        );
        assert.equal(result.routes[0].pathConfidence, prefix === "'/api'" ? "full" : "partial");
        assert.equal(result.applications.length, 1);
      },
    ));
}

test("plain register methods and server-named callback arguments are not Fastify plugins", () =>
  fixture(
    {
      "helpers.ts": `import { Client } from './client';
      export function add(service) { service.register(Registry.instance); }
      const records = []; records.map(server => Client.from(server));`,
      "client.ts": `export class Client { static from(record) { return {record}; } }`,
    },
    (root) => {
      const result = scan(root);
      assert.deepEqual(result.routes, []);
      assert.deepEqual(result.applications, []);
      assert.deepEqual(result.routeGraph.opaqueMounts, []);
      assert.equal(result.routeGraph.complete, true);
    },
  ));

test("separate factory calls do not share app mounts or authentication", () =>
  fixture(
    {
      "factory.js": `const express = require('express'); module.exports = () => { const app = express(); return app; };`,
      "app.js": `const make = require('./factory'); const router = require('./routes');
    const first = make(); const second = make(); function requireAuth(q,s,n) { n(); }
    first.use('/private', requireAuth, router); second.use('/public', router);`,
      "routes.js": router,
    },
    (root) => {
      const result = scan(root);
      assert.equal(result.applications.length, 2);
      assert.equal(result.routes.length, 2);
      const privateRoute = result.routes.find((r) => r.path === "/private/items");
      const publicRoute = result.routes.find((r) => r.path === "/public/items");
      assert.notEqual(privateRoute.applicationId, publicRoute.applicationId);
      assert.equal(privateRoute.middlewares[0].name, "requireAuth");
      assert.deepEqual(publicRoute.middlewares, []);
    },
  ));

test("ambiguous factory returns never select the first branch as a proven host", () =>
  fixture(
    {
      "factory.js": `const express = require('express'); module.exports = () => {
    const app = express(); if (process.env.MODE) return app; return otherInstance(); };`,
      "app.js": `const make = require('./factory'); const router = require('./routes');
    const app = make(); app.use('/api', router);`,
      "routes.js": router,
    },
    (root) => {
      const result = scan(root);
      assert.equal(result.routeGraph.complete, false);
      assert.equal(result.routes[0].applicationId, null);
    },
  ));

test("real Fastify roots still report unknown registered plugins", () =>
  fixture(
    {
      "app.js": `const app = require('fastify')(); app.register(choosePlugin());`,
    },
    (root) => {
      const result = scan(root);
      assert.equal(result.routeGraph.complete, false);
      assert.equal(result.routeGraph.opaqueMounts.length, 1);
    },
  ));

test("NestJS selects the invoked dynamic-module factory instead of merging unused variants", () =>
  fixture(
    {
      "main.ts": `import { Module, Controller, Get } from '@nestjs/common';
      import { NestFactory } from '@nestjs/core';
      @Controller('items') class Items { @Get() list() { return []; } }
      @Module({}) class ConnectionModule {
        static forRoot() { return { module: ConnectionModule, imports: [UnknownModule] }; }
        static forRootAsync() { return { module: ConnectionModule, providers: [] }; }
      }
      @Module({imports: [ConnectionModule.forRootAsync()], controllers: [Items]}) class AppModule {}
      async function bootstrap() { const app = await NestFactory.create(AppModule); app.setGlobalPrefix('api'); }
      bootstrap();`,
    },
    (root) => {
      const result = scan(root);
      assert.equal(result.routes[0].path, "/api/items");
      assert.equal(result.routes[0].pathConfidence, "full");
      assert.equal(result.routeGraph.complete, true);
    },
  ));

test("NestJS routing-module prefixes still apply to selected factory variants", () =>
  fixture(
    {
      "main.ts": `import { Module, Controller, Get } from '@nestjs/common';
    import { NestFactory, RouterModule } from '@nestjs/core';
    @Controller('items') class Items { @Get() list() {} }
    @Module({}) class Feature {
      static registerAsync() { return {module: Feature, controllers: [Items]}; }
      static forRoot() { return {module: Feature, providers: []}; }
    }
    @Module({imports: [Feature.registerAsync(), RouterModule.register([{path:'v2',module:Feature}])]}) class App {}
    async function start() { const app = await NestFactory.create(App); } start();`,
    },
    (root) => {
      const result = scan(root);
      assert.equal(result.routes[0].path, "/v2/items");
      assert.equal(result.routeGraph.complete, true);
    },
  ));
