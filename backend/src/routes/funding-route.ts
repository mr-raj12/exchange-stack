import { Router } from "express";
import { authMiddleware } from "../middleware/auth-middleware.js";
import {
  getFundingRate,
  getFundingHistory,
  getFundingPayments,
} from "../controllers/funding-controller.js";

export const perpsFundingRouter = Router();

perpsFundingRouter.get("/rate/:market", getFundingRate);
perpsFundingRouter.get("/history/:market", getFundingHistory);
perpsFundingRouter.get("/payments/:market", authMiddleware, getFundingPayments);
