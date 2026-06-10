"use strict";

const router = require("express").Router();

module.exports = function (controllers) {
  // Inline factory-call mount: the sub-router is created and mounted in one
  // expression (`require('./sub')(controllers)`).
  router.use("/sub", require("./sub")(controllers));
  router.get("/ping", (req, res) => res.send("pong"));
  return router;
};
