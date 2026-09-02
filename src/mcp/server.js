#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
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
  discover,
  reconcileDocumentation,
  createMiddlewareReview,
  applyMiddlewareAssessments,
  refreshDocumentation,
} = require("../index");
const { defaultRefreshOutput, readRefreshDefaults } = require("../refresh");
const { pathPattern, todayUtc } = require("../policies");
const { loadPackageInfo } = require("../static/resolve");
const pkg = require("../../package.json");

const MAX_REFRESH_QUERY_ITEM_BYTES = 16 * 1024;
const MAX_REFRESH_QUERY_PAGE_BYTES = 128 * 1024;
const MAX_REFRESH_QUERY_NODES = 250;
const stringList = z.array(z.string());
const matchInput = z.object({
  applicationIds: stringList.optional(),
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
const acceptedPublicInput = z
  .array(
    z.union([
      z.string(),
      z.object({ applicationId: z.string(), method: z.string(), path: z.string() }),
    ]),
  )
  .optional()
  .describe(
    "Reviewed public routes. 'METHOD /path' applies across apps; {applicationId, method, path} targets one app.",
  );

const middlewareAssessmentInput = z
  .object({
    schemaVersion: z.literal("1.0"),
    bundleFingerprint: z.string(),
    assessments: z.array(
      z
        .object({
          candidateId: z.string(),
          candidateFingerprint: z.string(),
          classification: z.enum([
            "authentication",
            "authorization",
            "session",
            "api-key",
            "csrf",
            "rate-limit",
            "validation",
            "parsing",
            "logging",
            "observability",
            "cors",
            "security-headers",
            "error-handling",
            "wrapper",
            "business-logic",
            "other",
            "unknown",
          ]),
          enforcement: z.enum(["always", "conditional", "none", "unknown"]),
          confidence: z.enum(["high", "medium", "low"]),
          rationale: z.string(),
          authGrant: z
            .object({
              tags: stringList.optional(),
              roles: stringList.optional(),
              scopes: stringList.optional(),
            })
            .strict()
            .optional(),
          transparentWrapper: z.boolean().optional(),
        })
        .strict(),
    ),
  })
  .strict();

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
    .describe(
      "Scope file (relative paths use the scan root), or false to disable .express-reconignore",
    ),
  includeTests: z.boolean().optional().describe("Also scan test files/dirs (excluded by default)"),
  includeHidden: z
    .boolean()
    .optional()
    .describe("Also scan hidden directories; .git and generated/vendor directories stay excluded"),
  maxFiles: z.number().int().optional().describe("Maximum source files to analyze"),
  maxFileBytes: z.number().int().optional().describe("Maximum bytes in one source file"),
  maxTotalBytes: z.number().int().optional().describe("Maximum total analyzed source bytes"),
  timeoutMs: z.number().int().optional().describe("Static scan deadline in milliseconds"),
};

function scanOptions({
  includeTests,
  includeHidden,
  include,
  exclude,
  ignoreFile,
  maxFiles,
  maxFileBytes,
  maxTotalBytes,
  timeoutMs,
}) {
  return {
    includeTests,
    includeHidden,
    include,
    exclude,
    ignoreFile,
    maxFiles,
    maxFileBytes,
    maxTotalBytes,
    timeoutMs,
  };
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

function resolveWithinDir(root, value) {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function containedBy(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function refreshInvocation(root, args) {
  let ignoreFile = args.ignoreFile ?? null;
  let externalIgnoreFile = false;
  if (typeof ignoreFile === "string") {
    const resolved = resolveWithinDir(root, ignoreFile);
    if (containedBy(root, resolved)) {
      ignoreFile = path.relative(root, resolved).split(path.sep).join("/");
    } else {
      ignoreFile = null;
      externalIgnoreFile = true;
    }
  }
  return {
    config: null,
    externalConfig: false,
    include: [...(args.include || [])],
    exclude: [...(args.exclude || [])],
    ignoreFile,
    externalIgnoreFile,
    includeTests: args.includeTests === true,
    includeHidden: args.includeHidden === true,
    render: args.render !== false,
  };
}

function inheritedRefreshArgs(root, output, args) {
  const defaults = readRefreshDefaults(root, output, {
    acceptEnrichment: args.acceptEnrichment,
  });
  const invocation = defaults.invocation;
  const effective = { ...args };
  if (effective.applicationId === undefined) effective.applicationId = defaults.applicationId;
  if (effective.spec === undefined) effective.spec = defaults.spec;
  if (effective.jsdoc === undefined) effective.jsdoc = defaults.jsdoc;
  if (invocation) {
    if (effective.include === undefined) effective.include = invocation.include;
    if (effective.exclude === undefined) effective.exclude = invocation.exclude;
    if (effective.ignoreFile === undefined) {
      if (invocation.externalIgnoreFile) {
        throw new Error("Prior refresh used an external ignore file; provide ignoreFile again");
      }
      effective.ignoreFile = invocation.ignoreFile ?? undefined;
    }
    if (effective.includeTests === undefined) effective.includeTests = invocation.includeTests;
    if (effective.includeHidden === undefined) effective.includeHidden = invocation.includeHidden;
    if (effective.render === undefined) effective.render = invocation.render;
  }
  return { defaults, effective };
}

function refreshOpenApi(args) {
  const root = fs.realpathSync(resolveDir(args.dir));
  const output = args.output ? resolveWithinDir(root, args.output) : defaultRefreshOutput(root);
  const { defaults, effective } = inheritedRefreshArgs(root, output, args);
  const options = scanOptions(effective);
  const report = buildReport(inventory({ mode: "static", src: root, ...options }), {
    command: "inventory",
    mode: "static",
    target: loadPackageInfo(root),
    sourceRoot: root,
  });
  const discovery = discover(root, options);
  const documentation = reconcileDocumentation(report, {
    root,
    scan: options,
    discovery,
    applicationId: effective.applicationId,
    spec: effective.spec,
    jsdoc: effective.jsdoc,
  });
  return refreshDocumentation({
    root,
    output,
    routes: report,
    discovery,
    documentation,
    explicitJSDoc: args.jsdoc !== undefined || defaults.jsdoc !== undefined,
    configurationExplicit: false,
    acceptEnrichment: args.acceptEnrichment,
    reviewOperations: args.reviewOperations,
    clearOperations: args.clearOperations,
    clearSchemas: args.clearSchemas,
    render: effective.render,
    invocation: refreshInvocation(root, effective),
  });
}

function readRefreshJson(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > 32 * 1024 * 1024) {
    throw new Error(`Refresh artifact must be a regular JSON file up to 32 MiB: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function generatedOperation(document, key) {
  const separator = key.indexOf(" ");
  if (separator < 1) return null;
  const method = key.slice(0, separator).toLowerCase();
  const pathName = key.slice(separator + 1);
  return document.paths?.[pathName]?.[method] || null;
}

function boundedRefreshText(value, maximum) {
  const text = String(value ?? "");
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function boundedRefreshValue(value, state, depth = 0) {
  if (typeof value === "string") {
    if (value.length > 500) state.truncated = true;
    return boundedRefreshText(value, 500);
  }
  if (value === null || ["boolean", "number"].includes(typeof value)) return value;
  if (depth >= 10 || state.nodes >= MAX_REFRESH_QUERY_NODES) {
    state.truncated = true;
    return "[truncated]";
  }
  state.nodes++;
  if (Array.isArray(value)) {
    if (value.length > 25) state.truncated = true;
    return value.slice(0, 25).map((item) => boundedRefreshValue(item, state, depth + 1));
  }
  if (!value || typeof value !== "object") return null;
  const output = {};
  const entries = Object.entries(value);
  if (entries.length > 40) state.truncated = true;
  for (const [key, child] of entries.slice(0, 40)) {
    Object.defineProperty(output, key, {
      value: boundedRefreshValue(child, state, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
}

function refreshQueryOutline(item) {
  const operation = item.currentOperation;
  const metadata = operation?.["x-express-recon"] || {};
  return {
    ...(item.severity ? { severity: boundedRefreshText(item.severity, 40) } : {}),
    ...(item.kind ? { kind: boundedRefreshText(item.kind, 100) } : {}),
    ...(item.change ? { change: boundedRefreshText(item.change, 40) } : {}),
    ...(item.operation ? { operation: boundedRefreshText(item.operation, 2_000) } : {}),
    ...(item.method ? { method: boundedRefreshText(item.method, 40) } : {}),
    ...(item.path ? { path: boundedRefreshText(item.path, 2_000) } : {}),
    ...(item.schema ? { schema: boundedRefreshText(item.schema, 300) } : {}),
    ...(item.status ? { status: boundedRefreshText(item.status, 40) } : {}),
    ...(item.reason ? { reason: boundedRefreshText(item.reason, 500) } : {}),
    ...(Array.isArray(item.fields)
      ? { fields: item.fields.slice(0, 20).map((field) => boundedRefreshText(field, 100)) }
      : {}),
    ...(Array.isArray(item.changedFields)
      ? {
          changedFields: item.changedFields
            .slice(0, 20)
            .map((field) => boundedRefreshText(field, 100)),
        }
      : {}),
    currentOperation: operation
      ? {
          ...(operation.operationId
            ? { operationId: boundedRefreshText(operation.operationId, 300) }
            : {}),
          ...(operation.summary ? { summary: boundedRefreshText(operation.summary, 500) } : {}),
          parameterCount: Array.isArray(operation.parameters) ? operation.parameters.length : 0,
          responseStatuses: Object.keys(operation.responses || {})
            .slice(0, 50)
            .map((status) => boundedRefreshText(status, 100)),
          "x-express-recon": {
            applicationId:
              metadata.applicationId == null
                ? null
                : boundedRefreshText(metadata.applicationId, 500),
            framework:
              metadata.framework == null ? null : boundedRefreshText(metadata.framework, 100),
            source: boundedRefreshValue(metadata.source ?? null, { nodes: 0, truncated: false }),
            handlerResolved: metadata.handlerResolved ?? null,
            handlerName:
              metadata.handlerName == null ? null : boundedRefreshText(metadata.handlerName, 500),
            handlerSource: boundedRefreshValue(metadata.handlerSource ?? null, {
              nodes: 0,
              truncated: false,
            }),
          },
        }
      : null,
    currentOperationBytes: operation ? Buffer.byteLength(JSON.stringify(operation)) : 0,
    queryTruncated: true,
  };
}

function compactRefreshQueryItem(item, forceOutline = false) {
  if (forceOutline) return refreshQueryOutline(item);
  const state = { nodes: 0, truncated: false };
  const compact = boundedRefreshValue(item, state);
  const bytes = Buffer.byteLength(JSON.stringify(compact));
  if (bytes > MAX_REFRESH_QUERY_ITEM_BYTES) return refreshQueryOutline(item);
  return state.truncated ? { ...compact, queryTruncated: true } : compact;
}

function compactRefreshQueryPage(items) {
  const output = [];
  let bytes = 0;
  let truncated = false;
  for (const item of items) {
    let compact = compactRefreshQueryItem(item);
    let size = Buffer.byteLength(JSON.stringify(compact));
    if (bytes + size > MAX_REFRESH_QUERY_PAGE_BYTES) {
      compact = compactRefreshQueryItem(item, true);
      size = Buffer.byteLength(JSON.stringify(compact));
      truncated = true;
    }
    if (bytes + size > MAX_REFRESH_QUERY_PAGE_BYTES) {
      compact = {
        ...(item.operation
          ? { operation: boundedRefreshText(item.operation, 500) }
          : item.schema
            ? { schema: boundedRefreshText(item.schema, 300) }
            : {}),
        currentOperation: null,
        queryTruncated: true,
      };
      size = Buffer.byteLength(JSON.stringify(compact));
    }
    if (compact.queryTruncated) truncated = true;
    bytes += size;
    output.push(compact);
  }
  return { items: output, truncated };
}

function openApiContractChangeItems(delta) {
  if (delta.baselineAvailable !== true) return [];
  const severityRank = { breaking: 0, review: 1, informational: 2 };
  const detailsFor = (collection, key, value) => collection.filter((item) => item[key] === value);
  const operations = [
    ...delta.removedOperations.map((operation) => ({ change: "removed", ...operation })),
    ...delta.changedOperations.map((operation) => ({ change: "changed", ...operation })),
    ...delta.addedOperations.map((operation) => ({ change: "added", ...operation })),
  ].map((item) => {
    const operation = `${item.method} ${item.path}`;
    const breakingChanges = detailsFor(delta.breakingChanges, "operation", operation);
    const reviewChanges = detailsFor(delta.potentiallyBreakingChanges, "operation", operation);
    return {
      kind: "operation",
      change: item.change,
      severity: breakingChanges.length
        ? "breaking"
        : reviewChanges.length
          ? "review"
          : "informational",
      operation,
      method: item.method,
      path: item.path,
      ...(item.changedFields ? { changedFields: item.changedFields } : {}),
      ...(item.beforeFingerprint ? { beforeFingerprint: item.beforeFingerprint } : {}),
      ...(item.afterFingerprint ? { afterFingerprint: item.afterFingerprint } : {}),
      ...(breakingChanges.length ? { breakingChanges } : {}),
      ...(reviewChanges.length ? { reviewChanges } : {}),
    };
  });
  const schemas = [
    ...delta.removedSchemas.map((name) => ({ change: "removed", name })),
    ...delta.changedSchemas.map((schema) => ({ change: "changed", ...schema })),
    ...delta.addedSchemas.map((name) => ({ change: "added", name })),
  ].map((item) => {
    const breakingChanges = detailsFor(delta.breakingChanges, "schema", item.name);
    const reviewChanges = detailsFor(delta.potentiallyBreakingChanges, "schema", item.name);
    return {
      kind: "schema",
      change: item.change,
      severity: breakingChanges.length
        ? "breaking"
        : reviewChanges.length
          ? "review"
          : "informational",
      schema: item.name,
      ...(item.beforeFingerprint ? { beforeFingerprint: item.beforeFingerprint } : {}),
      ...(item.afterFingerprint ? { afterFingerprint: item.afterFingerprint } : {}),
      ...(breakingChanges.length ? { breakingChanges } : {}),
      ...(reviewChanges.length ? { reviewChanges } : {}),
    };
  });
  return [...operations, ...schemas].sort((left, right) => {
    const risk = severityRank[left.severity] - severityRank[right.severity];
    if (risk) return risk;
    const kind = left.kind.localeCompare(right.kind);
    if (kind) return kind;
    return (left.operation || left.schema).localeCompare(right.operation || right.schema);
  });
}

function queryRefresh(args) {
  const root = fs.realpathSync(resolveDir(args.dir));
  const output = args.output ? resolveWithinDir(root, args.output) : defaultRefreshOutput(root);
  readRefreshDefaults(root, output);
  const report = readRefreshJson(path.join(output, "refresh-report.json"));
  if (args.kind === "summary") {
    return {
      kind: "refresh-summary",
      applicationId: report.applicationId,
      routeChanges: report.routeChanges,
      openapiChanges: report.openapiChanges,
      openapiBaselineAvailable: report.openapiBaselineAvailable,
      enrichment: report.enrichment.summary,
      artifacts: report.artifacts,
    };
  }
  let items;
  if (args.kind === "contract_changes") {
    const delta = readRefreshJson(path.join(output, "openapi-delta.json"));
    items = openApiContractChangeItems(delta);
  } else {
    const generated = readRefreshJson(path.join(output, "openapi.generated.json"));
    const values =
      args.kind === "unreviewed_operations"
        ? report.enrichment.unreviewedOperations.map((operation) => ({ operation }))
        : args.kind === "stale_operations"
          ? report.enrichment.staleOperationDetails
          : report.enrichment.removedOperations.map((operation) => ({ operation }));
    items = values.map((item) => ({
      ...item,
      currentOperation: generatedOperation(generated, item.operation),
    }));
  }
  const offset = decodeCursor(args.cursor, args.kind);
  const limit = args.limit || 10;
  const selected = items.slice(offset, offset + limit);
  const page = compactRefreshQueryPage(selected);
  const nextOffset = offset + selected.length;
  return {
    kind: args.kind,
    total: items.length,
    items: page.items,
    responseTruncated: page.truncated,
    nextCursor: nextOffset < items.length ? encodeCursor(args.kind, nextOffset) : null,
  };
}

function staticAudit(args) {
  const resolved = resolveDir(args.dir);
  const config = {
    authMiddleware: args.authMiddleware || {},
    authWrappers: args.authWrappers || [],
    acceptedPublic: args.acceptedPublic || [],
    policies: args.policies || [],
  };
  const registry = audit(
    {
      mode: "static",
      src: resolved,
      ...scanOptions(args),
    },
    config,
  );
  return buildReport(registry, {
    command: "audit",
    mode: "static",
    target: loadPackageInfo(resolved),
    sourceRoot: resolved,
    config,
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
    if (
      args.applicationIds?.length &&
      (!item.applicationId || !args.applicationIds.includes(item.applicationId))
    ) {
      return false;
    }
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
  acceptedPublic: acceptedPublicInput,
  policies: z.array(policyInput).optional(),
  ...scanInput,
};

function registerTools(server) {
  server.registerTool(
    "discover_repository",
    {
      title: "Discover HTTP applications and API docs",
      description:
        "Statically identify package scopes, separate Express, Fastify, and NestJS applications, high-confidence entries, existing OpenAPI documents, and swagger-jsdoc sources. Never executes target code.",
      inputSchema: {
        dir: z.string().describe("Absolute or cwd-relative repo directory to scan"),
        ...scanInput,
      },
    },
    async (args) => {
      try {
        return jsonResult(discover(resolveDir(args.dir), scanOptions(args)));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "inventory_routes",
    {
      title: "Inventory HTTP routes",
      description:
        "Statically list supported Express, Fastify, and NestJS routes, HTTP methods, lifecycle middleware, and source locations. No security judgment or target-code execution.",
      inputSchema: {
        dir: z.string().describe("Absolute or cwd-relative repo directory to scan"),
        ...scanInput,
      },
    },
    async (args) => {
      try {
        const resolved = resolveDir(args.dir);
        const reg = inventory({
          mode: "static",
          src: resolved,
          ...scanOptions(args),
        });
        return jsonResult(
          buildReport(reg, {
            command: "inventory",
            mode: "static",
            target: loadPackageInfo(resolved),
            sourceRoot: resolved,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "audit_routes",
    {
      title: "Audit HTTP route auth coverage",
      description:
        "Statically classify each route as proven/public/review against an auth-middleware allowlist and return findings (public routes, per-verb auth gaps, opaque middleware). Provide authMiddleware as a map of middleware name or dotted callee (e.g. 'passport.authenticate') to a tag.",
      inputSchema: {
        dir: z.string().describe("Absolute or cwd-relative repo directory to scan"),
        authMiddleware: authMiddlewareInput,
        authWrappers: authWrappersInput,
        acceptedPublic: acceptedPublicInput,
        policies: z
          .array(policyInput)
          .optional()
          .describe(
            "Route policies that require auth or named middleware for matching methods/paths.",
          ),
        ...scanInput,
      },
    },
    async (args) => {
      try {
        const resolved = resolveDir(args.dir);
        const config = {
          authMiddleware: args.authMiddleware || {},
          authWrappers: args.authWrappers || [],
          acceptedPublic: args.acceptedPublic || [],
          policies: args.policies || [],
        };
        const reg = audit(
          {
            mode: "static",
            src: resolved,
            ...scanOptions(args),
          },
          config,
        );
        return jsonResult(
          buildReport(reg, {
            command: "audit",
            mode: "static",
            target: loadPackageInfo(resolved),
            sourceRoot: resolved,
            config,
          }),
        );
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
    async (args) => {
      try {
        return jsonResult(
          suggestAuth(
            inventory({
              mode: "static",
              src: resolveDir(args.dir),
              ...scanOptions(args),
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
        "Statically audit a repo and emit an OpenAPI 3.1 skeleton for supported Express, Fastify, and NestJS routes. Security is emitted only when an auth tag is explicitly mapped to a supplied OpenAPI security scheme; middleware names never imply bearer auth.",
      inputSchema: {
        dir: z.string().describe("Absolute or cwd-relative repo directory to scan"),
        authMiddleware: authMiddlewareInput,
        authWrappers: authWrappersInput,
        securitySchemes: z
          .record(z.string(), z.record(z.string(), z.unknown()))
          .optional()
          .describe("OpenAPI components.securitySchemes objects keyed by component name"),
        securityByTag: z
          .record(z.string(), stringList)
          .optional()
          .describe("Explicit auth classification tag to security-scheme name mapping"),
        ...scanInput,
      },
    },
    async (args) => {
      try {
        const resolved = resolveDir(args.dir);
        const config = {
          authMiddleware: args.authMiddleware || {},
          authWrappers: args.authWrappers || [],
          acceptedPublic: [],
          ...(args.securitySchemes || args.securityByTag
            ? {
                openapi: {
                  securitySchemes: args.securitySchemes || {},
                  securityByTag: args.securityByTag || {},
                },
              }
            : {}),
        };
        const reg = audit(
          {
            mode: "static",
            src: resolved,
            ...scanOptions(args),
          },
          config,
        );
        const report = buildReport(reg, {
          command: "audit",
          mode: "static",
          target: loadPackageInfo(resolved),
          sourceRoot: resolved,
          config,
        });
        return { content: [{ type: "text", text: formatters.openapi.format(report) }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "reconcile_openapi",
    {
      title: "Reconcile OpenAPI, swagger-jsdoc, and route inventory",
      description:
        "Merge a unique/selected OpenAPI 3 document, swagger-jsdoc blocks, and one statically discovered supported application. Authored OpenAPI wins, JSDoc fills gaps, generated inventory fills the rest; returns drift and conflict evidence.",
      inputSchema: {
        dir: z.string().describe("Absolute or cwd-relative repo directory to scan"),
        applicationId: z
          .string()
          .optional()
          .describe("Stable application id from discover_repository; required for multi-app repos"),
        spec: z.string().optional().describe("OpenAPI JSON/YAML path relative to dir"),
        jsdoc: z.array(z.string()).optional().describe("JSDoc source paths relative to dir"),
        ...scanInput,
      },
    },
    async (args) => {
      try {
        const resolved = resolveDir(args.dir);
        const options = scanOptions(args);
        const registry = inventory({ mode: "static", src: resolved, ...options });
        const report = buildReport(registry, {
          command: "inventory",
          mode: "static",
          target: loadPackageInfo(resolved),
          sourceRoot: resolved,
        });
        const discovery = discover(resolved, options);
        return jsonResult(
          reconcileDocumentation(report, {
            root: resolved,
            scan: options,
            discovery,
            applicationId: args.applicationId,
            spec: args.spec,
            jsdoc: args.jsdoc,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "refresh_openapi",
    {
      title: "Refresh a persistent OpenAPI workspace",
      description:
        "Statically rebuild a tool-owned OpenAPI workspace, retain only evidence-compatible reviewed enrichment, compute route/contract changes, and optionally render local HTML. Returns compact artifact paths and counts instead of the full contract.",
      inputSchema: {
        dir: z.string().describe("Absolute or cwd-relative repository directory"),
        output: z
          .string()
          .optional()
          .describe("Absolute or repo-relative state directory; defaults to .express-recon/api"),
        applicationId: z.string().optional().describe("Stable discovered application id"),
        spec: z.string().optional().describe("OpenAPI JSON/YAML path relative to dir"),
        jsdoc: z.array(z.string()).optional().describe("JSDoc source paths relative to dir"),
        acceptEnrichment: z
          .boolean()
          .optional()
          .describe("Explicitly capture allowed edits already made to openapi.json"),
        reviewOperations: z
          .array(z.string())
          .max(500)
          .optional()
          .describe("Current METHOD /path entries to record as reviewed during acceptance"),
        clearOperations: z
          .array(z.string())
          .max(500)
          .optional()
          .describe("Saved METHOD /path enrichment entries to remove during acceptance"),
        clearSchemas: z
          .array(z.string())
          .max(500)
          .optional()
          .describe("Saved component schema enrichment entries to remove during acceptance"),
        render: z.boolean().optional().describe("Build local HTML; saved choice defaults to true"),
        ...scanInput,
      },
    },
    async (args) => {
      try {
        if (
          (args.reviewOperations?.length ||
            args.clearOperations?.length ||
            args.clearSchemas?.length) &&
          !args.acceptEnrichment
        ) {
          throw new Error("Review and clear actions require acceptEnrichment: true");
        }
        return jsonResult(refreshOpenApi(args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "query_refresh",
    {
      title: "Query persistent OpenAPI review work",
      description:
        "Read a validated refresh workspace without rescanning. Returns a compact summary or cursor-paginated unreviewed, stale, removed, or semantic contract-change items with bounded operation projections.",
      inputSchema: {
        dir: z.string().describe("Absolute or cwd-relative repository directory"),
        output: z
          .string()
          .optional()
          .describe("Absolute or repo-relative state directory; defaults to .express-recon/api"),
        kind: z.enum([
          "summary",
          "unreviewed_operations",
          "stale_operations",
          "removed_operations",
          "contract_changes",
        ]),
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().optional(),
      },
    },
    async (args) => {
      try {
        return jsonResult(queryRefresh(args));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "review_middleware",
    {
      title: "Build an advisory middleware review bundle",
      description:
        "Export deterministic, bounded source evidence and a strict provider-neutral assessment schema for middleware classification. Source excerpts are untrusted data; this tool never executes target code and never changes audit classification.",
      inputSchema: {
        dir: z.string().describe("Absolute or cwd-relative repo directory to scan"),
        ...scanInput,
      },
    },
    async (args) => {
      try {
        const resolved = resolveDir(args.dir);
        const options = scanOptions(args);
        const report = buildReport(inventory({ mode: "static", src: resolved, ...options }), {
          command: "inventory",
          mode: "static",
          target: loadPackageInfo(resolved),
          sourceRoot: resolved,
        });
        return jsonResult(createMiddlewareReview(report, { root: resolved, scan: options }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "import_middleware_review",
    {
      title: "Validate an advisory middleware assessment",
      description:
        "Validate a human/model assessment against the exact middleware evidence bundle and emit advisory config suggestions. Fingerprints must match; this never changes config or audit classification.",
      inputSchema: {
        review: z
          .record(z.string(), z.unknown())
          .describe("Exact middleware-review-bundle returned by review_middleware"),
        assessment: middlewareAssessmentInput,
      },
    },
    async ({ review, assessment }) => {
      try {
        return jsonResult(applyMiddlewareAssessments(review, assessment));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "query_audit",
    {
      title: "Query a paginated route security audit",
      description:
        "Return a compact summary or a filtered, cursor-paginated page of routes/findings from a static audit.",
      inputSchema: {
        ...auditConfigInput,
        kind: z.enum(["summary", "routes", "findings"]),
        applicationIds: stringList.optional().describe("Stable application IDs to include"),
        limit: z.number().int().min(1).max(500).optional(),
        cursor: z.string().optional(),
        methods: z
          .array(
            z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "ALL"]),
          )
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
              (item) =>
                item.applicationId === finding.applicationId &&
                item.method === finding.method &&
                item.path === finding.path,
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
      title: "Validate route security policies",
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
