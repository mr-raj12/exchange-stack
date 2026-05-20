// import dotenv from "dotenv";
// dotenv.config();
import "dotenv/config";
import { redis } from "./utils/redis";
import type { PerpsEngineRequest, SpotEngineRequest } from "./types/messages";
import { handleEngineRequestForPerps, handleEngineRequestForSpot } from "./handler";

if (!process.env.INCOMING_QUEUE) {
  throw new Error("INCOMING_QUEUE is required!");
}
const INCOMING_QUEUE = process.env.INCOMING_QUEUE;
//backend-to-engine-broker
const SPOT_IQ= "SPOT_"+INCOMING_QUEUE;
const PERPS_IQ= "PERPS_"+INCOMING_QUEUE;


async function main(): Promise<void> {
  console.log("Engine listening on Redis queue", INCOMING_QUEUE);
  while (true) {
    try {
      const result = await redis.brpop(SPOT_IQ, PERPS_IQ, 0);
      if (!result) continue;

      const [queueName, raw] = result; // array desctructing
      const request = JSON.parse(raw) as SpotEngineRequest | PerpsEngineRequest;

      let payload: unknown;
      try {
        if(queueName===SPOT_IQ){
            payload = handleEngineRequestForSpot(request);
        } else if(queueName===PERPS_IQ){
          payload = handleEngineRequestForPerps(request);
        }
      } catch (err) {
        payload = { error: (err as Error).message };
      }
      // respQ= kisme push krna h after processing , incoming msg k body m h
      await redis.lpush(
        request.responseQueue,
        JSON.stringify({
          correlationId: request.correlationId,
          payload,
        }),
      );
    } catch (err) {
      // catch catches any error thown as throw new error("some error") and also any error which is not handled in try block
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


// error call stack ke upar bubble karta rehta hai jab tak koi try/catch na mile. So:
// nestedFunction throws → getUserBalance (no catch) → handleEngineRequest (no catch) → index.ts catch → { error: message } as payload.
// Koi bhi intermediate function mein try/catch nahi chahiye — bas ek top-level catch kaafi hai.