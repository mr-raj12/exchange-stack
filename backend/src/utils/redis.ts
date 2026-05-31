import "dotenv/config"
import Redis from "ioredis";


if(!process.env.REDIS_URL){
    throw new Error("REDIS_URL is required");
}

export function makeRedisClient() {
  return new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
}

export const redis = makeRedisClient();

redis.on("error",(err)=>{ //error listener 
    console.error("redis error:", err.message);
})

redis.on("connect", ()=>{
    console.log("redis connected!")
});