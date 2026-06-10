"use strict";

// A plain middleware function — not a router. Exported directly so it is reached
// the same way a sub-router would be.
module.exports = function requireAuth(req, res, next) {
  if (!req.headers.authorization) return res.sendStatus(401);
  return next();
};
