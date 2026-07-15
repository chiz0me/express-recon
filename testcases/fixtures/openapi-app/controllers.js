"use strict";

// Imported controller — the route file references this via `controllers.getUser`,
// so its request/response reads are recovered by the one-hop cross-file pass.
function getUser(req, res) {
  const id = req.params.id;
  const expand = req.query.expand;
  res.json({ id, email: "a@b.c", expand });
}

module.exports = { getUser };
