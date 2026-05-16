// import dotenv from "dotenv";
// dotenv.config();
// import "dotenv/config";
import Redis from "ioredis";

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL is required!");
}

export const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

redis.on("error", (err) => {
  console.log("redis error:", err.message);
});

redis.on("connect", () => {
  console.log("redis connected");
});

// export default redis; redis in place of {redis} on import