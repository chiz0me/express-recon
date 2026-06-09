#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");

const { inventory, audit, suggestAuth, buildReport, REPORT_SCHEMA } = require("../index");
const pkg = require("../../package.json");

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

function registerTools(server) {
  server.registerTool(
    "inventory_routes",
    {
      title: "Inventory Express routes",
      description:
        "Statically list every Express route, HTTP method, middleware chain, and source file/line under a directory. No security judgment, no code execution.",
      inputSchema: { dir: z.string().describe("Absolute or cwd-relative repo directory to scan") },
    },
    async ({ dir }) => {
      try {
        const reg = inventory({ mode: "static", src: resolveDir(dir) });
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
        authMiddleware: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Map of auth middleware name/callee -> tag. Run suggest_auth to discover candidates.",
          ),
      },
    },
    async ({ dir, authMiddleware }) => {
      try {
        const reg = audit(
          { mode: "static", src: resolveDir(dir) },
          { authMiddleware: authMiddleware || {} },
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
      inputSchema: { dir: z.string().describe("Absolute or cwd-relative repo directory to scan") },
    },
    async ({ dir }) => {
      try {
        return jsonResult(suggestAuth(inventory({ mode: "static", src: resolveDir(dir) })));
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
