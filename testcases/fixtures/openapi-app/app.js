"use strict";

const express = require("express");
const { getUser } = require("./controllers");
const controllers = require("./controllers"); // member-expression handler form
const { render } = require("cowsay"); // bare package: stays unresolved (opaque handler)

const app = express();
app.use(express.json());

function requireAuth(req, res, next) {
  next();
}

// inline arrow: query reads + object-literal json response
app.get("/items", (req, res) => {
  const status = req.query.status;
  const limit = req.query.limit;
  res.json({ items: [], total: 0, status, limit });
});

// path param + object response
app.get("/items/:id", (req, res) => {
  res.json({ id: req.params.id, name: "widget" });
});

// destructured body + 201 status
app.post("/items", requireAuth, (req, res) => {
  const { name, price } = req.body;
  res.status(201).json({ id: 1, name, price });
});

// header reads (req.get + req.headers[...])
app.get("/whoami", (req, res) => {
  const key = req.get("x-api-key");
  const auth = req.headers["authorization"];
  res.json({ ok: Boolean(key && auth) });
});

// router.all — answers every verb
app.all("/wild", (req, res) => {
  res.send("anything");
});

// imported controller (cross-file resolution)
app.get("/users/:id", getUser);

// member-expression handler (cross-file resolution via dotted callee)
app.get("/members/:id", controllers.getUser);

// handler from a bare package — cannot be resolved statically
app.get("/opaque", render);

module.exports = app;
