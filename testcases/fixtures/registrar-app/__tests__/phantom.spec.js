"use strict";

// A test-only app: its routes must not appear in a default inventory.
const express = require("express");
const app = express();
app.get("/phantom", (req, res) => res.send("never shipped"));

module.exports = app;
