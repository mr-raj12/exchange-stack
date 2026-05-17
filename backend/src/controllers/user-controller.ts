import type { Response, Request } from "express";
import { sendToEngine } from "../utils/broker";

export async function getBalance(req: Request, res: Response): Promise<void> {
  try {
    const result = await sendToEngine("get_user_balance", {
      userId: req.userId,
    });
    if (result && typeof result === "object" && "error" in result) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}
export async function deposit(req: Request, res: Response): Promise<void> {
  const { asset, amount } = req.body;
  if (typeof asset !== "string" || typeof amount !== "number") {
    res.status(400).json({ error: "invalid asset or amount" });
    return;
  }
  try {
    const result = await sendToEngine("deposit", {
      userId: req.userId,
      asset,
      amount,
    });
    if (result && typeof result === "object" && "error" in result) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}
