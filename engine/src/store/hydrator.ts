import "dotenv/config";
import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { balanceStore } from "./balance-store.js";
import { spotExchangeStore } from "./spot-exchange-store.js";
import { perpsExchangeStore } from "./perps-exchange-store.js";
import type { SpotOrder } from "../types/spot-exchange-store-types.js";
import type { PerpsOrder, PerpsPosition } from "../types/perps-exchange-store-types.js";
import { LIQUIDATION_BOT_USER_ID } from "../constants.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

export async function hydrateFromDB(): Promise<void> {
  console.log("[hydrator] no snapshot found — loading state from DB...");

  // --- Balances ---
  const dbBalances = await prisma.balance.findMany();
  const balanceSnapshot: Record<string, { balance: Record<string, number>; locked: Record<string, number> }> = {};
  for (const b of dbBalances) {
    if (!balanceSnapshot[b.userId]) {
      balanceSnapshot[b.userId] = { balance: {}, locked: {} };
    }
    balanceSnapshot[b.userId]!.balance[b.asset] = Number(b.available);
    balanceSnapshot[b.userId]!.locked[b.asset]  = Number(b.locked);
  }
  balanceStore.restoreFromSnapshot(balanceSnapshot);

  // --- Spot orders ---
  const spotDbOrders = await prisma.order.findMany({
    where: { exchange: "SPOT", status: { in: ["OPEN", "PARTIALLY_FILLED"] } },
    orderBy: { createdAt: "asc" },
  });

  const spotOrders: SpotOrder[] = spotDbOrders.map((o) => ({
    orderId:         o.id,
    userId:          o.userId,
    market:          o.market,
    side:            o.side as SpotOrder["side"],
    price:           Number(o.price),
    quantity:        Number(o.quantity),
    filledQuantity:  Number(o.filledQty),
    orderType:       o.orderType as SpotOrder["orderType"],
    status:          o.status as SpotOrder["status"],
    fills:           [],
    timestamp:       o.createdAt.getTime(),
    avgPrice:        o.avgFillPrice ? Number(o.avgFillPrice) : 0,
  }));

  const spotOrderBooks: Record<string, { bids: SpotOrder[]; asks: SpotOrder[] }> = {};
  for (const order of spotOrders) {
    if (!spotOrderBooks[order.market]) {
      spotOrderBooks[order.market] = { bids: [], asks: [] };
    }
    if (order.side === "buy") {
      spotOrderBooks[order.market]!.bids.push(order);
    } else {
      spotOrderBooks[order.market]!.asks.push(order);
    }
  }
  for (const book of Object.values(spotOrderBooks)) {
    book.bids.sort((a, b) => b.price - a.price || a.timestamp - b.timestamp);
    book.asks.sort((a, b) => a.price - b.price || a.timestamp - b.timestamp);
  }

  spotExchangeStore.restoreFromSnapshot({ orders: spotOrders, orderBooks: spotOrderBooks });

  // --- Perps orders ---
  const perpsDbOrders = await prisma.order.findMany({
    where: { exchange: "PERPS", status: { in: ["OPEN", "PARTIALLY_FILLED"] } },
    orderBy: { createdAt: "asc" },
  });

  const perpsOrders: PerpsOrder[] = perpsDbOrders.map((o) => ({
    orderId:           o.id,
    userId:            o.userId,
    market:            o.market,
    side:              o.side as PerpsOrder["side"],
    price:             Number(o.price),
    // lockedPricePerUnit is not persisted separately — use order price as approximation.
    // This is only reached on first boot (no snapshot yet), so open orders were
    // placed at this price and margin was locked at this price.
    lockedPricePerUnit: Number(o.price),
    quantity:          Number(o.quantity),
    filledQuantity:    Number(o.filledQty),
    orderType:         o.orderType as PerpsOrder["orderType"],
    status:            o.status as PerpsOrder["status"],
    leverage:          o.leverage ?? 1,
    reduceOnly:        o.reduceOnly,
    isLiquidation:     o.userId === LIQUIDATION_BOT_USER_ID,
    fills:             [],
    timestamp:         o.createdAt.getTime(),
    avgPrice:          o.avgFillPrice ? Number(o.avgFillPrice) : 0,
  }));

  const perpsOrderBooks: Record<string, { bids: PerpsOrder[]; asks: PerpsOrder[] }> = {};
  for (const order of perpsOrders) {
    if (!perpsOrderBooks[order.market]) {
      perpsOrderBooks[order.market] = { bids: [], asks: [] };
    }
    if (order.side === "buy") {
      perpsOrderBooks[order.market]!.bids.push(order);
    } else {
      perpsOrderBooks[order.market]!.asks.push(order);
    }
  }
  for (const book of Object.values(perpsOrderBooks)) {
    book.bids.sort((a, b) => b.price - a.price || a.timestamp - b.timestamp);
    book.asks.sort((a, b) => a.price - b.price || a.timestamp - b.timestamp);
  }

  // --- Perps positions ---
  const dbPositions = await prisma.position.findMany({ where: { status: "OPEN" } });

  const positions: Record<string, Record<string, PerpsPosition>> = {};
  for (const p of dbPositions) {
    if (!positions[p.market]) positions[p.market] = {};
    positions[p.market]![p.userId] = {
      positionId:       p.id,
      userId:           p.userId,
      market:           p.market,
      side:             p.side as PerpsPosition["side"],
      size:             Number(p.quantity),
      leverage:         p.leverage,
      entryPrice:       Number(p.entryPrice),
      margin:           Number(p.margin),
      liquidationPrice: Number(p.liquidationPrice),
      status:           p.status as PerpsPosition["status"],
      timestamp:        p.createdAt.getTime(),
    };
  }

  perpsExchangeStore.restoreFromSnapshot({
    orders:         perpsOrders,
    orderBooks:     perpsOrderBooks,
    positions,
    lastMarkPrices: {}, // live stream repopulates this on first mark price message
  });

  await prisma.$disconnect();

  console.log(
    `[hydrator] loaded ${dbBalances.length} balances, ` +
    `${spotOrders.length} spot orders, ` +
    `${perpsOrders.length} perps orders, ` +
    `${dbPositions.length} positions`,
  );
}
