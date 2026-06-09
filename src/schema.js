"use strict";

const { SCHEMA_VERSION } = require("./report");

const descriptor = {
  type: "object",
  properties: {
    name: { type: "string", description: "Identifier, dotted callee, or '<anonymous>'" },
    kind: { enum: ["identifier", "call", "anonymous", "unknown"] },
    raw: { type: "string", description: "Best-effort source snippet" },
  },
  required: ["name", "kind", "raw"],
};

const source = {
  oneOf: [
    { type: "null" },
    {
      type: "object",
      properties: { file: { type: "string" }, line: { type: ["integer", "null"] } },
      required: ["file", "line"],
    },
  ],
};

const route = {
  type: "object",
  properties: {
    method: { type: "string" },
    path: { type: "string" },
    middlewares: { type: "array", items: descriptor },
    source,
    pathConfidence: { enum: ["full", "partial"] },
    authStatus: { enum: ["proven", "public", "unknown"], description: "audit only" },
    tags: { type: "array", items: { type: "string" }, description: "audit only" },
    presence: { enum: ["both", "static-only", "runtime-only"], description: "hybrid only" },
  },
  required: ["method", "path", "middlewares", "pathConfidence"],
};

const finding = {
  type: "object",
  properties: {
    id: { enum: ["public-route", "per-verb-gap", "opaque-middleware"] },
    severity: { enum: ["high", "medium", "low"] },
    method: { type: "string" },
    path: { type: "string" },
    source,
    methods: { type: "array", items: { type: "object" } },
    detail: { type: "string" },
  },
  required: ["id", "severity", "detail"],
};

const REPORT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "express-recon report",
  type: "object",
  properties: {
    schemaVersion: { const: SCHEMA_VERSION },
    tool: { const: "express-recon" },
    command: { enum: ["inventory", "audit"] },
    mode: { enum: ["static", "runtime", "hybrid"] },
    routes: { type: "array", items: route },
    globalMiddleware: { type: "array", items: descriptor },
    summary: {
      type: "object",
      description: "audit only",
      properties: {
        routes: { type: "integer" },
        public: { type: "integer" },
        unknown: { type: "integer" },
        proven: { type: "integer" },
      },
    },
    findings: { type: "array", items: finding, description: "audit only" },
  },
  required: ["schemaVersion", "tool", "command", "mode", "routes", "globalMiddleware"],
};

module.exports = { REPORT_SCHEMA };
