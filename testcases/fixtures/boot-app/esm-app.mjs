import express from "express";

const app = express();
const router = express.Router();
router.get("/route", (_req, res) => res.send("ok"));
app.use("/esm", router);

export default app;
