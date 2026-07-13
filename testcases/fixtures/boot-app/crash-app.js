"use strict";

// Wires routes, then dies before exporting — the harvest path must still
// recover the two registered routes.
const express = require("express");

const app = express();
app.get("/a", (req, res) => res.end());
app.post("/b", (req, res) => res.end());

throw new Error("db exploded");
