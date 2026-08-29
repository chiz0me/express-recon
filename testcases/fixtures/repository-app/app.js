"use strict";

const express = require("express");
const app = express();

function requireAuth(_req, _res, next) {
  next();
}

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/code-only", requireAuth, (_req, res) => res.json({ source: "code" }));

module.exports = app;
