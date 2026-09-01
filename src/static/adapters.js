"use strict";

const { analyzeFastify, buildFastifyRegistry } = require("./fastify");
const { analyzeNestjs, buildNestjsRegistry } = require("./nestjs");

/**
 * Static framework adapters share the parsed AST and source limits owned by the
 * scanner. Each adapter returns the common route/application registry shape;
 * none imports or executes target framework packages.
 */
const STATIC_FRAMEWORK_ADAPTERS = Object.freeze([
  Object.freeze({ name: "fastify", analyze: analyzeFastify, build: buildFastifyRegistry }),
  Object.freeze({ name: "nestjs", analyze: analyzeNestjs, build: buildNestjsRegistry }),
]);

module.exports = { STATIC_FRAMEWORK_ADAPTERS };
