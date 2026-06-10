"use strict";

// A redis-like client exported directly. Its `.get`/`.set` calls elsewhere look
// like route registrations syntactically but are not Express routes.
const client = {
  get: async (key) => key,
  set: async (key, value) => value,
};

module.exports = client;
