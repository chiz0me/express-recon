"use strict";

const express = require("express");
const app = express();

app.get("/health", (_req, res) => res.json({ app: "public" }));
app.get("/code-only", (_req, res) => res.json({ source: "inventory" }));

module.exports = app;
