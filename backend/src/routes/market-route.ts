import { Router } from "express";
import { getDepth } from "../controllers/market-controller";

export const spotMarketRouter = Router();

spotMarketRouter.get("/:symbol",getDepth);

export const perpsMarketRouter = Router();

perpsMarketRouter.get("/:symbol",getDepth);