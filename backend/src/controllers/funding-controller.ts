import type { Request, Response } from "express";
import { prisma } from "../db.js";

export async function getFundingRate(req: Request, res: Response): Promise<void> {
  const market = req.params["market"] as string;
  const latest = await prisma.fundingRate.findFirst({
    where: { market },
    orderBy: { settledAt: "desc" },
  });
  if (!latest) {
    res.json({ market, rate: null, message: "no settlement recorded yet" });
    return;
  }
  res.json({
    market,
    rate: latest.rate,
    markPrice: latest.markPrice,
    indexPrice: latest.indexPrice,
    settledAt: latest.settledAt,
    nextFundingAt: new Date(latest.settledAt.getTime() + 8 * 60 * 60 * 1000).toISOString(),
  });
}

export async function getFundingHistory(req: Request, res: Response): Promise<void> {
  const market = req.params["market"] as string;
  const page = Math.max(1, Number(req.query["page"]) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query["limit"]) || 20));
  const data = await prisma.fundingRate.findMany({
    where: { market },
    orderBy: { settledAt: "desc" },
    skip: (page - 1) * limit,
    take: limit,
  });
  res.json({ market, page, limit, data });
}

export async function getFundingPayments(req: Request, res: Response): Promise<void> {
  const market = req.params["market"] as string;
  const userId = req.userId!;
  const page = Math.max(1, Number(req.query["page"]) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query["limit"]) || 20));
  const data = await prisma.fundingPayment.findMany({
    where: { userId, market },
    orderBy: { settledAt: "desc" },
    skip: (page - 1) * limit,
    take: limit,
  });
  res.json({ market, page, limit, data });
}
