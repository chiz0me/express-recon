"use strict";

const express = require("express");
const app = express();

function requireAuth(req, res, next) {
  next();
}
function limiter(req, res, next) {
  next();
}

// Path-scoped guard: proves /admin/* only, not siblings.
app.use("/admin", requireAuth);
app.get("/admin/panel", (req, res) => res.send("ok"));
app.get("/outside", (req, res) => res.send("ok"));

// Array mount path guard: proves /x/* and /y/*.
app.use(["/x", "/y"], requireAuth);
app.get("/x/thing", (req, res) => res.send("ok"));
app.get("/z/thing", (req, res) => res.send("ok"));

// Chained use + chained verb registration.
app.use(limiter).get("/chained", requireAuth, (req, res) => res.send("ok"));

// route().all() guard applies to every verb on the chain.
app
  .route("/config")
  .all(requireAuth)
  .get((req, res) => res.send("cfg"))
  .put((req, res) => res.sendStatus(204));

// Array route paths expand to one route each.
app.get(["/multi-a", "/multi-b"], requireAuth, (req, res) => res.send("ok"));

// Settings getter, not a route.
app.get("view engine");

// Const/concat/template paths resolve statically.
const V1 = "/api" + "/v1";
app.get(V1 + "/const", requireAuth, (req, res) => res.send("ok"));
app.get(`${V1}/tpl`, requireAuth, (req, res) => res.send("ok"));

// Wrapped guard: the allowlist matches through the wrapper call.
function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next);
}
app.get("/wrapped", asyncHandler(requireAuth), (req, res) => res.send("ok"));

// Registration order: a guard use()d after a route must not prove it.
app.get("/late-unguarded", (req, res) => res.send("ok"));
app.use(requireAuth);
app.get("/late-guarded", (req, res) => res.send("ok"));

module.exports = app;
