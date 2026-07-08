"use strict";

// Dies before any route registration — nothing to harvest, boot must fail
// with the original error.
throw new Error("exploded before express");
