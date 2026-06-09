"use strict";

/** Serialise the report contract. This is the agent/CI-facing artifact. */
function format(report) {
  return JSON.stringify(report, null, 2);
}

module.exports = { format };
