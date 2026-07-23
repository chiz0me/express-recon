"use strict";

const express = require("express");

const app = express();
for (let i = 0; i < 100; i++) {
  app.get(`/generated-${i}`, (_req, res) => res.send("ok"));
}

module.exports = app;
