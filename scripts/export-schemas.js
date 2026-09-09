"use strict";

// Mechanical snapshot only: src/schema.js remains the native report authority.
const fs = require("node:fs");
const path = require("node:path");
const { REPORT_SCHEMA } = require("../src/schema");
const {
  SOURCE_SCHEMA,
  ORGANIZATION_SCHEMA,
  ORGANIZATION_MANIFEST_SCHEMA,
} = require("../src/saved-state-schema");

for (const [name, schema] of Object.entries({
  "report-v2": REPORT_SCHEMA,
  "workspace-source-v1": SOURCE_SCHEMA,
  "organization-v1": ORGANIZATION_SCHEMA,
  "organization-manifest-v1": ORGANIZATION_MANIFEST_SCHEMA,
})) {
  const file = path.join(__dirname, `../schemas/native/${name}.schema.json`);
  const value = JSON.stringify(schema);
  if (process.argv.includes("--check")) {
    if (
      !fs.existsSync(file) ||
      JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))) !== value
    ) {
      process.stderr.write("Native report schema snapshot is stale; run npm run schemas:export\n");
      process.exitCode = 1;
    }
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(schema, null, 2) + "\n");
  }
}
