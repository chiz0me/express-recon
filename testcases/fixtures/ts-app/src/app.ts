import express from "express";
import { requireAuth } from "@/middleware/auth";
import routes from "@/routes";

const app = express();

app.use(express.json());
app.get("/health", (req, res) => res.send("ok"));
app.get("/me", requireAuth, (req, res) => res.send("me"));
app.use("/api", routes);

export default app;
