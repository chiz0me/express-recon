"use strict";

const fastify = require("fastify")({ logger: false });

async function protectedRoutes(instance) {
  function requireAuth(_request, reply, _done) {
    reply.code(401).send({ error: "unauthorized" });
  }

  instance.addHook("onRequest", requireAuth);
  instance.get("/secure", async () => ({ secret: true }));
}

fastify.get(
  "/health",
  {
    schema: {
      querystring: {
        type: "object",
        properties: { probe: { type: "string" } },
      },
      response: {
        200: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      },
    },
  },
  async (request) => ({ ok: request.query.probe !== "fail" }),
);
fastify.register(protectedRoutes, { prefix: "/v1" });

module.exports = fastify;
