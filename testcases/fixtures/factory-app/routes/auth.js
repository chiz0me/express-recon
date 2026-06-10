"use strict";

// `require('express').Router()` inline (no intermediate `express` variable),
// and a factory export that returns the router.
const router = require("express").Router();
const requireAuth = require("../middleware/auth");

module.exports = function (controllers) {
  // Locally-required middleware used in `.use()` — same shape as a mount, but
  // resolves to a function, not a router, so it must stay in the chain.
  router.use("*", requireAuth);
  router.get("/me", (req, res) => res.send(controllers.me));
  router.route("/token").post((req, res) => res.sendStatus(200));
  return router;
};
