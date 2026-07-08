"use strict";
const express = require("express");
const adminRoutes = require("#routes/admin.js");
const app = express();
app.use("/admin", adminRoutes);
app.get("/health", (req, res) => res.send("ok"));
module.exports = app;
