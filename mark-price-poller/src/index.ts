import "dotenv/config";
import WebSocket from "ws";
import { redis } from "./redis.js";
import { MARK_PRICE_STREAM } from "shared";

// binance symbol → internal market name
const MARKETS: Record<string, string> = {
  BTCUSDT: "BTC_USD",
  ETHUSDT: "ETH_USD",
};

function connect(symbol: string): void {
  const market = MARKETS[symbol]!;
  const url = `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@miniTicker`;
  const ws = new WebSocket(url);

  ws.on("open", () => console.log(`[mark-price-poller] connected: ${symbol}`));

  ws.on("message", (data) => {
    void (async () => {
      try {
        const msg = JSON.parse(data.toString()) as { c: string; s: string };
        const price = Number(msg.c);
        if (!price || isNaN(price)) return;

        await redis.xadd(
          MARK_PRICE_STREAM,
          "MAXLEN", "~", "500",
          "*",
          "market", market,
          "price", price.toString(),
          "timestamp", Date.now().toString(),
        );
        console.log(`[mark-price-poller] ${market} = ${price}`);
      } catch (err) {
        console.error(`[mark-price-poller] error (${symbol}):`, err);
      }
    })();
  });

  ws.on("error", (err) =>
    console.error(`[mark-price-poller] ws error (${symbol}):`, err.message),
  );

  ws.on("close", () => {
    console.log(`[mark-price-poller] ${symbol} disconnected, reconnecting in 3s...`);
    setTimeout(() => connect(symbol), 3000);
  });
}

for (const symbol of Object.keys(MARKETS)) {
  connect(symbol);
}
