"use strict";

// Accepts only one of the two public routes, so --fail-on public still trips.
module.exports = {
  authMiddleware: { requireAuth: "authenticated", "passport.authenticate": "session" },
  acceptedPublic: ["GET /health"],
};
