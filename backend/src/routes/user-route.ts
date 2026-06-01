import { Router } from "express";
import { deposit, getBalance,getAllPositions,getSinglePosition } from "../controllers/user-controller";
import { authMiddleware } from "../middleware/auth-middleware";

export const spotUserRouter = Router();
spotUserRouter.get("/balance", authMiddleware, getBalance);
spotUserRouter.post("/deposit", authMiddleware, deposit);

export const perpsUserRouter = Router();
perpsUserRouter.get("/balance", authMiddleware, getBalance);
perpsUserRouter.get("/position/:market", authMiddleware, getSinglePosition);
perpsUserRouter.get("/positions/", authMiddleware, getAllPositions);
