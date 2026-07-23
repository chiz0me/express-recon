#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");

const {
  inventory,
  audit,
  suggestAuth,
  buildReport,
  REPORT_SCHEMA,
  formatters,
  normalizePolicies,
} = require("../index");
const { pathPattern, todayUtc } = require("../policies");
const { loadPackageInfo } = require("../static/resolve");
const pkg = require("../../package.json");

const stringList = z.array(z.string());
const matchInput = z.object({
  methods: stringList.optional(),
  paths: stringList.optional(),
  excludePaths: stringList.optional(),
  authStatuses: z.array(z.enum(["proven", "public", "unknown"])).optional(),
  tags: stringList.optional(),
  roles: stringList.optional(),
  scopes: stringList.optional(),
});
const requirementInput = z.lazy(() =>
  z.object({
    auth: z.literal(true).optional(),
    anyMiddleware: stringList.optional(),
    allMiddleware: stringList.optional(),
    noMiddleware: stringList.optional(),
    middlewareOrder: stringList.optional(),
    anyTag: stringList.optional(),
    allTags: stringList.optional(),
    noTags: stringList.optional(),
    anyRole: stringList.optional(),
    allRoles: stringList.optional(),
    noRoles: stringList.optional(),
    roles: stringList.optional(),
    anyScope: stringList.optional(),
    allScopes: stringList.optional(),
    noScopes: stringList.optional(),
    scopes: stringList.optional(),
    all: z.array(requirementInput).optional(),
    any: z.array(requirementInput).optional(),
    not: requirementInput.optional(),
  }),
);
const policyInput = z.object({
  id: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
    .describe("Stable policy id"),
  description: z.string().optional(),
  severity: z.enum(["high", "medium", "low"]).optional(),
  match: matchInput.optional(),
  require: requirementInput,
  exceptions: z
    .array(
      z.object({
        id: z.string().optional(),
        reason: z.string(),
        expires: z.string(),
        match: matchInput,
      }),
    )
    .optional(),
  message: z.string().optional(),
  recommendation: z.string().optional(),
});
const authGrantInput = z.union([
  z.string(),
  z.object({
    tag: z.string().optional(),
    tags: stringList.optional(),
    roles: stringList.optional(),
    scopes: stringList.optional(),
  }),
]);
const authMiddlewareInput = z
  .record(z.string(), authGrantInput)
  .optional()
  .describe("Map of middleware name/callee to a tag or structured tag/role/scope grant.");
const authWrappersInput = stringList
  .optional()
  .describe(
    "Wrapper callees that unconditionally preserve and execute wrapped middleware, e.g. asyncHandler.",
  );

const scanInput = {
  include: z
    .array(z.string())
    .optional()
    .describe(
      "Root-relative source path globs to include; * stays within a segment and ** crosses",
    ),
  exclude: z.array(z.string()).optional().describe("Root-relative source path globs to exclude"),
  ignoreFile: z
    .union([z.string(), z.literal(false)])
    .optional()
    .describe("Root-relative scope file, or false to disable .express-reconignore"),
  includeTests: z.boolean().optional().describe("Also scan test files/dirs (excluded by default)"),
};

function scanOptions({ includeTests, include, exclude, ignoreFile }) {
  return { includeTests, include, exclude, ignoreFile };
}

/**
 * MCP server exposing the express-recon harness to AI agents.
 *
 * Static mode only: tools parse source files and never execute the target repo.
 * Runtime/hybrid scanning (which `require()`s the app) stays a human-opt-in CLI
 * path, so an agent can't be coerced into running untrusted code.
 */
function jsonResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err) {
  return {
    content: [{ type: "text", text: `express-recon error: ${err.message}` }],
    isError: true,
  };
}

function resolveDir(dir) {
  return path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir);
}

function staticAudit(args) {
  const resolved = resolveDir(args.dir);
  const registry = audit(
    {
      mode: "static",
      src: resolved,
      ...scanOptions(args),
    },
    {
      authMiddleware: args.authMiddleware || {},
      authWrappers: args.authWrappers || [],
      acceptedPublic: args.acceptedPublic || [],
      policies: args.policies || [],
    },
  );
  return buildReport(registry, {
    command: "audit",
    mode: "static",
    target: loadPackageInfo(resolved),
  });
}

function encodeCursor(kind, offset) {
  return Buffer.from(JSON.stringify({ version: 1, kind, offset })).toString("base64url");
}

function decodeCursor(cursor, kind) {
  if (!cursor) return 0;
  let value;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid pagination cursor");
  }
  if (
    value.version !== 1 ||
    value.kind !== kind ||
    !Number.isInteger(value.offset) ||
    value.offset < 0
  ) {
    throw new Error("Pagination cursor does not match this query kind");
  }
  return value.offset;
}

function matchesPath(value, patterns) {
  return !patterns?.length || patterns.some((pattern) => pathPattern(pattern).test(value || ""));
}

function queryItems(report, args) {
  if (args.kind === "summary") {
    return {
      kind: "summary",
      summary: report.summary,
      target: report.target || null,
      diagnostics: report.diagnostics || [],
      scanCoverage: report.scanCoverage || null,
      policyExceptions: report.policyExceptions || [],
    };
  }
  const source = args.kind === "routes" ? report.routes : report.findings;
  const filtered = source.filter((item) => {
    if (args.methods?.length && (!item.method || !args.methods.includes(item.method))) return false;
    if (!matchesPath(item.path, args.paths)) return false;
    if (
      args.kind === "routes" &&
      args.authStatuses?.length &&
      !args.authStatuses.includes(item.authStatus)
    ) {
      return false;
    }
    if (args.kind === "findings") {
      if (args.findingIds?.length && !args.findingIds.includes(item.id)) return false;
      if (args.policyIds?.length && !args.policyIds.includes(item.ruleId)) return false;
      if (args.severities?.length && !args.severities.includes(item.severity)) return false;
    }
    return true;
  });
  const offset = decodeCursor(args.cursor, args.kind);
  const limit = args.limit || 50;
  const items = filtered.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  return {
    kind: args.kind,
    summary: report.summary,
    total: filtered.length,
    items,
    nextCursor: nextOffset < filtered.length ? encodeCursor(args.kind, nextOffset) : null,
  };
}

const auditConfigInput = {
  dir: z.string().describe("Absolute or cwd-relative repo directory to scan"),
  authMiddleware: authMiddlewareInput,
  authWrappers: authWrappersInput,
  acceptedPublic: stringList.optional(),
  policies: z.array(policyInput).optional(),
  ...scanInput,
};

function registerTools(server) {
  server.registerTool(
    "inventory_routes",
    {
      title: "Inventory Express routes",
      description:
        "Statically list every Express route, HTTP method, middleware chain, and source file/line under a directory. No security judgment, no code execution.",
      inputSchema: {
        dir: z.string().describe("Absolute or cwd-relative repo directory to scan"),
        ...scanInput,
      },
    },
    async ({ dir, includeTests, include, exclude, ignoreFile }) => {
      try {
        const reg = inventory({
          mode: "static",
          src: resolveDir(dir),
          ...scanOptions({ includeTests, include, exclude, ignoreFile }),
        });
        return jsonResult(buildReport(reg, { command: "inventory", mode: "static" }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "audit_routes",
    {
      title: "Audit Express route auth coverage",
      description:
        "Statically classify each route as proven/public/review against an auth-middleware allowlist and return findings (public routes, per-verb auth gaps, opaque middleware). Provide authMiddleware as a map of middleware name or dotted callee (e.g. 'passport.authenticate') to a tag.",
      inputSchema: {
        dir: z.string().describe("Absolute or cwd-relative repo directory to scan"),
        authMiddleware: authMiddlewareInput,
        authWrappers: authWrappersInput,
        acceptedPublic: z
          .array(z.string())
          .optional()
          .describe(
            "Baseline of reviewed intentionally-public routes as 'METHOD /path' keys (e.g. 'GET /health'); suppresses their public-route finding.",
          ),
        policies: z
          .array(policyInput)
          .optional()
          .describe(
            "Route policies that require auth or named middleware for matching methods/paths.",
          ),
        ...scanInput,
      },
    },
    async ({
      dir,
      authMiddleware,
      authWrappers,
      acceptedPublic,
      policies,
      includeTests,
      include,
      exclude,
      ignoreFile,
    }) => {
      try {
        const reg = audit(
          {
            mode: "static",
            src: resolveDir(dir),
            ...scanOptions({ includeTests, include, exclude, ignoreFile }),
          },
          {
            authMiddleware: authMiddleware || {},
            authWrappers: authWrappers || [],
            acceptedPublic: acceptedPublic || [],
            policies: policies || [],
          },
        );
        return jsonResult(buildReport(reg, { command: "audit", mode: "static" }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "suggest_auth",
    {
      title: "Suggest auth-middleware allowlist",
      description:
        "Scan a repo and propose auth-middleware allowlist candidates (ranked, likely guards first) to seed the authMiddleware map for audit_routes.",
      inputSchema: {
        dir: z.string().describe("Absolute or cwd-relative repo directory to scan"),
        ...scanInput,
      },
    },
    async ({ dir, includeTests, include, exclude, ignoreFile }) => {
      try {
        return jsonResult(
          suggestAuth(
            inventory({
              mode: "static",
              src: resolveDir(dir),
              ...scanOptions({ includeTests, include, exclude, ignoreFile }),
            }),
          ),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "openapi_spec",
    {
      title: "Generate an OpenAPI 3.1 spec",
      description:
        "Statically audit a repo and emit an OpenAPI 3.1 document (as JSON text) for its Express routes. Paths, methods, path/query/header parameters, request/response placeholders, and per-operation security (from auth classification) are derived deterministically; schema bodies are AI-unrefined placeholders carrying x-express-recon source/auth metadata for an enrichment pass. Provide authMiddleware to populate the security section.",
      inputSchema: {
        dir: z.string().describe("Absolute or cwd-relative repo directory to scan"),
        authMiddleware: authMiddlewareInput,
        authWrappers: authWrappersInput,
        ...scanInput,
      },
    },
    async ({ dir, authMiddleware, authWrappers, includeTests, include, exclude, ignoreFile }) => {
      try {
        const resolved = resolveDir(dir);
        const reg = audit(
          {
            mode: "static",
            src: resolved,
            ...scanOptions({ includeTests, include, exclude, ignoreFile }),
          },
          {
            authMiddleware: authMiddleware || {},
            authWrappers: authWrappers || [],
            acceptedPublic: [],
          },
        );
        const report = buildReport(reg, {
          command: "audit",
          mode: "static",
          target: loadPackageInfo(resolved),
        });
        return { content: [{ type: "text", text: formatters.openapi.format(report) }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "query_audit",
    {
      title: "Query a paginated Express security audit",
      description:
        "Return a compact summary or a filtered, cursor-paginated page of routes/findings from a static audit.",
      inputSchema: {
        ...auditConfigInput,
        kind: z.enum(["summary", "routes", "findings"]),
        limit: z.number().int().min(1).max(500).optional(),
        cursor: z.string().optional(),
        methods: z
          .array(z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ALL"]))
          .optional(),
        paths: stringList.optional().describe("Route path globs"),
        authStatuses: z.array(z.enum(["proven", "public", "unknown"])).optional(),
        findingIds: stringList.optional(),
        policyIds: stringList.optional(),
        severities: z.array(z.enum(["high", "medium", "low"])).optional(),
      },
    },
    async (args) => {
      try {
        return jsonResult(queryItems(staticAudit(args), args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "finding_by_fingerprint",
    {
      title: "Look up one audit finding",
      description:
        "Run a static audit and return the finding and associated route for a stable finding fingerprint.",
      inputSchema: {
        ...auditConfigInput,
        fingerprint: z.string().describe("Stable finding_... fingerprint"),
      },
    },
    async (args) => {
      try {
        const report = staticAudit(args);
        const finding = report.findings.find((item) => item.fingerprint === args.fingerprint);
        if (!finding) return errorResult(new Error(`Finding ${args.fingerprint} was not found`));
        const route = finding.method
          ? report.routes.find(
              (item) => item.method === finding.method && item.path === finding.path,
            ) || null
          : null;
        return jsonResult({ finding, route });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "validate_policies",
    {
      title: "Validate Express security policies",
      description:
        "Validate and normalize policies without scanning a repository or executing target code.",
      inputSchema: {
        policies: z.array(policyInput),
        now: z.string().optional().describe("ISO date used to report expired exceptions"),
      },
    },
    async ({ policies, now }) => {
      try {
        const normalized = normalizePolicies(policies);
        const today = todayUtc(now);
        const expiredExceptions = normalized.flatMap((policy) =>
          policy.exceptions
            .filter((exception) => exception.expires < today)
            .map((exception) => ({
              policyId: policy.id,
              exceptionId: exception.id,
              expired: exception.expires,
            })),
        );
        return jsonResult({ valid: true, policies: normalized, expiredExceptions });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "report_schema",
    {
      title: "Get the report JSON Schema",
      description: "Return the JSON Schema describing the inventory/audit report contract.",
      inputSchema: {},
    },
    async () => jsonResult(REPORT_SCHEMA),
  );
}

function createServer() {
  const server = new McpServer({ name: "express-recon", version: pkg.version });
  registerTools(server);
  return server;
}

async function main() {
  await createServer().connect(new StdioServerTransport());
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`express-recon-mcp failed to start: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { createServer };
