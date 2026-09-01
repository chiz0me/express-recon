"use strict";

/**
 * Middleware descriptor shape shared by the static and runtime scanners.
 *
 * @typedef {object} Descriptor
 * @property {string} name  Display/match name: an identifier (`requireAuth`),
 *   a dotted callee (`passport.authenticate`), or `"<anonymous>"`.
 * @property {"identifier"|"call"|"anonymous"|"unknown"} kind
 * @property {string} raw  Best-effort source snippet for the audit trail.
 * @property {"middleware"|"hook"|"guard"|"interceptor"|"pipe"|"filter"} [stage]
 *   Framework lifecycle role when the source API makes it explicit.
 */

const ANONYMOUS = "<anonymous>";

/**
 * Build a descriptor, normalising missing fields.
 *
 * @param {Partial<Descriptor>} fields
 * @returns {Descriptor}
 */
function descriptor(fields) {
  const name = fields.name || ANONYMOUS;
  const value = {
    name,
    kind: fields.kind || (name === ANONYMOUS ? "anonymous" : "identifier"),
    raw: fields.raw || name,
  };
  if (fields.stage) value.stage = fields.stage;
  return value;
}

/**
 * True when a descriptor could be hiding auth logic we can't statically prove
 * (an inline function, or a call/identifier not in the auth allowlist). Used to
 * keep such routes out of the "definitely public" bucket.
 */
function isOpaque(desc) {
  return desc.kind === "anonymous" || desc.kind === "unknown";
}

module.exports = { descriptor, isOpaque, ANONYMOUS };
