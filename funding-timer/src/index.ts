import "dotenv/config";
import { redis } from "./redis.js";
import { FUNDING_RATE_STREAM } from "shared";

const INTERVAL_MS = Number(process.env.FUNDING_INTERVAL_MS) || 8 * 60 * 60 * 1000;
const MARKETS = (process.env.MARKETS || "BTC_USD").split(",").map((m) => m.trim());

async function emitFundingTriggers(): Promise<void> {
  for (const market of MARKETS) {
    await redis.xadd(
      FUNDING_RATE_STREAM,
      "*",
      "type", "funding_trigger",
      "market", market,
      "timestamp", Date.now().toString(),
    );
    console.log(`[funding-timer] emitted trigger for ${market}`);
  }
}

emitFundingTriggers().catch(console.error);
setInterval(() => emitFundingTriggers().catch(console.error), INTERVAL_MS);

console.log(`[funding-timer] started — interval=${INTERVAL_MS}ms markets=${MARKETS.join(",")}`);
