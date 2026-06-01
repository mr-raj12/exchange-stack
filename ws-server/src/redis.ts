import Redis from "ioredis";

export function makeRedisClient(): Redis {
  return new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
}
