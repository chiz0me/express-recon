"use strict";

const router = require("express").Router();

module.exports = function () {
  router.get("/status", (req, res) => res.send("ok"));
  return router;
};
