import "dotenv/config";
import { redis } from "./utils/redis";
import type { PerpsEngineRequest, SpotEngineRequest } from "shared";
import {
  SPOT_INCOMING_STREAM,
  PERPS_INCOMING_STREAM,
  MARK_PRICE_STREAM,
  FUNDING_RATE_STREAM,
  ENGINE_CONSUMER_GROUP,
  ENGINE_CONSUMER_NAME,
  backendResponseChannel,
} from "shared";
import { handleEngineRequestForPerps, handleEngineRequestForSpot } from "./handler";
import { perpsExchangeStore } from "./store/perps-exchange-store";

function fieldsToObject(fields: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]!] = fields[i + 1]!;
  }
  return obj;
}

async function ensureConsumerGroups() {
  for (const stream of [SPOT_INCOMING_STREAM, PERPS_INCOMING_STREAM, MARK_PRICE_STREAM, FUNDING_RATE_STREAM]) {
    try {
      await redis.xgroup("CREATE", stream, ENGINE_CONSUMER_GROUP, "0", "MKSTREAM");
    } catch (e: any) {
      if (!e.message.includes("BUSYGROUP")) throw e;
    }
  }
}

async function processOrderMessage(
  streamName: string,
  msgId: string,
  raw: Record<string, string>,
) {
  const request = JSON.parse(raw["payload"]!) as SpotEngineRequest | PerpsEngineRequest;
  let payload: unknown;
  try {
    if (streamName === SPOT_INCOMING_STREAM) {
      payload = handleEngineRequestForSpot(request);
    } else {
      payload = handleEngineRequestForPerps(request);
    }
  } catch (err) {
    payload = { error: (err as Error).message };
  }

  await redis.publish(
    backendResponseChannel(request.backendId),
    JSON.stringify({ correlationId: request.correlationId, payload }),
  );
  await redis.xack(streamName, ENGINE_CONSUMER_GROUP, msgId);
}

function processMarkPrice(raw: Record<string, string>): void {
  const market = raw["market"];
  const price = Number(raw["price"]);
  if (!market || !price || isNaN(price)) return;
  perpsExchangeStore.updateMarkPrice(market, price);
}

async function drainPending() {
  for (const stream of [SPOT_INCOMING_STREAM, PERPS_INCOMING_STREAM]) {
    const result = (await redis.xreadgroup(
      "GROUP", ENGINE_CONSUMER_GROUP, ENGINE_CONSUMER_NAME,
      "COUNT", "100", "STREAMS", stream, "0",
    )) as [string, [string, string[]][]][] | null;
    if (!result) continue;

    for (const [streamName, messages] of result) {
      for (const [msgId, fields] of messages) {
        const raw = fieldsToObject(fields);
        const idleMs = Date.now() - parseInt(msgId.split("-")[0]!);
        if (idleMs > 60_000) {
          console.warn(`[engine] dead-lettering msgId=${msgId}`);
          await redis.xack(streamName, ENGINE_CONSUMER_GROUP, msgId);
          continue;
        }
        await processOrderMessage(streamName, msgId, raw);
      }
    }
  }
}

async function main(): Promise<void> {
  await ensureConsumerGroups();
  await drainPending();
  console.log("Engine listening on streams...");

  while (true) {
    try {
      const results = (await redis.xreadgroup(
        "GROUP", ENGINE_CONSUMER_GROUP, ENGINE_CONSUMER_NAME,
        "COUNT", "10",
        "BLOCK", "0",
        "STREAMS",
        SPOT_INCOMING_STREAM, PERPS_INCOMING_STREAM, MARK_PRICE_STREAM, FUNDING_RATE_STREAM,
        ">", ">", ">", ">",
      )) as [string, [string, string[]][]][] | null;
      if (!results) continue;

      for (const [streamName, messages] of results) {
        for (const [msgId, fields] of messages) {
          const raw = fieldsToObject(fields);

          if (streamName === MARK_PRICE_STREAM) {
            processMarkPrice(raw);
            await redis.xack(MARK_PRICE_STREAM, ENGINE_CONSUMER_GROUP, msgId);
          } else if (streamName === FUNDING_RATE_STREAM) {
            const market = raw["market"];
            if (market) perpsExchangeStore.settleFunding(market);
            await redis.xack(FUNDING_RATE_STREAM, ENGINE_CONSUMER_GROUP, msgId);
          } else {
            await processOrderMessage(streamName, msgId, raw);
          }
        }
      }
    } catch (err) {
      console.error("engine loop error:", err);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

main().catch((err) => {
  console.error("engine crashed:", err);
  process.exit(1);
});
