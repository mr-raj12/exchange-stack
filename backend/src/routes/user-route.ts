import { Router } from "express";
import { deposit, getBalance } from "../controllers/user-controller";
import { authMiddleware } from "../middleware/auth-middleware";

export const userRouter = Router();
userRouter.get("/balance", authMiddleware, getBalance);
userRouter.post("/deposit", authMiddleware, deposit);
