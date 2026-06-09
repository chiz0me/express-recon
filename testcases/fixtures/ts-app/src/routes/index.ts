import { Router } from "express";
import admin from "@/routes/admin";

const router = Router();

router.get("/ping", (req, res) => res.send("pong"));
router.use("/admin", admin);

export default router;
