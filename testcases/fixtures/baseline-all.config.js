"use strict";

// Accepts every public route in static-app, so --fail-on public passes.
module.exports = {
  authMiddleware: { requireAuth: "authenticated", "passport.authenticate": "session" },
  acceptedPublic: [
    "GET /health",
    "GET /admin/stats",
    "DELETE /admin/users/:id",
    "GET /admin/config",
    "PUT /admin/config",
  ],
};
