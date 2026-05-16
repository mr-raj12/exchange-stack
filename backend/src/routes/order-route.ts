import { Router } from "express";
import { cancelOrder, getOrder, createOrder } from "../controllers/order-controller";
import { authMiddleware } from "../middleware/auth-middleware";

export const orderRouter = Router();

orderRouter.use(authMiddleware);

orderRouter.post("/",createOrder);
orderRouter.post("/cancel",cancelOrder);
orderRouter.get("/:id",getOrder);