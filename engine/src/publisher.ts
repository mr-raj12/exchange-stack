import Redis from "ioredis";
import type { UserEvent, MarketEvent, OrderbookSnapshotEvent } from "shared";
import { userEventsChannel, orderbookChannel } from "shared";

// Dedicated connection for PUBLISH — the main engine connection is blocked
// inside XREADGROUP for up to 100 ms at a time and cannot be reused here.
const pub = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

pub.on("error", (e: Error) =>
  console.error("[publisher] redis error:", e.message),
);

export function publishUserEvent(userId: string, event: UserEvent): void {
  pub
    .publish(userEventsChannel(userId), JSON.stringify(event))
    .catch((e: unknown) =>
      console.error("[publisher] publishUserEvent error:", e),
    );
}

export function publishMarketEvent(market: string, event: MarketEvent): void {
  pub
    .publish(orderbookChannel(market), JSON.stringify(event))
    .catch((e: unknown) =>
      console.error("[publisher] publishMarketEvent error:", e),
    );
}

export function publishOrderbookSnapshot(
  market: string,
  bids: [string, string][],
  asks: [string, string][],
): void {
  const event: OrderbookSnapshotEvent = {
    type: "orderbook_snapshot",
    market,
    bids,
    asks,
    timestamp: Date.now(),
  };
  pub
    .publish(orderbookChannel(market), JSON.stringify(event))
    .catch((e: unknown) =>
      console.error("[publisher] publishOrderbookSnapshot error:", e),
    );
}
