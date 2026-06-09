"use strict";

const express = require("express");
const router = express.Router();

router.get("/stats", (req, res) => res.send("stats"));
router.delete("/users/:id", requireRole, (req, res) => res.sendStatus(204));
router.route("/config").get(getCfg).put(requireRole, putCfg);

function requireRole(req, res, next) {
  next();
}
function getCfg(req, res) {
  res.send("cfg");
}
function putCfg(req, res) {
  res.sendStatus(204);
}

module.exports = router;
