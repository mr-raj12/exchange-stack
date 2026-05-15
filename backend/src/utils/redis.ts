import "dotenv/config"
import Redis from "ioredis";


if(!process.env.REDIS_URL){
    throw new Error("REDIS_URL is required");
}

export const redis = new Redis(process.env.REDIS_URL!,{ //  new Redis(url,options)= parse uel opena cnonection and return a client
    maxRetriesPerRequest: null, // disables retry limit
});

redis.on("error",(err)=>{ //error listener 
    console.error("redis error:", err.message);
})

redis.on("connect", ()=>{
    console.log("redis connected!")
});