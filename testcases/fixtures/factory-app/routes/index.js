"use strict";

// Barrel: a factory that returns an object whose values are sub-routers built
// by calling other factory modules. Resolving `routes.auth` requires seeing
// through the factory, the object literal, and the nested factory call.
module.exports = function (controllers) {
  return {
    auth: require("./auth")(controllers),
    open: require("./open")(controllers),
    internal: require("./internal")(controllers),
  };
};
