"use strict";

const { SCHEMA_VERSION } = require("./report");

const descriptor = {
  type: "object",
  properties: {
    name: { type: "string", description: "Identifier, dotted callee, or '<anonymous>'" },
    kind: { enum: ["identifier", "call", "anonymous", "unknown"] },
    raw: { type: "string", description: "Best-effort source snippet" },
    inner: {
      type: "array",
      items: { type: "string" },
      description: "Names referenced inside a wrapper call, e.g. asyncHandler(requireAuth)",
    },
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

const io = {
  type: "object",
  description:
    "static/hybrid only: best-effort request/response shape hints mined from the handler AST",
  properties: {
    request: {
      type: "object",
      properties: {
        body: { type: "array", items: { type: "string" } },
        query: { type: "array", items: { type: "string" } },
        params: { type: "array", items: { type: "string" } },
        headers: { type: "array", items: { type: "string" } },
      },
    },
    responses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          status: { type: ["integer", "null"] },
          bodyKeys: { oneOf: [{ type: "null" }, { type: "array", items: { type: "string" } }] },
        },
      },
    },
    statusCodes: { type: "array", items: { type: "integer" } },
    handlerResolved: {
      type: "boolean",
      description: "false when the handler couldn't be resolved to a function body to mine",
    },
    handlerName: {
      type: "string",
      description: "handler identifier/dotted callee (e.g. 'controllers.user.getUser'), if named",
    },
    handlerSource: source,
  },
};

const route = {
  type: "object",
  properties: {
    method: { type: "string", description: "HTTP verb, or 'ALL' for router.all() routes" },
    path: {
      type: "string",
      description: "Full mount path; '<dynamic>' marks an unresolvable segment",
    },
    middlewares: { type: "array", items: descriptor },
    source,
    io,
    pathConfidence: { enum: ["full", "partial"] },
    authStatus: { enum: ["proven", "public", "unknown"], description: "audit only" },
    tags: { type: "array", items: { type: "string" }, description: "audit only" },
    accepted: {
      type: "boolean",
      description: "audit only: public but acknowledged via the acceptedPublic baseline",
    },
    presence: { enum: ["both", "static-only", "runtime-only"], description: "hybrid only" },
  },
  required: ["method", "path", "middlewares", "pathConfidence"],
};

const finding = {
  type: "object",
  properties: {
    id: { enum: ["public-route", "per-verb-gap", "opaque-middleware", "stale-baseline"] },
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
    target: {
      type: "object",
      description: "target package identity, when a package.json was found",
      properties: { name: { type: "string" }, version: { type: "string" } },
    },
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
        accepted: { type: "integer", description: "public routes acknowledged via acceptedPublic" },
      },
    },
    findings: { type: "array", items: finding, description: "audit only" },
    diagnostics: {
      type: "array",
      items: { type: "string" },
      description:
        "warnings about resolution confidence (static) and sandboxed boot (runtime/hybrid)",
    },
  },
  required: ["schemaVersion", "tool", "command", "mode", "routes", "globalMiddleware"],
};

module.exports = { REPORT_SCHEMA };
