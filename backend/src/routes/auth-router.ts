import { Router } from "express";
import { signin, signup } from "../controllers/auth-controller";

export const authRouter = Router();

authRouter.post("/signup",signup);
authRouter.post("/signin",signin);