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
