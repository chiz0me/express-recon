"use strict";

// Registrar pattern: routes registered on a function parameter. The host is
// bound at the call site, invisible to per-file static resolution.
function requireAuth(req, res, next) {
  next();
}

module.exports = function register(app) {
  app.get("/reg/health", (req, res) => res.send("ok"));
  app.post("/reg/users", requireAuth, (req, res) => res.sendStatus(201));
};
