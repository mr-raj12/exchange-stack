// Test using Bun's native WebSocket (no npm ws package)
const URL = "wss://fstream.binance.com/ws/btcusdt@markPrice@1s";

console.log(`[${new Date().toISOString()}] [native WS] connecting to: ${URL}`);

const ws = new WebSocket(URL);

ws.onopen = () => {
  console.log(`[${new Date().toISOString()}] OPEN`);
};

ws.onmessage = (e: MessageEvent) => {
  console.log(`[${new Date().toISOString()}] MESSAGE:`, e.data);
  try {
    const msg = JSON.parse(e.data);
    console.log(`  → mark_price=${msg.p}  symbol=${msg.s}  event=${msg.e}`);
  } catch {}
};

ws.onerror = (e) => {
  console.error(`[${new Date().toISOString()}] ERROR:`, e);
};

ws.onclose = (e: CloseEvent) => {
  console.log(`[${new Date().toISOString()}] CLOSED code=${e.code} reason=${e.reason}`);
};

setTimeout(() => {
  console.log(`[${new Date().toISOString()}] timeout — closing`);
  ws.close();
  process.exit(0);
}, 10000);
