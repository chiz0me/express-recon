"use strict";

// Registers a route only inside `.then` — proves the CLI drains the microtask
// queue before walking the stack.
const express = require("express");
const { Pool } = require("pg");

const app = express();
const pool = new Pool();

pool.connect().then(() => {
  app.get("/deferred", (req, res) => res.end());
});

module.exports = app;
