import type { Response, Request } from "express";
import { sendToEngine } from "../utils/broker";

export async function getBalance(req: Request, res: Response): Promise<void> {
  try {
    const result = await sendToEngine("get_user_balance", {
      userId: req.userId,
    },req.queue);
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
  if(amount <= 0){
    res.status(400).json({ error: "amount must be positive" });
    return;
  }
  try {
    const result = await sendToEngine("deposit", {
      userId: req.userId,
      asset,
      amount,
    }, req.queue);
    if (result && typeof result === "object" && "error" in result) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
}
export async function getAllPositions(_req:Request, res:Response): Promise<void>{
  res.status(501).json({ error: "not implemented getAllPositions" });
  // throw new Error(`not implemented from getAllPositions`)
}

export async function getSinglePosition(_req:Request, res:Response): Promise<void>{
  res.status(501).json({ error: "not implemented getSinglePosition" });
  // throw new Error(`not implemented from getSinglePosition`)
}