import "dotenv/config";
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL!, { tls: {} });

const IQ = process.env.INCOMING_QUEUE!;
const RQ = process.env.RESPONSE_QUEUE ?? "response-queue-1";

const keys = [
  `SPOT_${IQ}`,
  `PERPS_${IQ}`,
  `SPOT_${RQ}`,
  `PERPS_${RQ}`,
];

for (const k of keys) {
  const len = await redis.llen(k);
  if (len > 0) {
    await redis.del(k);
    console.log(`deleted ${k} (had ${len} msgs)`);
  } else {
    console.log(`${k} already empty`);
  }
}

await redis.quit();
console.log("done");
