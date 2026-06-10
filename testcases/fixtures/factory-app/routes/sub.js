"use strict";

const router = require("express").Router();

module.exports = function () {
  router.get("/info", (req, res) => res.json({ ok: true }));
  return router;
};
