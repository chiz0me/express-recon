"use strict";

const express = require("express");
const app = express();

setTimeout(() => {
  app.get("/timer-deferred", (_req, res) => res.send("ok"));
}, 20);

module.exports = app;
