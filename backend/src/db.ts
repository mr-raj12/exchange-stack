import "dotenv/config"
import { PrismaClient } from "./generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL!, // ! = non-null asertion , telling to TS trust me it isn't undefined
});

// export const is single shared instance 
// standard is 1 instance per process
export const prisma = new PrismaClient({
    adapter,
});


// prisma_client((adapter(db_url)))