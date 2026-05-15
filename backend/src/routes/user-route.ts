import { Router } from "express";
import { getBalance } from "../controllers/user-controller";
import { authMiddleware } from "../middleware/auth-middleware";

export const userRouter = Router();
userRouter.use(authMiddleware);
userRouter.get("/balance",getBalance);