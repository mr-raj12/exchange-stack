import "dotenv/config";
import { readLatestSnapshot } from "./db-reader.js";
import { writeSnapshotFile } from "./file-writer.js";
import { publishSnapshot } from "./publisher.js";

const MARKETS = (process.env.MARKETS || "BTC_USD,ETH_USD").split(",");
const LIVE_INTERVAL_MS = Number(process.env.LIVE_INTERVAL_MS) || 1_000;
const FILE_INTERVAL_MS = Number(process.env.FILE_INTERVAL_MS) || 900_000;

// Short-interval loop: read latest DB snapshot and push to Redis orderbook channel
// so WS clients get live orderbook updates even when no trades are occurring.
async function liveLoop(): Promise<never> {
  while (true) {
    for (const market of MARKETS) {
      try {
        const snapshot = await readLatestSnapshot(market);
        if (snapshot) await publishSnapshot(market, snapshot);
      } catch (e) {
        console.error(`[poller] live push error for ${market}:`, e);
      }
    }
    await new Promise<void>((r) => setTimeout(r, LIVE_INTERVAL_MS));
  }
}

// Long-interval loop: write timestamped snapshot files to disk for historical analysis.
async function fileLoop(): Promise<never> {
  while (true) {
    for (const market of MARKETS) {
      try {
        const snapshot = await readLatestSnapshot(market);
        if (snapshot) await writeSnapshotFile(market, snapshot);
      } catch (e) {
        console.error(`[poller] file write error for ${market}:`, e);
      }
    }
    await new Promise<void>((r) => setTimeout(r, FILE_INTERVAL_MS));
  }
}

console.log(`[poller] starting — markets: ${MARKETS.join(", ")}  live: ${LIVE_INTERVAL_MS}ms  file: ${FILE_INTERVAL_MS}ms`);

liveLoop().catch((e) => { console.error("[poller] live loop crashed:", e); process.exit(1); });
fileLoop().catch((e) => { console.error("[poller] file loop crashed:", e); process.exit(1); });
