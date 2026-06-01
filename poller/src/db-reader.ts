import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL! });

pool.on("error", (e: Error) => console.error("[poller] pg pool error:", e.message));

export interface SnapshotData {
  bids: [string, string][];
  asks: [string, string][];
}

export async function readLatestSnapshot(market: string): Promise<SnapshotData | null> {
  const result = await pool.query<{ bids: [string, string][]; asks: [string, string][] }>(
    `SELECT bids, asks FROM "OrderbookSnapshot" WHERE market = $1 ORDER BY "createdAt" DESC LIMIT 1`,
    [market],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { bids: row.bids, asks: row.asks };
}
