import WebSocket from "ws";

// Minimal Binance futures mark-price stream test
// Runs for 10 seconds then exits — no exchange store, no redis, no engine deps
const URL = "wss://fstream.binance.com/ws/btcusdt@markPrice@1s";

console.log(`[${new Date().toISOString()}] connecting to: ${URL}`);

const ws = new WebSocket(URL);

ws.on("open", () => {
  console.log(`[${new Date().toISOString()}] OPEN — waiting for messages...`);
});

ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
  const raw = data.toString();
  console.log(`[${new Date().toISOString()}] MESSAGE raw:`, raw);
  try {
    const msg = JSON.parse(raw);
    console.log(`[${new Date().toISOString()}] parsed: event=${msg.e} mark_price=${msg.p} symbol=${msg.s}`);
  } catch (e) {
    console.error("parse error:", e);
  }
});

ws.on("error", (err) => {
  console.error(`[${new Date().toISOString()}] ERROR:`, err.message);
});

ws.on("close", (code, reason) => {
  console.log(`[${new Date().toISOString()}] CLOSED code=${code} reason=${reason?.toString()}`);
});

// Exit after 10s
setTimeout(() => {
  console.log(`[${new Date().toISOString()}] timeout — closing`);
  ws.close();
  process.exit(0);
}, 10000);
