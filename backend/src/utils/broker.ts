import "dotenv/config";
import { v4 as uuidv4 } from "uuid";
import { redis, makeRedisClient } from "./redis.js";
import {
  SPOT_INCOMING_STREAM,
  PERPS_INCOMING_STREAM,
  backendResponseChannel,
} from "shared";
import type { EngineRequestTypes } from "shared";

const BACKEND_ID = process.env.BACKEND_INSTANCE_ID!;
const TIMEOUT_MS = Number(process.env.ENGINE_TIMEOUT_MS) || 30_000;

// Dedicated subscriber connection — must not share with the XADD connection
// because a subscribed Redis client can only run pub/sub commands.
const redisSub = makeRedisClient();

type Pending = {
  resolve: (value: unknown) => void;
  reject:  (err: Error) => void;
  timer:   ReturnType<typeof setTimeout>;
};

const pending = new Map<string, Pending>();

export async function initBroker(): Promise<void> {
  if (!BACKEND_ID) throw new Error("BACKEND_INSTANCE_ID env var is required");
  const channel = backendResponseChannel(BACKEND_ID);
  await redisSub.subscribe(channel);

  redisSub.on("message", (_chan: string, raw: string) => {
    const msg = JSON.parse(raw) as { correlationId: string; payload: unknown };
    const handler = pending.get(msg.correlationId);
    if (!handler) return;
    clearTimeout(handler.timer);
    pending.delete(msg.correlationId);
    handler.resolve(msg.payload);
  });

  console.log(`[broker] subscribed to ${channel}`);
}

export async function sendToEngine<TResponse = unknown>(
  type: EngineRequestTypes,
  data: unknown,
  queue: "SPOT" | "PERPS"
): Promise<TResponse> {
  const correlationId = uuidv4();
  const stream = queue === "SPOT" ? SPOT_INCOMING_STREAM : PERPS_INCOMING_STREAM;

  return new Promise<TResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(correlationId);
      reject(new Error("engine timeout"));
    }, TIMEOUT_MS);

    pending.set(correlationId, { resolve: resolve as (v: unknown) => void, reject, timer });

    console.log(`[broker] send type=${type} stream=${stream} correlationId=${correlationId}`);

    redis.xadd(
      stream,
      "*",
      "payload", JSON.stringify({ type, data, correlationId, backendId: BACKEND_ID })
    ).catch((err) => {
      clearTimeout(timer);
      pending.delete(correlationId);
      reject(err);
    });
  });
}
