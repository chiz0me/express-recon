"use strict";

const express = require("express");
const requireAuth = require("./auth");
const admin = require("./routes/admin");
const passport = require("passport");

const app = express();

app.use(express.json());
app.use(logger);

app.get("/health", (req, res) => res.send("ok"));
app.get("/me", requireAuth, (req, res) => res.send("me"));
app.post("/webhook", passport.authenticate("jwt"), (req, res) => res.sendStatus(200));
app.use("/admin", admin);

function logger(req, res, next) {
  next();
}

module.exports = app;
