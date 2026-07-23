"use strict";

// Registers a route only inside a Node-style infra callback. The callback gets
// a null error and a chainable inert client, just as route wiring expects.
const express = require("express");
const { Pool } = require("pg");

const app = express();
const pool = new Pool();

pool.connect((err, client) => {
  if (err) throw err;
  client.release();
  app.get("/callback-deferred", (_req, res) => res.end());
});

module.exports = app;
