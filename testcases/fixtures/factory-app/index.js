"use strict";

const express = require("express");
const controllers = require("./controllers");
const routes = require("./routes")(controllers);
const cache = require("./services/cache");

const app = express();

app.use(express.json());
app.get("/health", (req, res) => res.send("ok"));

// Mounts addressed as properties of a barrel object returned by a factory.
app.use("/auth", routes.auth);
app.use("/open", routes.open);
app.use("/internal", routes.internal);

// Not Express routes — method calls on a redis-like client that must NOT be
// mistaken for route registrations.
async function warm() {
  await cache.get("seed");
  await cache.set("seed", 1);
}
warm();

module.exports = app;
