import { Router } from "express";
import { cancelOrder, getOrder, createOrder } from "../controllers/order-controller";
import { authMiddleware } from "../middleware/auth-middleware";

export const spotOrderRouter = Router();

// orderRouter.use(authMiddleware);

spotOrderRouter.post("/",authMiddleware,createOrder);
spotOrderRouter.post("/cancel",authMiddleware,cancelOrder);
spotOrderRouter.get("/:id",authMiddleware,getOrder);

export const perpsOrderRouter = Router();
perpsOrderRouter.post("/",authMiddleware,createOrder);
perpsOrderRouter.post("/cancel",authMiddleware,cancelOrder);
perpsOrderRouter.get("/:id",authMiddleware,getOrder);
// need to implment this perpsOrderRouter