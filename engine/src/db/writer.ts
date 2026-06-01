import "dotenv/config";
import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import type { SpotOrder } from "../types/spot-exchange-store-types.js";
import type { PerpsOrder, PerpsPosition } from "../types/perps-exchange-store-types.js";
import type { Fill } from "../types/common-types.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const writeQueue: (() => Promise<void>)[] = [];
let flushing = false;

function enqueueWrite(fn: () => Promise<void>): void {
  writeQueue.push(fn);
  if (!flushing) flushWriteQueue();
}

async function flushWriteQueue(): Promise<void> {
  flushing = true;
  while (writeQueue.length > 0) {
    const fn = writeQueue.shift()!;
    try {
      await fn();
    } catch (e) {
      console.error("[db-writer] write error:", e);
    }
  }
  flushing = false;
}

// Upsert an order. Call immediately after creation (status=OPEN) so the row
// exists before any fill references it. Call again after matching to update
// filledQty and status.
export function writeOrder(order: SpotOrder | PerpsOrder, exchange: "SPOT" | "PERPS"): void {
  const o = order as SpotOrder & PerpsOrder;
  enqueueWrite(() =>
    prisma.order.upsert({
      where: { id: o.orderId },
      update: {
        status: o.status,
        filledQty: String(o.filledQuantity),
        avgFillPrice: o.avgPrice > 0 ? String(o.avgPrice) : null,
      },
      create: {
        id: o.orderId,
        userId: o.userId,
        market: o.market,
        side: o.side,
        orderType: o.orderType,
        price: String(o.price),
        quantity: String(o.quantity),
        filledQty: "0",
        status: o.status,
        leverage: o.leverage ?? null,
        reduceOnly: o.reduceOnly ?? false,
        exchange,
      },
    }).then(() => {})
  );
}

// Write two fill rows per trade — one linked to takerOrderId, one to makerOrderId.
// makerSide is the buy/sell side of the resting (maker) order.
export function writeFill(fill: Fill, makerSide: "buy" | "sell"): void {
  enqueueWrite(() =>
    prisma.fill.createMany({
      data: [
        {
          orderId: fill.takerOrderId,
          price: String(fill.price),
          quantity: String(fill.quantity),
          makerSide,
        },
        {
          orderId: fill.makerOrderId,
          price: String(fill.price),
          quantity: String(fill.quantity),
          makerSide,
        },
      ],
    }).then(() => {})
  );
}

// Upsert a position by its positionId. Called from inside updatePositionFromFill
// at every state transition (open, increase, partial close, full close, flip).
export function writePosition(position: PerpsPosition): void {
  enqueueWrite(() =>
    prisma.position.upsert({
      where: { id: position.positionId },
      update: {
        side: position.side,
        quantity: String(position.size),
        entryPrice: String(position.entryPrice),
        liquidationPrice: String(position.liquidationPrice),
        margin: String(position.margin),
        status: position.status,
      },
      create: {
        id: position.positionId,
        userId: position.userId,
        market: position.market,
        side: position.side,
        quantity: String(position.size),
        entryPrice: String(position.entryPrice),
        liquidationPrice: String(position.liquidationPrice),
        margin: String(position.margin),
        leverage: position.leverage,
        status: position.status,
      },
    }).then(() => {})
  );
}

// Snapshot current available + locked for a user/asset after a fill settles.
export function writeBalance(userId: string, asset: string, available: number, locked: number): void {
  enqueueWrite(() =>
    prisma.balance.upsert({
      where: { userId_asset: { userId, asset } },
      update: { available: String(available), locked: String(locked) },
      create: { userId, asset, available: String(available), locked: String(locked) },
    }).then(() => {})
  );
}
