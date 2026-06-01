import { redis } from "../utils/redis";
import type { WalEntry } from "shared";

export const WAL_STREAM = "wal_stream";
const WAL_MAXLEN = 10_000_000;

// Append a WAL entry and return the Redis stream ID assigned to it.
// Fire-and-forget callers should chain .catch(console.error).
export async function appendWAL(entry: WalEntry): Promise<string> {
  const id = await redis.xadd(
    WAL_STREAM,
    "MAXLEN", "~", String(WAL_MAXLEN),
    "*",
    "payload", JSON.stringify(entry),
  ) as string;
  return id;
}
