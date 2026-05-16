import "dotenv/config";
import { v4 as uuidv4 } from "uuid";
import { redis } from "./redis.js";
import type {
  EngineRequestType,
  EngineResponse,
} from "../types/engine-messages";

const INCOMING_QUEUE = process.env.INCOMING_QUEUE!;
const BACKEND_QUEUE_ID = process.env.BACKEND_QUEUE_ID!;
const RESPONSE_QUEUE = process.env.RESPONSE_QUEUE!;
const TIMEOUT_MS = Number(process.env.ENGINE_TIMEOUT_MS!) || 30000;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>; // ReturnType: is a built in generic that extracts what a function returns
  // Timeout handle object in node and number in browser
};

const pending = new Map<string, Pending>();

//for <TResponse = unknown> means "The caller can decide what response type this function returns."
// Simple generic example
// function identity<T>(value: T): T {
//   return value;
// }
// If you call:
// identity<string>("hello")
// Then:
// T = string
export async function sendToEngine<TResponse = unknown>(
  type: EngineRequestType,
  data: unknown,
): Promise<TResponse> {
  const correlationId = uuidv4();
  return new Promise<TResponse>((resolve, reject) => { // new Promise = the executor 
    // js hands it 2 function, resolve to fulfill promiss and call reject on fail 
    // here these 2 functions exists as values 
    const timer = setTimeout(() => {
      pending.delete(correlationId);
      reject(new Error("engine timeout"));
    }, TIMEOUT_MS);
    // if nobody defuses ir,removee the entry and reject the Promise with error,

    // REGISTER THE HANDLER BEFORE YOU TRIGGER THE THING IT HANDLES,
    // ATTATCH LISTENERE BEOFRE U START THE WORK
    pending.set(correlationId, {
      resolve: resolve as (v: unknown) => void,
      reject,
      timer,
    });

    redis
      .lpush(
        INCOMING_QUEUE,
        JSON.stringify({
          type,
          data,
          correlationId,
          responseQueue: RESPONSE_QUEUE,
        }),
      )
      .catch((err) => {
        clearTimeout(timer);
        pending.delete(correlationId);
        reject(err);
      });
  });
}

export async function startResponseLoop(): Promise<void> {
  console.log(`backend listening for responses on ${RESPONSE_QUEUE}`);
  while (true) {
    try {
      const result = await redis.brpop(RESPONSE_QUEUE, 1);
      // result = [qname,value] or NULL
      if (!result) continue;

      const [, raw] = result; // array destructing , the leading comma skips 0th element and binds element 1 to raw
      const message = JSON.parse(raw) as EngineResponse;
      const handler = pending.get(message.correlationId);
      if (!handler) {
        console.warn(
          `response with unknown correlationId: ${message.correlationId}`,
        );
        continue;
      }
      clearTimeout(handler.timer);
      pending.delete(message.correlationId);
      handler.resolve(message.payload);
    } catch (err) {
      console.log("response loop error:", err);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// sync = do one thing completely first, then move to next line
//async = start the operation, do block the thread while waiting 

// async function test(){
//     throw new Error("boom");
// }

// Actually equivalent hota h:

// function test(){
//     return Promise.reject(new Error("boom"));
// }

// Isliye async function me throw automatically rejected promise ban jata h.