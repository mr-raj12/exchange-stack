import fs from "fs/promises";
import path from "path";
import type { SnapshotData } from "./db-reader.js";

const SNAPSHOTS_DIR = path.join(process.cwd(), "snapshots");

export async function writeSnapshotFile(market: string, snapshot: SnapshotData): Promise<void> {
  await fs.mkdir(SNAPSHOTS_DIR, { recursive: true });
  const ts = new Date();
  const h = ts.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  const min = String(ts.getMinutes()).padStart(2, "0");
  const month = ts.toLocaleString("default", { month: "long" });
  const filename = `orderbook_${market}_${ts.getDate()}_${month}_${ts.getFullYear()}_${h12}-${min}${ampm}.txt`;
  const filepath = path.join(SNAPSHOTS_DIR, filename);
  await fs.writeFile(filepath, JSON.stringify(snapshot, null, 2));
  console.log(`[poller] wrote ${filepath}`);
}
