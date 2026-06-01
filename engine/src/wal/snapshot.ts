import { redis } from "../utils/redis";
import { writeEngineSnapshotAwait } from "../db/writer";
import { balanceStore } from "../store/balance-store";
import { spotExchangeStore } from "../store/spot-exchange-store";
import { perpsExchangeStore } from "../store/perps-exchange-store";
import { WAL_STREAM } from "./writer";

const SNAPSHOT_INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS) || 5 * 60_000;

export async function takeSnapshot(): Promise<void> {
  // Read current WAL cursor (last entry ID in the stream) before serializing.
  // Using the cursor as the "watermark" for replay — any WAL entry after this
  // cursor is not yet reflected in the snapshot and will be replayed on restart.
  const lastEntry = (await redis.xrevrange(WAL_STREAM, "+", "-", "COUNT", "1")) as [string, string[]][];
  const walCursor = lastEntry?.[0]?.[0] ?? "0-0";

  const state = {
    balances: balanceStore.serialize(),
    spot: spotExchangeStore.serialize(),
    perps: perpsExchangeStore.serialize(),
  };

  await writeEngineSnapshotAwait(walCursor, state);
  console.log(`[snapshot] taken walCursor=${walCursor}`);

  // Trim WAL entries that predate the snapshot cursor — they're no longer needed
  // for replay since the snapshot covers all state up to this point.
  // MINID is exclusive: all entries with ID < walCursor are removed.
  if (walCursor !== "0-0") {
    await redis.xtrim(WAL_STREAM, "MINID", "~", walCursor);
  }
}

export function startSnapshotLoop(): void {
  setInterval(
    () => takeSnapshot().catch((e) => console.error("[snapshot] failed:", e)),
    SNAPSHOT_INTERVAL_MS,
  );
  console.log(`[snapshot] loop started every ${SNAPSHOT_INTERVAL_MS}ms`);
}
