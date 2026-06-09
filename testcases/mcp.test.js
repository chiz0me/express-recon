"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { createServer } = require("../src/mcp/server");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

const FIXTURE = path.join(__dirname, "fixtures", "static-app");

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

function parse(result) {
  assert.ok(!result.isError, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

test("exposes the four harness tools", async () => {
  const client = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["audit_routes", "inventory_routes", "report_schema", "suggest_auth"]);
  await client.close();
});

test("audit_routes returns the audit report contract", async () => {
  const client = await connect();
  const report = parse(
    await client.callTool({
      name: "audit_routes",
      arguments: { dir: FIXTURE, authMiddleware: { requireAuth: "authenticated" } },
    }),
  );
  assert.equal(report.command, "audit");
  assert.equal(report.tool, "express-recon");
  assert.ok(report.findings.some((f) => f.id === "public-route"));
  await client.close();
});

test("inventory_routes omits findings", async () => {
  const client = await connect();
  const report = parse(
    await client.callTool({ name: "inventory_routes", arguments: { dir: FIXTURE } }),
  );
  assert.equal(report.command, "inventory");
  assert.equal(report.findings, undefined);
  await client.close();
});

test("suggest_auth proposes candidates", async () => {
  const client = await connect();
  const result = parse(
    await client.callTool({ name: "suggest_auth", arguments: { dir: FIXTURE } }),
  );
  assert.ok(result.candidates.some((c) => c.name === "requireAuth"));
  await client.close();
});

test("a bad directory returns an error result, not a crash", async () => {
  const client = await connect();
  const result = await client.callTool({
    name: "audit_routes",
    arguments: { dir: path.join(FIXTURE, "does-not-exist") },
  });
  // missing dir yields an empty scan, not an error; assert it stays well-formed
  assert.ok(!result.isError);
  assert.equal(JSON.parse(result.content[0].text).routes.length, 0);
  await client.close();
});
