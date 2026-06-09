"use strict";

/**
 * Middleware descriptor shape shared by the static and runtime scanners.
 *
 * @typedef {object} Descriptor
 * @property {string} name  Display/match name: an identifier (`requireAuth`),
 *   a dotted callee (`passport.authenticate`), or `"<anonymous>"`.
 * @property {"identifier"|"call"|"anonymous"|"unknown"} kind
 * @property {string} raw  Best-effort source snippet for the audit trail.
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
  return {
    name,
    kind: fields.kind || (name === ANONYMOUS ? "anonymous" : "identifier"),
    raw: fields.raw || name,
  };
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
