"use strict";

const express = require("express");
const app = express();

app.get("/private-keep", (_req, res) => res.send("ok"));
module.exports = app;
