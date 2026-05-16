// import dotenv from "dotenv";
// dotenv.config();
import "dotenv/config";
import { redis } from "./utils/redis";
import type { EngineRequest } from "./types/messages";
import { handleEngineRequest } from "./handler";

if (!process.env.INCOMING_QUEUE) {
  throw new Error("INCOMING_QUEUE is required!");
}
const INCOMING_QUEUE = process.env.INCOMING_QUEUE;

async function main(): Promise<void> {
  console.log("engine listening on queue ", INCOMING_QUEUE);
  while (true) {
    try {
      const result = await redis.brpop(INCOMING_QUEUE, 0);
      if (!result) continue;

      const [, raw] = result; // array desctructing
      const request = JSON.parse(raw) as EngineRequest;

      let payload: unknown;
      try {
        payload = handleEngineRequest(request);
      } catch (err) {
        payload = { error: (err as Error).message };
      }
      await redis.lpush(
        request.responseQueue,
        JSON.stringify({
          correlationId: request.correlationId,
          payload,
        }),
      );
    } catch (err) {
      console.error("engine loop error:", err);
      setTimeout(() => {}, 1000);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
main().catch((err) => {
  console.error("engine crashed: ", err);
  process.exit(1);
});
