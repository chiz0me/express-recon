"use strict";

// Registrar pattern: routes registered on a function parameter. Cross-file
// call-site resolution attaches `register`; `unmounted` remains fail-closed
// evidence because no local application invokes it.
function requireAuth(req, res, next) {
  next();
}

exports.unmounted = function unmounted(app) {
  app.get("/unmounted", (req, res) => res.send("unused"));
};

module.exports = function register(app) {
  app.get("/reg/health", (req, res) => res.send("ok"));
  app.post("/reg/users", requireAuth, (req, res) => res.sendStatus(201));
};
