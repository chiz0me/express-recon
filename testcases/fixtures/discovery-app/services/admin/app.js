"use strict";

const express = require("express");
const admin = express();

admin.get("/health", (_req, res) => res.json({ app: "admin" }));

module.exports = admin;
