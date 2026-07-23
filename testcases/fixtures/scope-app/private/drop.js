"use strict";

const express = require("express");
const app = express();

app.get("/private-drop", (_req, res) => res.send("ok"));
module.exports = app;
