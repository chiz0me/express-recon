"use strict";

const express = require("express");

const app = express();

function requireAuth(_request, response) {
  response.status(401).json({ error: "unauthorized" });
}

app.get("/health", (request, response) => {
  response.json({ ok: request.query.probe !== "fail" });
});
app.use("/v1", requireAuth);
app.get("/v1/secure", (_request, response) => response.json({ secret: true }));

module.exports = app;
