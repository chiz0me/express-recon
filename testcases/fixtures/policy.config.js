"use strict";

module.exports = {
  policies: [
    {
      id: "health-rate-limit",
      severity: "medium",
      match: { methods: ["GET"], paths: ["/health"] },
      require: { anyMiddleware: ["rateLimit", "slowDown"] },
      recommendation: "Apply the standard public-endpoint rate limiter.",
    },
  ],
};
