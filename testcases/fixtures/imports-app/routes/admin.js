"use strict";
const express = require("express");
const requireAuth = require("#mw/auth.js");
const router = express.Router();
router.get("/stats", requireAuth, (req, res) => res.send("stats"));
router.get("/open", (req, res) => res.send("open"));
module.exports = router;
