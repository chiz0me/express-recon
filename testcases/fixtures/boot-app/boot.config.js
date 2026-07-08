"use strict";

module.exports = {
  boot: {
    env: { BOOT_SECRET: "test-secret" },
    stubModules: ["custom-infra-lib"],
  },
};
