"use strict";

require("reflect-metadata");

const { Controller, Get, Injectable, Module, UseGuards } = require("@nestjs/common");
const { NestFactory } = require("@nestjs/core");

class DenyGuard {
  canActivate() {
    return false;
  }
}
Injectable()(DenyGuard);

class StatusController {
  health() {
    return { ok: true };
  }

  secure() {
    return { secret: true };
  }
}
Controller("status")(StatusController);
Get("health")(
  StatusController.prototype,
  "health",
  Object.getOwnPropertyDescriptor(StatusController.prototype, "health"),
);
Get("secure")(
  StatusController.prototype,
  "secure",
  Object.getOwnPropertyDescriptor(StatusController.prototype, "secure"),
);
UseGuards(DenyGuard)(
  StatusController.prototype,
  "secure",
  Object.getOwnPropertyDescriptor(StatusController.prototype, "secure"),
);

class AppModule {}
Module({ controllers: [StatusController] })(AppModule);

async function createApplication(platform) {
  const Adapter =
    platform === "fastify"
      ? require("@nestjs/platform-fastify").FastifyAdapter
      : require("@nestjs/platform-express").ExpressAdapter;
  const app = await NestFactory.create(AppModule, new Adapter(), { logger: false });
  app.setGlobalPrefix("api");
  await app.listen(0, "127.0.0.1");
  return app;
}

module.exports = { createApplication };
