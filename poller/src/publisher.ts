import { makeRedisClient } from "./redis.js";
import { orderbookChannel } from "shared";
import type { OrderbookSnapshotEvent } from "shared";
import type { SnapshotData } from "./db-reader.js";

const pub = makeRedisClient();
pub.on("error", (e: Error) => console.error("[poller] redis pub error:", e.message));

export async function publishSnapshot(market: string, snapshot: SnapshotData): Promise<void> {
  const event: OrderbookSnapshotEvent = {
    type: "orderbook_snapshot",
    market,
    bids: snapshot.bids,
    asks: snapshot.asks,
    timestamp: Date.now(),
  };
  await pub.publish(orderbookChannel(market), JSON.stringify(event));
}
