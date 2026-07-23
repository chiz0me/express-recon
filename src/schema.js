"use strict";

const { SCHEMA_VERSION } = require("./report");

const descriptor = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", description: "Identifier, dotted callee, or '<anonymous>'" },
    kind: { enum: ["identifier", "call", "anonymous", "unknown"] },
    raw: { type: "string", description: "Best-effort source snippet" },
    inner: {
      type: "array",
      items: { type: "string" },
      description:
        "Names referenced inside a wrapper call; auth proof requires the outer call in authWrappers",
    },
  },
  required: ["name", "kind", "raw"],
};

const source = {
  oneOf: [
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      properties: { file: { type: "string" }, line: { type: ["integer", "null"] } },
      required: ["file", "line"],
    },
  ],
};

const io = {
  type: "object",
  additionalProperties: false,
  description:
    "static/hybrid only: best-effort request/response shape hints mined from the handler AST",
  properties: {
    request: {
      type: "object",
      additionalProperties: false,
      properties: {
        body: { type: "array", items: { type: "string" } },
        query: { type: "array", items: { type: "string" } },
        params: { type: "array", items: { type: "string" } },
        headers: { type: "array", items: { type: "string" } },
      },
      required: ["body", "query", "params", "headers"],
    },
    responses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: ["integer", "null"] },
          bodyKeys: { oneOf: [{ type: "null" }, { type: "array", items: { type: "string" } }] },
        },
        required: ["status", "bodyKeys"],
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
  required: ["request", "responses", "statusCodes", "handlerResolved"],
};

const route = {
  type: "object",
  additionalProperties: false,
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
    roles: { type: "array", items: { type: "string" }, description: "audit only" },
    scopes: { type: "array", items: { type: "string" }, description: "audit only" },
    authEvidence: {
      type: "object",
      description: "audit only: recognized middleware grants supporting the classification",
      additionalProperties: false,
      properties: {
        matched: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              roles: { type: "array", items: { type: "string" } },
              scopes: { type: "array", items: { type: "string" } },
            },
            required: ["name", "tags", "roles", "scopes"],
          },
        },
        opaque: { type: "boolean" },
      },
      required: ["matched"],
    },
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
  additionalProperties: false,
  properties: {
    id: {
      enum: [
        "public-route",
        "per-verb-gap",
        "opaque-middleware",
        "stale-baseline",
        "policy-violation",
      ],
    },
    ruleId: {
      type: "string",
      description: "Built-in rule id or configured policy id",
    },
    fingerprint: {
      type: "string",
      description: "Stable identity derived from rule and route identity",
    },
    severity: { enum: ["high", "medium", "low"] },
    confidence: { enum: ["high", "medium", "low"] },
    method: { type: "string" },
    path: { type: "string" },
    source,
    methods: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          method: { type: "string" },
          authStatus: { enum: ["proven", "public", "unknown"] },
          source,
        },
        required: ["method", "authStatus", "source"],
      },
    },
    baselineEntry: { type: "string" },
    detail: { type: "string" },
    recommendation: { type: "string" },
    evidence: {
      type: "object",
      description: "Structured evidence for a configurable policy violation",
    },
  },
  required: ["id", "ruleId", "fingerprint", "severity", "confidence", "detail", "recommendation"],
};

const REPORT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "express-recon report",
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: SCHEMA_VERSION },
    tool: { const: "express-recon" },
    command: { enum: ["inventory", "audit"] },
    mode: { enum: ["static", "runtime", "hybrid"] },
    target: {
      type: "object",
      additionalProperties: false,
      description: "target package identity, when a package.json was found",
      properties: { name: { type: "string" }, version: { type: "string" } },
    },
    routes: { type: "array", items: route },
    globalMiddleware: { type: "array", items: descriptor },
    summary: {
      type: "object",
      additionalProperties: false,
      description: "audit only",
      properties: {
        routes: { type: "integer", minimum: 0 },
        public: { type: "integer", minimum: 0 },
        unknown: { type: "integer", minimum: 0 },
        proven: { type: "integer", minimum: 0 },
        accepted: {
          type: "integer",
          minimum: 0,
          description: "public routes acknowledged via acceptedPublic",
        },
        policyViolations: { type: "integer", minimum: 0 },
        policyExceptions: { type: "integer", minimum: 0 },
      },
      required: [
        "routes",
        "public",
        "unknown",
        "proven",
        "accepted",
        "policyViolations",
        "policyExceptions",
      ],
    },
    policies: {
      type: "array",
      description: "Normalized configurable route policies evaluated by audit",
      items: { type: "object" },
    },
    policyExceptions: {
      type: "array",
      description: "Active, expiring policy exceptions applied to matching routes",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          policyId: { type: "string" },
          exceptionId: { type: "string" },
          method: { type: "string" },
          path: { type: "string" },
          reason: { type: "string" },
          expires: { type: "string", format: "date" },
        },
        required: ["policyId", "exceptionId", "method", "path", "reason", "expires"],
      },
    },
    delta: {
      type: "object",
      additionalProperties: false,
      description: "Comparison with a prior report supplied through --baseline",
      properties: {
        baseline: {
          type: "object",
          properties: {
            schemaVersion: { type: ["string", "null"] },
            target: { oneOf: [{ type: "null" }, { type: "object" }] },
            file: { type: "string" },
          },
          required: ["schemaVersion", "target"],
          additionalProperties: false,
        },
        summary: {
          type: "object",
          additionalProperties: false,
          properties: {
            addedRoutes: { type: "integer" },
            removedRoutes: { type: "integer" },
            authRegressions: { type: "integer" },
            authImprovements: { type: "integer" },
            newFindings: { type: "integer" },
            resolvedFindings: { type: "integer" },
          },
          required: [
            "addedRoutes",
            "removedRoutes",
            "authRegressions",
            "authImprovements",
            "newFindings",
            "resolvedFindings",
          ],
        },
        addedRoutes: { type: "array", items: { type: "object" } },
        removedRoutes: { type: "array", items: { type: "object" } },
        authRegressions: {
          type: "array",
          description: "Auth changes with route-level middleware/grant causes",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              method: { type: "string" },
              path: { type: "string" },
              from: { type: "string" },
              to: { type: "string" },
              source,
              explanation: { type: "string" },
              changes: { type: "object" },
            },
            required: ["method", "path", "from", "to", "source", "explanation", "changes"],
          },
        },
        authImprovements: {
          type: "array",
          description: "Auth improvements with route-level middleware/grant causes",
          items: { type: "object" },
        },
        newFindings: { type: "array", items: finding },
        resolvedFindings: {
          type: "array",
          description: "Historical finding objects; older baselines may predate current fields",
          items: { type: "object" },
        },
      },
      required: [
        "baseline",
        "summary",
        "addedRoutes",
        "removedRoutes",
        "authRegressions",
        "authImprovements",
        "newFindings",
        "resolvedFindings",
      ],
    },
    findings: { type: "array", items: finding, description: "audit only" },
    diagnostics: {
      type: "array",
      items: { type: "string" },
      description:
        "warnings about incomplete parsing/reads, resolution confidence, policy expiry, and boot behavior",
    },
    scanCoverage: {
      type: "object",
      additionalProperties: false,
      description:
        "Static/hybrid source coverage; complete is false when a file or directory failed",
      properties: {
        discovered: { type: "integer", minimum: 0 },
        analyzed: { type: "integer", minimum: 0 },
        failed: { type: "integer", minimum: 0 },
        complete: { type: "boolean" },
      },
      required: ["discovered", "analyzed", "failed", "complete"],
    },
  },
  required: ["schemaVersion", "tool", "command", "mode", "routes", "globalMiddleware"],
  allOf: [
    {
      if: {
        properties: { command: { const: "audit" } },
        required: ["command"],
      },
      // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema conditional keyword
      then: {
        required: ["findings", "summary"],
        properties: {
          routes: {
            type: "array",
            items: {
              type: "object",
              required: ["authStatus", "tags", "roles", "scopes", "authEvidence"],
            },
          },
        },
      },
      else: {
        not: {
          anyOf: [
            { required: ["findings"] },
            { required: ["summary"] },
            { required: ["policies"] },
            { required: ["policyExceptions"] },
          ],
        },
      },
    },
  ],
};

module.exports = { REPORT_SCHEMA };
