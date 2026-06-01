import type { WebSocket } from "ws";
import { subscribeChannel, unsubscribeChannel } from "./redis-sub.js";
import { orderbookChannel } from "shared";
import type { UserEvent, MarketEvent } from "shared";

export function handleMarketConnection(ws: WebSocket): void {
  const subscribed = new Map<
    string,
    (event: UserEvent | MarketEvent) => void
  >();

  ws.on("message", async (raw) => {
    let msg: { type: string; market?: string };
    try {
      msg = JSON.parse(raw.toString()) as { type: string; market?: string };
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (msg.type === "subscribe_market") {
      const market = msg.market;
      if (!market) {
        ws.send(JSON.stringify({ type: "error", message: "market required" }));
        return;
      }
      if (subscribed.has(market)) return;

      const cb = (event: UserEvent | MarketEvent) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
      };
      subscribed.set(market, cb);
      await subscribeChannel(orderbookChannel(market), cb);
      ws.send(JSON.stringify({ type: "subscribed", market }));
      return;
    }

    if (msg.type === "unsubscribe_market") {
      const market = msg.market;
      if (!market) return;
      const cb = subscribed.get(market);
      if (cb) {
        await unsubscribeChannel(orderbookChannel(market), cb).catch(
          console.error,
        );
        subscribed.delete(market);
        ws.send(JSON.stringify({ type: "unsubscribed", market }));
      }
    }
  });

  ws.on("close", async () => {
    for (const [market, cb] of subscribed) {
      await unsubscribeChannel(orderbookChannel(market), cb).catch(
        console.error,
      );
    }
    subscribed.clear();
  });

  ws.on("error", (e) =>
    console.error("[ws-server] market ws error:", e.message),
  );
}
