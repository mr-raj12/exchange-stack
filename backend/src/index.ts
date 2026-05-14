import "dotenv/config" // on being loaded , reads .env from current dir and copies values to .env vars
import  express from "express" // express function creates an app : Express Central Object
import { prisma } from "./db.js"; // .js in place of .ts because it is a relative import and they re wirtten with .js becuase ts source is compiled to js 
// .js using ensures the paths remain valid after compilation (avoid runtime module resolution issues)
import { authRouter } from "./routes/auth-router.js";

const app=express(); // // app is a fancy router+middleware pipeline+listener wrapper
const PORT= Number(process.env.PORT) || 3000; // provess.env values are always strings or undefined , Number(undefined) is NaN (not a number)

app.use(express.json()); // global middleware , express.json returns a function that runs on every request = inspcts content type= application/json =parses the body and then the result is sticked to req.body (stricks the result)


app.use("/api/v1/auth",authRouter);


app.get("/health", (_req,res)=>{ // _req is a RS convention meaning i recieve this parameter but won't use it
    res.json({status:"ok"}); // express helper that sets content type to application/json and serializes the object
});

app.get("/db-check", async (_req,res)=>{
    const count = await prisma.user.count();
    console.log(count);
    res.json({users: count});
});

app.listen(PORT,()=>{ // bind the TCP port and start accpeting connections, callback fires once the socket is open  
    console.log(`backend listening @ PORT: ${PORT}`);
});

//express= arrat of middleware functions

// uselibpqcompat=true means use the libpq-compatible connection string format in the database URL 