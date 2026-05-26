import WebSocket from "ws";
import { perpsExchangeStore } from "../store/perps-exchange-store";

export class BinancePriceWs {
  private ws: WebSocket | null = null;

  private readonly url = "wss://fstream.binance.com/ws/btcusdt@markPrice@1s";

  private reconnectTimeout: NodeJS.Timeout | null = null;

  connect() {
    console.log("connecting to binance ws...");

    this.ws = new WebSocket(this.url);

    this.ws.on("open", () => {
      console.log("websocket connected");
    });

    this.ws.on("message", (data) => {
      try {
        // nothing being sent from binance ws, needed to fix this 
        console.log("RAW:", data.toString());
        const msg = JSON.parse(data.toString());
        console.log("received message:", msg);
        const price = Number(msg.p);

        console.log("btc mark price:", price);

        perpsExchangeStore.checkAndLiquidate("BTC_USD", price);
      } catch (err) {
        console.error("message parse error:", err);
      }
    });

    this.ws.on("error", (err) => {
      console.error("websocket error:", err.message);
    });

    this.ws.on("close", () => {
      console.log("websocket closed");

      this.reconnect();
    });
  }

  private reconnect() {
    if (this.reconnectTimeout) {
      return;
    }

    console.log("reconnecting in 3 seconds...");

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;

      this.connect();
    }, 3000);
  }

  disconnect() {
    console.log("disconnecting websocket...");

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.ws?.close();
    this.ws = null;
  }
}


const binancePriceWs = new BinancePriceWs();
binancePriceWs.connect();