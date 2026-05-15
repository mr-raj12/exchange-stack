import { Router } from "express";
import { getDepth } from "../controllers/market-controller";

export const marketRouter = Router();

marketRouter.get("/depth",getDepth);
