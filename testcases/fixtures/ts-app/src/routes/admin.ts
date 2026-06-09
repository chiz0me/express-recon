import { Router, type Request, type Response } from "express";
import { requireAuth } from "@/middleware/auth";

const router = Router();

router.get("/stats", (req: Request, res: Response) => res.send("stats"));
router.delete("/users/:id", requireAuth, (req: Request, res: Response) => res.sendStatus(204));
router
  .route("/config")
  .get((req: Request, res: Response) => res.send("c"))
  .put(requireAuth, (req: Request, res: Response) => res.sendStatus(204));

export default router;
