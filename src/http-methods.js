"use strict";

/** Concrete verbs representable as OpenAPI Path Item operation fields. */
const OPENAPI_METHODS = Object.freeze([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
]);

/** Node/Express concrete registration methods, including extension/WebDAV verbs. */
const HTTP_METHODS = Object.freeze([
  ...OPENAPI_METHODS,
  "acl",
  "bind",
  "checkout",
  "connect",
  "copy",
  "link",
  "lock",
  "m-search",
  "merge",
  "mkactivity",
  "mkcalendar",
  "mkcol",
  "move",
  "notify",
  "propfind",
  "proppatch",
  "purge",
  "rebind",
  "report",
  "search",
  "source",
  "subscribe",
  "unbind",
  "unlink",
  "unlock",
  "unsubscribe",
]);

/** Express's route-wide registration pseudo-method in addition to concrete verbs. */
const EXPRESS_METHODS = Object.freeze([...HTTP_METHODS, "all"]);
const REPORT_METHODS = Object.freeze([
  ...HTTP_METHODS.map((method) => method.toUpperCase()),
  "ALL",
]);

module.exports = { EXPRESS_METHODS, HTTP_METHODS, OPENAPI_METHODS, REPORT_METHODS };
