"use strict";

const express = require("express");
const app = express();

app.get(
  process.env.EXPRESS_RECON_PARENT_SECRET ? "/parent-env-inherited" : "/parent-env-isolated",
  (_req, res) => res.send("ok"),
);

module.exports = app;
