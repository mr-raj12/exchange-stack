import { makeRedisClient } from "./redis.js";
import type { UserEvent, MarketEvent } from "shared";

const redisSub = makeRedisClient();
redisSub.on("error", (e: Error) =>
  console.error("[redis-sub] error:", e.message),
);

type Callback = (event: UserEvent | MarketEvent) => void;
const listeners = new Map<string, Set<Callback>>();

redisSub.on("message", (channel: string, raw: string) => {
  const cbs = listeners.get(channel);
  if (!cbs) return;
  let event: UserEvent | MarketEvent;
  try {
    event = JSON.parse(raw) as UserEvent | MarketEvent;
  } catch {
    console.error("[redis-sub] bad JSON on", channel);
    return;
  }
  cbs.forEach((cb) => cb(event));
});

export async function subscribeChannel(
  channel: string,
  cb: Callback,
): Promise<void> {
  if (!listeners.has(channel)) {
    listeners.set(channel, new Set());
    await redisSub.subscribe(channel);
  }
  listeners.get(channel)!.add(cb);
}

export async function unsubscribeChannel(
  channel: string,
  cb: Callback,
): Promise<void> {
  const set = listeners.get(channel);
  if (!set) return;
  set.delete(cb);
  if (set.size === 0) {
    listeners.delete(channel);
    await redisSub.unsubscribe(channel);
  }
}
