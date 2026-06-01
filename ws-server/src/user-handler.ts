import type { WebSocket } from "ws";
import type { IncomingMessage } from "http";
import { verifyToken } from "./auth.js";
import { subscribeChannel, unsubscribeChannel } from "./redis-sub.js";
import { userEventsChannel } from "shared";
import type { UserEvent, MarketEvent } from "shared";

export function handleUserConnection(
  ws: WebSocket,
  _req: IncomingMessage,
): void {
  let userId: string | null = null;
  let redisCb: ((event: UserEvent | MarketEvent) => void) | null = null;

  ws.on("message", async (raw) => {
    let msg: { type: string; token?: string };
    try {
      msg = JSON.parse(raw.toString()) as { type: string; token?: string };
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (msg.type === "auth") {
      if (userId) {
        ws.send(JSON.stringify({ type: "error", message: "Already authenticated" }));
        return;
      }
      try {
        const payload = verifyToken(msg.token ?? "");
        userId = payload.userId;

        redisCb = (event) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
        };
        await subscribeChannel(userEventsChannel(userId), redisCb);

        ws.send(JSON.stringify({ type: "auth_ok", userId }));
        console.log(`[ws-server] user ${userId} authenticated`);
      } catch (e) {
        ws.send(
          JSON.stringify({
            type: "auth_error",
            message: e instanceof Error ? e.message : "Invalid token",
          }),
        );
        ws.close();
      }
      return;
    }

    if (!userId) {
      ws.send(JSON.stringify({ type: "error", message: "Not authenticated" }));
      return;
    }
  });

  ws.on("close", async () => {
    if (userId && redisCb) {
      await unsubscribeChannel(userEventsChannel(userId), redisCb).catch(
        console.error,
      );
      console.log(`[ws-server] user ${userId} disconnected`);
    }
  });

  ws.on("error", (e) => console.error("[ws-server] user ws error:", e.message));
}
