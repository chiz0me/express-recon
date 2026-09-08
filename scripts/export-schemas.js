"use strict";

// Mechanical snapshot only: src/schema.js remains the native report authority.
const fs = require("node:fs");
const path = require("node:path");
const { REPORT_SCHEMA } = require("../src/schema");

const file = path.join(__dirname, "../schemas/native/report-v2.schema.json");
const value = JSON.stringify(REPORT_SCHEMA);
if (process.argv.includes("--check")) {
  if (!fs.existsSync(file) || JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))) !== value) {
    process.stderr.write("Native report schema snapshot is stale; run npm run schemas:export\n");
    process.exitCode = 1;
  }
} else {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(REPORT_SCHEMA, null, 2) + "\n");
}
