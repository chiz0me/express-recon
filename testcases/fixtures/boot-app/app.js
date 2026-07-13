"use strict";

// A realistic boot: infra clients constructed at import time (none of these
// packages are installed anywhere — the sandbox stubs them before resolution),
// env validation that throws, and a listen() call.
const express = require("express");
const { Pool } = require("pg");
const Redis = require("ioredis");
const infra = require("custom-infra-lib");

if (!process.env.BOOT_SECRET) throw new Error("BOOT_SECRET is required");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL);
redis.on("error", () => {});
infra.init({ region: "local" });

const app = express();

pool
  .connect()
  .then(() => redis.ping())
  .catch(() => process.exit(1));

app.get("/health", (req, res) => res.json({ ok: true }));

const api = express.Router();
api.get("/widgets", (req, res) => res.json([]));
api.post("/widgets", (req, res) => res.status(201).end());
app.use("/api", api);

app.listen(3000, () => {});

module.exports = app;
