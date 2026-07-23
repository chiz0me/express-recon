"use strict";

const express = require("express");

const app = express();
app.get("/timer", (_req, res) => res.send("ok"));
setInterval(() => {}, 60_000);

module.exports = app;
