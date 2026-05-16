# Build This CEX From Scratch — A First-Principles Revision Guide

This document rebuilds the **exact current state** of this repo, file by file, with
the reasoning behind every decision. It exists so you can:

1. Re-type the whole thing from an empty folder and understand *why* each line is there.
2. Revise the concepts (queues, RPC-over-queue, JWT, ORM, validation) on their own.
3. Carry the patterns into future projects.

> This is the boilerplate state: signup works, the engine round-trip works with a
> stub. `signin` and the real matching engine are intentionally left as the
> assignment (see [README.md](README.md) for the spec).

How to use this for revision:

- **First pass:** read Part 0 and Part 5 only (the mental models). Don't type anything.
- **Second pass:** rebuild from Part 3 with the code visible.
- **Third pass:** use Part 7 — rebuild from the checklist *without* looking at the code.

---

## Table of contents

- [Part 0 — The mental model (read this first)](#part-0--the-mental-model)
- [Part 1 — Prerequisites](#part-1--prerequisites)
- [Part 2 — Datastores](#part-2--datastores)
- [Part 3 — Build it, file by file](#part-3--build-it-file-by-file)
 - [3.1 Repo skeleton](#31-repo-skeleton)
 - [3.2 Backend deps, tsconfig, env](#32-backend-deps-tsconfig-env)
 - [3.3 Backend: typed config (`env.ts`)](#33-backend-typed-config-envts)
 - [3.4 Backend: Prisma + Postgres](#34-backend-prisma--postgres)
 - [3.5 Backend: auth (schema, JWT, signup)](#35-backend-auth)
 - [3.6 Backend: the broker (the heart)](#36-backend-the-broker)
 - [3.7 Backend: plumbing (async-handler, express.d.ts, validation)](#37-backend-plumbing)
 - [3.8 Backend: exchange routes](#38-backend-exchange-routes)
 - [3.9 Backend: wiring it together (`index.ts`)](#39-backend-wiring-indexts)
 - [3.10 Engine: the whole worker](#310-engine-the-whole-worker)
- [Part 4 — Run & smoke test](#part-4--run--smoke-test)
- [Part 5 — First-principles cheat sheet](#part-5--first-principles-cheat-sheet)
- [Part 6 — The assignment (what's TODO)](#part-6--the-assignment)
- [Part 7 — Rebuild-from-memory checklist](#part-7--rebuild-from-memory-checklist)

---

## Part 0 — The mental model

### What a CEX is

A **Centralized Exchange** lets users place buy/sell orders; a **matching engine**
pairs buyers with sellers by price. All matching happens in a normal server
process (fast, but you trust the operator) — unlike a blockchain DEX.

### The four jobs, and where each lives

| Job | Lives in | Why there |
|---|---|---|
| HTTP, auth, durable user accounts | **backend** (Express) | stateless, horizontally scalable |
| Order book, balances, matching | **engine** (worker) | single-owner in-RAM state, must be deterministic |
| Carrying messages between them | **Redis** | a queue: one side pushes, the other pops |
| Accounts that survive restarts | **Postgres** | durable, queryable |

### Why two processes instead of one server

1. **The order book lives in RAM.** If matching ran inside Express, concurrent
 HTTP handlers would race on shared memory and corrupt the book.
2. **Matching must be deterministic.** Price-time priority (best price wins, ties
 broken by arrival order) is trivial to guarantee with *one process consuming
 one queue in order*. Add concurrency and you need locks.
3. **They scale differently.** Many stateless backends behind a load balancer;
 exactly one engine per market (it owns the book).

They share **no code**. Their only contract is the JSON shape of messages on Redis.

### How a reply comes back through a one-way queue (RPC-over-queue)

A Redis list with `LPUSH` on one end and `BRPOP` on the other is a FIFO queue —
but one-way. To get a *response* back:

```
backend redis engine
 │ lPush backend-to-engine-broker │
 │ {correlationId, responseQueue, type, payload} │
 ├──────────────────────────────►│ brPop backend-to-engine-... │
 │ ├─────────────────────────────►│
 │ │ lPush <responseQueue> │ (handle)
 │ │ {correlationId, ok, data} │
 │ │◄─────────────────────────────┤
 │ brPop <responseQueue> │ │
 │◄───────────────────────────────┤ │
 │ match correlationId → resolve the awaiting Promise │
```

Two ideas make this work:

- **`correlationId`** — a fresh UUID per request, echoed back unchanged by the
 engine. The backend keeps a `Map<correlationId, {resolve, reject, timeout}>`
 of in-flight requests. When a response arrives, it looks up the id and resolves
 the matching Promise — so the right HTTP handler wakes up. Needed because many
 requests are in flight at once.
- **`responseQueue`** — the backend tells the engine *where* to reply
 (`response-queue-<BACKEND_QUEUE_ID>`). The engine reads this out of each
 message, so it never hardcodes a destination — which is exactly what lets you
 run multiple backend instances against one engine.

### Why state lives where it lives

- **Users → Postgres.** Accounts must survive restarts. Durable, queryable.
- **Order book / balances → engine RAM.** Matching must be microsecond-fast; a DB
 round-trip per order would be ~1000× too slow. Real exchanges snapshot RAM to
 disk periodically; here, the engine is in-memory only (persistence not required).

Hold these four ideas. Everything below is just typing them out.

---

## Part 1 — Prerequisites

- **Git** — `git --version`. Set identity once: `git config --global user.name/email`.
- **Bun** — `curl -fsSL https://bun.sh/install | bash`. Runs `.ts` directly, manages deps.
- **An editor with TypeScript** — VS Code + the Prisma extension.
- **`curl`** + optionally `jq` — for testing the API.
- **(Optional) `redis-cli` / `psql`** — `sudo apt install redis-tools postgresql-client` — handy for poking the datastores directly.

`bun` mental model:
- `bun add x` → installs, writes `package.json` + `bun.lock` (reproducible installs).
- `bun add -d x` → devDependency (tooling/types; not shipped at runtime).
- `bun run src/index.ts` → executes TypeScript directly, no build step.
- `bunx tool` → run a CLI without a global install (like `npx`).

---

## Part 2 — Datastores

The committed `.env.example` files point at **localhost** (Docker-style):

```
DATABASE_URL="postgresql://user:password@localhost:5432/cex"
REDIS_URL="redis://localhost:6379"
```

You have two ways to satisfy those:

**Option A — Docker (local):**
```bash
docker run -d --name cex-pg -p 5432:5432 -e POSTGRES_PASSWORD=password -e POSTGRES_USER=user -e POSTGRES_DB=cex postgres:16
docker run -d --name cex-redis -p 6379:6379 redis:7
```

**Option B — Managed cloud (no local install):**
- **Aiven** → free PostgreSQL. Copy the *Service URI*. Append `&uselibpqcompat=true`
 (see [§3.4](#34-backend-prisma--postgres) for why).
- **Upstash** → free Redis, **eviction OFF** (it's a queue — never evict messages).
 Copy the `rediss://...` URL (the double-`s` = TLS, like `https`).

A connection URL is always `scheme://user:password@host:port/path?params`. Learn
that shape once; every datastore uses it.

> The rest of this guide is datastore-agnostic. Whatever you pick, the two
> `.env` files just need a working `DATABASE_URL` (backend only) and `REDIS_URL`
> (both). `REDIS_URL` and `INCOMING_QUEUE` **must be byte-identical across both
> `.env` files** — that's the contract between the processes.

---

## Part 3 — Build it, file by file

We build in **dependency order**: config → DB → auth → broker → routes → wiring →
engine. Each file: the real code, then the *why*.

### 3.1 Repo skeleton

```bash
mkdir cex-v2-boilercode && cd cex-v2-boilercode
git init -b main
mkdir backend engine
```

Root `.gitignore`:

```gitignore
node_modules/
.env
.env.*
!.env.example
dist/
*.log
.DS_Store
```

`backend/.gitignore` (Prisma generates code here — never commit generated code):

```gitignore
/src/generated/prisma
```

**Why a monorepo with two independent packages and no workspace:** backend and
engine share no source; their only contract is the Redis message shape. In
production they're two separate processes. Independence > DRY for two tiny
packages. **Why ignore `.env`:** it holds secrets, and they differ per machine.
`!.env.example` keeps a committed *template* so the next person knows which keys
exist. **Why ignore generated Prisma code:** it's rebuildable from the schema;
committing it makes every schema change a giant noisy diff.

### 3.2 Backend deps, tsconfig, env

```bash
cd backend && bun init -y && rm index.ts && mkdir src
bun add express cors dotenv zod jsonwebtoken bcryptjs @prisma/client @prisma/adapter-pg pg redis
bun add -d prisma @types/express @types/cors @types/jsonwebtoken @types/pg
```

`package.json` — set exactly one script (matches the repo):

```json
{
 "scripts": { "dev": "bun run src/index.ts" }
}
```

> The repo uses `bun run src/index.ts` (no `--watch`). Bun reloads fast enough on
> manual restart; add `--watch` yourself if you want live reload while developing.

`tsconfig.json` — `bun init` writes a good one. The flags that matter:

```jsonc
{
 "compilerOptions": {
 "strict": true, // every strictness flag on — highest-value setting
 "moduleResolution": "bundler", // resolve imports like a modern bundler
 "verbatimModuleSyntax": true, // forces `import type` for type-only imports
 "noUncheckedIndexedAccess": true, // arr[i] is T | undefined — forces you to handle gaps
 "noFallthroughCasesInSwitch": true,
 "noEmit": true // Bun runs TS; tsc only type-checks
 }
}
```

`backend/.env.example` (committed template):

```
DATABASE_URL="postgresql://user:password@localhost:5432/cex"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="change-me"
PORT=3000
INCOMING_QUEUE="backend-to-engine-broker"
BACKEND_QUEUE_ID=
ENGINE_TIMEOUT_MS=30000
```

Copy it to `backend/.env` and fill real values (cloud users: also append
`&uselibpqcompat=true` to `DATABASE_URL`).

**Library choices, justified:**
- `redis` (node-redis v5), **not** ioredis — what this repo uses. `createClient({url})`,
 `.connect()`, `lPush`, `brPop` → returns `{key, element}` or `null`.
- `bcryptjs` — pure-JS bcrypt; no native compile step (vs `bcrypt`).
- `@prisma/adapter-pg` + `pg` — Prisma's driver-adapter mode: Prisma drives the
 standard `pg` driver instead of bundling its own engine binary.
- `cors` — lets a browser frontend on another origin call this API.

### 3.3 Backend: typed config (`env.ts`)

`src/utils/env.ts`:

```ts
import "dotenv/config";

function readRequiredEnv(name: string): string {
 const value = process.env[name];
 if (!value) throw new Error(`Missing required env variable: ${name}`);
 return value;
}

export const env = {
 port: Number(process.env.PORT ?? "3000"),
 redisUrl: readRequiredEnv("REDIS_URL"),
 jwtSecret: readRequiredEnv("JWT_SECRET"),
 incomingQueue: process.env.INCOMING_QUEUE ?? "backend-to-engine-broker",
 responseQueue: `response-queue-${process.env.BACKEND_QUEUE_ID ?? crypto.randomUUID()}`,
 engineTimeoutMs: Number(process.env.ENGINE_TIMEOUT_MS ?? "30000"),
};
```

**Why a single typed `env` object instead of `process.env.X` scattered everywhere:**

- **Fail fast.** `readRequiredEnv` throws *at startup* if `REDIS_URL`/`JWT_SECRET`
 is missing — not 200 requests later with a confusing `undefined`.
- **Parse once.** `process.env` values are always strings or `undefined`.
 `Number(...)` and the `??` defaults turn them into the right types in one place.
- **`responseQueue` derivation is the key line.** If `BACKEND_QUEUE_ID` is set,
 this backend listens on `response-queue-1` (stable, lets you run multiple
 backends). If unset, it gets a random UUID queue *per boot* — still correct for
 a single instance, just not stable across restarts.
- `import "dotenv/config"` as the very first line: loading the module *reads
 `.env` into `process.env`* as a side effect. Must run before anything reads env.

### 3.4 Backend: Prisma + Postgres

```bash
bunx prisma init
```

`prisma/schema.prisma` — replace contents with:

```prisma
generator client {
 provider = "prisma-client"
 output = "../src/generated/prisma"
}

datasource db {
 provider = "postgresql"
}

model User {
 id String @id @default(uuid())
 username String @unique
 password String
}
```

`src/db.ts`:

```ts
import "dotenv/config";
import { PrismaClient } from "./generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({
 connectionString: process.env.DATABASE_URL!,
});

export const prisma = new PrismaClient({ adapter });
```

Apply the migration:

```bash
bunx prisma migrate dev --name init
```

**First principles:**

- **ORM = the translator** between DB rows (relational) and code objects. Prisma
 is *schema-first*: you declare the schema, it **generates** a fully-typed client.
 Add a column → regenerate → every `user.column` access is typed. One source of
 truth for shape.
- **`provider = "prisma-client"`** (not `prisma-client-js`) is the modern
 generator: emits a standalone client into `output`. **`output` points into
 `src/generated/prisma`** which is gitignored (§3.1) — generated code is not
 source.
- **No `url` in `datasource`** — in driver-adapter mode the *adapter* owns the
 connection. The CLI still reads `DATABASE_URL` from `.env` for migrations.
- **`migrate dev`** diffs the schema vs the live DB, writes a versioned
 `migration.sql` (committed — the canonical record), applies it, regenerates the
 client. Use `migrate deploy` in production (never resets data).
- **Password column stores a bcrypt *hash*, never plaintext** (see next section).
- **The `uselibpqcompat=true` story (cloud Postgres):** recent `pg` made
 `sslmode=require` mean *verify the cert chain*. Aiven uses its own CA, so
 verification fails with `self signed certificate in certificate chain`.
 Appending `&uselibpqcompat=true` restores the old "encrypt but don't verify"
 behavior. Fine for learning; for production, trust the CA properly.
- **One shared `prisma` instance** — each `new PrismaClient()` opens a connection
 pool; one per request would exhaust the DB in seconds.

### 3.5 Backend: auth

`src/types/auth-schema.ts`:

```ts
import { z } from "zod";

export const authSchema = z.object({
 username: z.string().trim().min(1, "username is required"),
 password: z.string().min(1, "password is required"),
});
```

`src/utils/auth.ts`:

```ts
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "./env.js";

export interface TokenPayload {
 userId: string;
}

export function createToken(payload: TokenPayload): string {
 return jwt.sign(payload, env.jwtSecret, { expiresIn: "7d" });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
 const authHeader = req.headers.authorization;
 const token =
 typeof authHeader === "string" && authHeader.startsWith("Bearer ")
 ? authHeader.slice(7)
 : undefined;

 if (!token) {
 res.status(401).json({ error: "Missing auth token" });
 return;
 }

 try {
 const payload = jwt.verify(token, env.jwtSecret) as TokenPayload;
 req.userId = payload.userId;
 next();
 } catch {
 res.status(401).json({ error: "Invalid auth token" });
 }
}
```

`src/controllers/auth-controller.ts`:

```ts
import bcrypt from "bcryptjs";
import type { Request, Response } from "express";
import { prisma } from "../db.js";
import { authSchema } from "../types/auth-schema.js";
import { createToken } from "../utils/auth.js";
import { sendValidationError } from "../utils/validation.js";

export async function signup(req: Request, res: Response): Promise<void> {
 const parsedBody = authSchema.safeParse(req.body);
 if (!parsedBody.success) {
 sendValidationError(res, parsedBody.error);
 return;
 }

 const { username, password } = parsedBody.data;
 const hashedPassword = await bcrypt.hash(password, 10);

 try {
 const user = await prisma.user.create({
 data: { username, password: hashedPassword },
 });

 res.status(201).json({
 token: createToken({ userId: user.id }),
 userId: user.id,
 username: user.username,
 });
 } catch {
 res.status(409).json({ error: "username already exists" });
 }
}

export async function signin(req: Request, res: Response): Promise<void> {
 //TODO: Implement signin logic
}
```

**First principles — three problems, three tools:**

1. **Validate input at the boundary (Zod).** TypeScript types are *erased at
 runtime* — they cannot check `req.body`. Zod is a runtime validator that
 *also* gives you a TS type. `.safeParse()` never throws — it returns
 `{success, data}` or `{success, error}`, forcing you to handle the bad path.
 (Note this repo's schema is permissive — `min(1)`. Real apps want longer
 minimums; the principle is the same.)
2. **Store passwords with a slow, salted hash (bcrypt).** Never plaintext (a DB
 leak = every password leaked). Never plain SHA-256 (too fast — GPUs brute
 billions/sec). `bcrypt.hash(pw, 10)` embeds a random salt and runs 2¹⁰
 stretch rounds (~250 ms). To verify a login you `bcrypt.compare(candidate,
 storedHash)` — that's the `signin` TODO.
3. **Identify users statelessly (JWT).** `jwt.sign({userId}, secret)` produces
 `header.payload.signature`. The signature = HMAC-SHA256 over header+payload
 with the server's secret. `requireAuth` middleware pulls the `Bearer` token,
 `jwt.verify`s it (recomputes signature + checks expiry), and attaches
 `req.userId`. **The payload is base64, not encrypted — never put secrets in
 it.** Stateless = any backend instance verifies any token, no session DB.

**Middleware** = `(req, res, next) => void`. It either responds (short-circuit,
e.g. 401) or calls `next()` to pass control on. **Forgetting `next()` is the #1
middleware bug** — the request hangs forever.

The **bare `catch` in signup is a known footgun**: it reports *every* error as
"409 username already exists" (including a DB outage or the Aiven SSL issue). A
robust version would check Prisma error code `P2002`. The boilerplate keeps it
terse — remember this when something mysteriously says "already exists."

### 3.6 Backend: the broker

This is the architectural centerpiece. Three files.

`src/types/engine.ts` — the contract:

```ts
export type EngineCommandType =
 | "create_order"
 | "get_depth"
 | "get_user_balance"
 | "get_order"
 | "cancel_order";

export interface EngineRequest {
 correlationId: string;
 responseQueue: string;
 type: EngineCommandType;
 payload: Record<string, unknown>;
}

export interface EngineResponse {
 correlationId: string;
 ok: boolean;
 data?: unknown;
 error?: string;
}
```

`src/store/pending-responses.ts` — the in-flight registry:

```ts
import type { EngineResponse } from "../types/engine.js";

interface PendingResponse {
 resolve: (response: EngineResponse) => void;
 reject: (error: Error) => void;
 timeout: ReturnType<typeof setTimeout>;
}

const pendingResponses = new Map<string, PendingResponse>();

export function waitForEngineResponse(
 correlationId: string,
 timeoutMs: number,
): Promise<EngineResponse> {
 return new Promise((resolve, reject) => {
 const timeout = setTimeout(() => {
 pendingResponses.delete(correlationId);
 reject(new Error("Engine response timed out"));
 }, timeoutMs);

 pendingResponses.set(correlationId, { resolve, reject, timeout });
 });
}

export function resolveEngineResponse(response: EngineResponse): void {
 const pending = pendingResponses.get(response.correlationId);
 if (!pending) return;

 clearTimeout(pending.timeout);
 pendingResponses.delete(response.correlationId);
 pending.resolve(response);
}
```

`src/utils/engine-client.ts` — push requests, listen for responses:

```ts
import { createClient } from "redis";
import { env } from "./env.js";
import {
 resolveEngineResponse,
 waitForEngineResponse,
} from "../store/pending-responses.js";
import type {
 EngineCommandType,
 EngineRequest,
 EngineResponse,
} from "../types/engine.js";

const publisher = createClient({ url: env.redisUrl }).on("error", (error) => {
 console.error("Redis publisher error", error);
});

const subscriber = createClient({ url: env.redisUrl }).on("error", (error) => {
 console.error("Redis subscriber error", error);
});

export async function connectRedis(): Promise<void> {
 await Promise.all([publisher.connect(), subscriber.connect()]);
}

export async function pingRedis(): Promise<string> {
 return publisher.ping();
}

export async function sendToEngine(
 type: EngineCommandType,
 payload: Record<string, unknown>,
): Promise<EngineResponse> {
 const correlationId = crypto.randomUUID();
 const responsePromise = waitForEngineResponse(correlationId, env.engineTimeoutMs);

 const message: EngineRequest = {
 correlationId,
 responseQueue: env.responseQueue,
 type,
 payload,
 };

 await publisher.lPush(env.incomingQueue, JSON.stringify(message));
 return responsePromise;
}

export async function listenForEngineResponses(): Promise<void> {
 console.log(`Listening for engine responses on ${env.responseQueue}`);

 for (;;) {
 const response = await subscriber.brPop(env.responseQueue, 0);
 if (!response) continue;

 try {
 const parsedResponse = JSON.parse(response.element) as EngineResponse;
 resolveEngineResponse(parsedResponse);
 } catch (error) {
 console.error("Invalid engine response", error);
 }
 }
}
```

**First principles — this is the part to truly understand:**

- **Why two Redis clients (`publisher` + `subscriber`).** `brPop(queue, 0)` is a
 *blocking* call: it monopolizes its connection until a message arrives. If you
 used one client, every `lPush` would be stuck behind the blocked `brPop`. So:
 one client for non-blocking writes, one parked on the blocking read.
- **`waitForEngineResponse` — the deferred-Promise pattern.** A Promise's
 `resolve`/`reject` are only reachable inside its executor. To resolve a Promise
 *from elsewhere later* (when the response arrives), you stash them in a `Map`
 keyed by `correlationId`. This is *the* canonical async pattern; memorize it.
- **The timeout is the safety belt.** No engine reply → after `engineTimeoutMs`
 the entry is deleted and the Promise rejects. Without it, a dead engine hangs
 HTTP handlers forever and exhausts the server.
- **`sendToEngine` registers the pending entry *before* `lPush`.** `Map.set` is
 synchronous; `lPush` is async. So the entry always exists before the engine
 could possibly reply — no lost-response race.
- **`listenForEngineResponses` is an infinite loop** = the consumer half of a
 long-lived worker. It only exits when the process does. Errors (bad JSON) are
 caught and skipped so one bad message can't kill the loop.
- **Separation of concerns:** `pending-responses.ts` owns the registry,
 `engine-client.ts` owns Redis. Swap Redis for RabbitMQ → only one file changes.

### 3.7 Backend: plumbing

`src/utils/async-handler.ts`:

```ts
import type { NextFunction, Request, RequestHandler, Response } from "express";

export function asyncHandler(
 handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
 return function wrappedHandler(req, res, next) {
 void handler(req, res, next).catch(next);
 };
}
```

`src/types/express.d.ts`:

```ts
declare global {
 namespace Express {
 interface Request {
 userId?: string;
 }
 }
}

export {};
```

`src/utils/validation.ts`:

```ts
import type { Response } from "express";
import type { ZodError } from "zod";

export function sendValidationError(res: Response, error: ZodError): void {
 res.status(400).json({
 error: "validation_error",
 issues: error.issues.map((issue) => ({
 path: issue.path.join("."),
 message: issue.message,
 })),
 });
}
```

**First principles:**

- **`asyncHandler` exists because Express doesn't `await` your handlers.** If an
 `async` handler rejects, the error vanishes — the request hangs, no response.
 Wrapping it with `.catch(next)` forwards the error to Express's error
 middleware (the 4-arg one in `index.ts`). One wrapper, every route protected,
 no `try/catch` boilerplate in controllers.
- **`express.d.ts` is *declaration merging*.** `@types/express` doesn't know
 about `userId`. You can't edit their file — so you *merge* an extra field into
 their `Request` interface. The empty `export {}` makes the file a module
 (required for `declare global`). Now `req.userId` is typed everywhere.
- **`sendValidationError` centralizes the 400 shape.** Every validation failure
 in the app returns the identical structure → the client can rely on it; one
 place to change it.

### 3.8 Backend: exchange routes

`src/types/exchange-schema.ts`:

```ts
import { z } from "zod";

export const symbolParamSchema = z.object({
 symbol: z.string().trim().min(1, "symbol is required"),
});

export const orderIdParamSchema = z.object({
 orderId: z.string().trim().min(1, "orderId is required"),
});

export const orderBodySchema = z.discriminatedUnion("type", [
 z.object({
 type: z.literal("limit"),
 side: z.enum(["buy", "sell"]),
 symbol: z.string().trim().min(1, "symbol is required"),
 price: z.number().positive("limit orders require a positive price"),
 qty: z.number().positive("qty must be a positive number"),
 }),
 z.object({
 type: z.literal("market"),
 side: z.enum(["buy", "sell"]),
 symbol: z.string().trim().min(1, "symbol is required"),
 price: z.null().optional(),
 qty: z.number().positive("qty must be a positive number"),
 }),
]);
```

`src/controllers/exchange-controller.ts`:

```ts
import type { Request, Response } from "express";
import {
 orderBodySchema,
 orderIdParamSchema,
 symbolParamSchema,
} from "../types/exchange-schema.js";
import { sendToEngine } from "../utils/engine-client.js";
import { sendValidationError } from "../utils/validation.js";

function getUserId(req: Request): string {
 if (!req.userId) throw new Error("Missing authenticated user");
 return req.userId;
}

export async function createOrder(req: Request, res: Response): Promise<void> {
 const userId = getUserId(req);

 const parsedBody = orderBodySchema.safeParse(req.body);
 if (!parsedBody.success) {
 sendValidationError(res, parsedBody.error);
 return;
 }

 const { type, side, symbol, qty } = parsedBody.data;
 const price = type === "market" ? null : parsedBody.data.price;

 const engineResponse = await sendToEngine("create_order", {
 userId,
 type,
 side,
 symbol,
 price: type === "market" ? null : price,
 qty,
 });

 res.status(engineResponse.ok ? 200 : 400).json(
 engineResponse.ok ? engineResponse.data : { error: engineResponse.error },
 );
}

export async function getDepth(req: Request, res: Response): Promise<void> {
 const parsedParams = symbolParamSchema.safeParse(req.params);
 if (!parsedParams.success) {
 sendValidationError(res, parsedParams.error);
 return;
 }

 const { symbol } = parsedParams.data;
 const engineResponse = await sendToEngine("get_depth", { symbol });
 res.status(engineResponse.ok ? 200 : 400).json(
 engineResponse.ok ? engineResponse.data : { error: engineResponse.error },
 );
}

export async function getBalance(req: Request, res: Response): Promise<void> {
 const engineResponse = await sendToEngine("get_user_balance", {
 userId: getUserId(req),
 });

 res.status(engineResponse.ok ? 200 : 400).json(
 engineResponse.ok ? engineResponse.data : { error: engineResponse.error },
 );
}

export async function getOrder(req: Request, res: Response): Promise<void> {
 const parsedParams = orderIdParamSchema.safeParse(req.params);
 if (!parsedParams.success) {
 sendValidationError(res, parsedParams.error);
 return;
 }

 const { orderId } = parsedParams.data;
 const engineResponse = await sendToEngine("get_order", {
 userId: getUserId(req),
 orderId,
 });

 res.status(engineResponse.ok ? 200 : 404).json(
 engineResponse.ok ? engineResponse.data : { error: engineResponse.error },
 );
}

export async function cancelOrder(req: Request, res: Response): Promise<void> {
 const parsedParams = orderIdParamSchema.safeParse(req.params);
 if (!parsedParams.success) {
 sendValidationError(res, parsedParams.error);
 return;
 }

 const { orderId } = parsedParams.data;
 const engineResponse = await sendToEngine("cancel_order", {
 userId: getUserId(req),
 orderId,
 });

 res.status(engineResponse.ok ? 200 : 400).json(
 engineResponse.ok ? engineResponse.data : { error: engineResponse.error },
 );
}
```

`src/routes/auth-routes.ts`:

```ts
import { Router } from "express";
import { signin, signup } from "../controllers/auth-controller.js";
import { asyncHandler } from "../utils/async-handler.js";

export const authRouter = Router();

authRouter.post("/signup", asyncHandler(signup));
authRouter.post("/signin", asyncHandler(signin));
```

`src/routes/exchange-routes.ts`:

```ts
import { Router } from "express";
import {
 cancelOrder,
 createOrder,
 getBalance,
 getDepth,
 getOrder,
} from "../controllers/exchange-controller.js";
import { requireAuth } from "../utils/auth.js";
import { asyncHandler } from "../utils/async-handler.js";

export const exchangeRouter = Router();

exchangeRouter.post("/order", requireAuth, asyncHandler(createOrder));
exchangeRouter.get("/depth/:symbol", requireAuth, asyncHandler(getDepth));
exchangeRouter.get("/balance", requireAuth, asyncHandler(getBalance));
exchangeRouter.get("/order/:orderId", requireAuth, asyncHandler(getOrder));
exchangeRouter.delete("/order/:orderId", requireAuth, asyncHandler(cancelOrder));
```

`src/routes/index.ts`:

```ts
import { Router } from "express";
import { authRouter } from "./auth-routes.js";
import { exchangeRouter } from "./exchange-routes.js";

export const appRouter = Router();

appRouter.use(authRouter);
appRouter.use(exchangeRouter);
```

**First principles:**

- **`z.discriminatedUnion("type", [...])`** is the standout pattern. An order is
 *either* a limit order (must have a positive `price`) *or* a market order
 (`price` is null/absent). Zod uses the `type` literal to pick the right branch
 and validate accordingly. The controller mirrors this: `price = type ===
 "market" ? null : parsedBody.data.price`. This is how you model "shape depends
 on a tag field" safely.
- **Every controller is the same 3 steps:** validate (params or body) →
 `sendToEngine` → translate the `{ok,data,error}` envelope into an HTTP
 status+body. `ok ? data : {error}`; `getOrder` uses 404 (not found) instead of
 400 — status codes carry meaning.
- **`getUserId` throws if `req.userId` is missing** — defense in depth. The route
 already has `requireAuth` in front, but the controller doesn't *assume* it;
 the thrown error flows through `asyncHandler` → 500.
- **Route layering:** `routes/` is wiring only; `requireAuth` gates every
 exchange route; `asyncHandler` wraps every handler; `appRouter` composes the
 routers. Routes are mounted **at the root** (`app.use(appRouter)`) — so the
 paths are exactly `POST /signup`, `POST /order`, `GET /depth/:symbol`, etc.
 (no `/api/v1` prefix in this repo).

### 3.9 Backend: wiring (`index.ts`)

`src/index.ts`:

```ts
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { appRouter } from "./routes/index.js";
import { env } from "./utils/env.js";
import {
 connectRedis,
 listenForEngineResponses,
 pingRedis,
} from "./utils/engine-client.js";

await connectRedis();
void listenForEngineResponses();

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", async (_req, res) => {
 await pingRedis();
 res.json({ ok: true });
});

app.use(appRouter);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
 console.error(err);
 res.status(500).json({
 error: err instanceof Error ? err.message : "internal_server_error",
 });
});

app.listen(env.port, () => {
 console.log(`Backend running on http://localhost:${env.port}`);
 console.log(`Response queue: ${env.responseQueue}`);
});
```

**First principles — order of operations matters:**

1. **`await connectRedis()` before anything else** — top-level `await` (Bun/ESM
 supports it). No point starting an HTTP server that can't reach the engine.
2. **`void listenForEngineResponses()`** — fire-and-forget. It's an infinite
 loop; `await`ing it would block startup forever. `void` says "intentionally
 not awaited."
3. **Middleware runs in registration order:** `cors()` → `express.json()` (parses
 `Content-Type: application/json` into `req.body`; without it `req.body` is
 `undefined` — a classic bug) → `/health` → `appRouter` (all real routes) →
 **the 4-argument error handler**.
4. **The 4-arg `(err, req, res, next)` signature is special** — Express
 recognizes the arity and treats it as the centralized error handler.
 *Every* error forwarded by `asyncHandler`'s `.catch(next)` lands here and
 becomes a clean JSON 500. **It must be registered last** (after routes), or
 errors from routes registered later won't reach it.
5. `/health` pinging Redis means "200 = backend *and* Redis are up" — a real
 readiness check, not just "the process is alive."

That's the entire backend.

### 3.10 Engine: the whole worker

```bash
cd ../engine && bun init -y && rm index.ts && mkdir -p src/store src/utils
bun add redis dotenv
```

`engine/package.json` script: `{ "scripts": { "dev": "bun run src/index.ts" } }`

`engine/.env.example`:

```
REDIS_URL="redis://localhost:6379"
INCOMING_QUEUE="backend-to-engine-broker"
```

`src/utils/env.ts`:

```ts
import "dotenv/config";

function readRequiredEnv(name: string): string {
 const value = process.env[name];
 if (!value) throw new Error(`Missing required env variable: ${name}`);
 return value;
}

export const env = {
 redisUrl: readRequiredEnv("REDIS_URL"),
 incomingQueue: process.env.INCOMING_QUEUE ?? "backend-to-engine-broker",
};
```

`src/store/exchange-store.ts` — types + in-memory state (the assignment surface):

```ts
export type Side = "buy" | "sell";
export type OrderType = "market" | "limit";
export type OrderStatus = "open" | "partially_filled" | "filled" | "cancelled";

export interface Balance {
 available: number;
 locked: number;
}

export interface RestingOrder {
 orderId: string;
 userId: string;
 side: Side;
 type: "limit";
 symbol: string;
 price: number;
 qty: number;
 filledQty: number;
 status: OrderStatus;
 createdAt: number;
}

export interface OrderRecord {
 orderId: string;
 userId: string;
 side: Side;
 type: OrderType;
 symbol: string;
 price: number | null;
 qty: number;
 filledQty: number;
 status: OrderStatus;
 fills: Fill[];
 createdAt: number;
}

export interface Fill {
 fillId: string;
 symbol: string;
 price: number;
 qty: number;
 buyOrderId: string;
 sellOrderId: string;
 createdAt: number;
}

export interface OrderBook {
 bids: Map<number, RestingOrder[]>;
 asks: Map<number, RestingOrder[]>;
}

export interface CreateOrderInput {
 userId: string;
 type: OrderType;
 side: Side;
 symbol: string;
 price: number | null;
 qty: number;
}

export interface DepthLevel {
 price: number;
 qty: number;
}

export interface DepthResponse {
 symbol: string;
 bids: DepthLevel[];
 asks: DepthLevel[];
}

export const BALANCES = new Map<string, Record<string, Balance>>();
export const ORDERBOOKS = new Map<string, OrderBook>();
export const ORDERS = new Map<string, OrderRecord>();
export const FILLS: Fill[] = [];
```

`src/index.ts` — the consumer loop (boilerplate state, with the stub):

```ts
import "dotenv/config";
import { createClient } from "redis";
import { env } from "./utils/env.js";

export type EngineCommandType =
 | "create_order"
 | "get_depth"
 | "get_user_balance"
 | "get_order"
 | "cancel_order";

export interface EngineRequest {
 correlationId: string;
 responseQueue: string;
 type: EngineCommandType;
 payload: Record<string, unknown>;
}

export interface EngineResponse {
 correlationId: string;
 ok: boolean;
 data?: unknown;
 error?: string;
}

const brokerClient = createClient({ url: env.redisUrl }).on("error", (error) => {
 console.error("Redis broker client error", error);
});

const responseClient = createClient({ url: env.redisUrl }).on("error", (error) => {
 console.error("Redis response client error", error);
});

await Promise.all([brokerClient.connect(), responseClient.connect()]);

// :-)) added just to check the flow, remove it when you start
const DUMMY_SELL_ORDER = {
 orderId: "dummy-sell-order-1",
 userId: "dummy-seller",
 type: "limit",
 side: "sell",
 symbol: "BTC",
 price: 100,
 qty: 1,
 filledQty: 0,
 status: "open",
};

async function sendResponse(responseQueue: string, response: EngineResponse): Promise<void> {
 await responseClient.lPush(responseQueue, JSON.stringify(response));
}

function handleEngineRequest(message: EngineRequest): unknown {
 /**
 * TODO(student):
 * 1. Check message.type.
 * 2. Read message.payload.
 * 3. Call your order book / balance / order logic.
 * 4. Return the data that should go back to the backend.
 */

 // just checking the flow, remove this when you implement the logic
 if (message.type === "create_order") {
 return {
 orderId: crypto.randomUUID(),
 status: "filled",
 filledQty: DUMMY_SELL_ORDER.qty,
 averagePrice: DUMMY_SELL_ORDER.price,
 fills: [
 {
 fillId: crypto.randomUUID(),
 symbol: DUMMY_SELL_ORDER.symbol,
 price: DUMMY_SELL_ORDER.price,
 qty: DUMMY_SELL_ORDER.qty,
 buyOrderId: "request-buy-order",
 sellOrderId: DUMMY_SELL_ORDER.orderId,
 },
 ],
 note: "Smoke-test response only. Replace with real matching logic.",
 };
 }

 throw new Error("TODO(student): implement this engine request type");
}

console.log(`Engine listening on Redis queue: ${env.incomingQueue}`);

for (;;) {
 const item = await brokerClient.brPop(env.incomingQueue, 0);
 if (!item) continue;

 let message: EngineRequest;
 try {
 message = JSON.parse(item.element) as EngineRequest;
 } catch {
 console.error("Skipping invalid broker message");
 continue;
 }

 try {
 const data = handleEngineRequest(message);
 await sendResponse(message.responseQueue, {
 correlationId: message.correlationId,
 ok: true,
 data,
 });
 } catch (error) {
 await sendResponse(message.responseQueue, {
 correlationId: message.correlationId,
 ok: false,
 error: error instanceof Error ? error.message : "engine_error",
 });
 }
}
```

**First principles:**

- **The engine is the mirror image of the backend's response loop.** Backend:
 `brPop(responseQueue)` → resolve a Promise. Engine: `brPop(incomingQueue)` →
 handle → `lPush(message.responseQueue)`. Same two primitives, opposite ends.
- **Two clients again** — `brokerClient` is parked on the blocking `brPop`;
 `responseClient` does the `lPush` reply. Same reason as the backend.
- **The contract is *duplicated* here**, not imported — engine and backend are
 separate packages with no shared code. Discipline: change one copy, change the
 other.
- **The `ok`/`error` envelope is applied by the loop, not the handler.**
 `handleEngineRequest` just returns data or *throws*. The loop wraps a return in
 `{ok:true, data}` and a throw in `{ok:false, error}`. So an unimplemented type
 throwing `TODO(student): ...` still produces a *fast structured response* — the
 backend gets a 400 instantly instead of timing out at 30 s. **The plumbing is
 proven even when the logic isn't written.**
- **`brPop` returns `{key, element}` or `null`** (node-redis v5 shape) — hence
 `item.element` and the `if (!item) continue`.
- **No HTTP server, minimal deps** (`redis`, `dotenv`). The engine's only
 interface is the queue → smaller attack surface, deterministic, independently
 deployable.
- **`exchange-store.ts` is the assignment.** The types describe exactly what you
 must build: price-level books (`Map<number, RestingOrder[]>` — orders at each
 price, array order = time priority), partial fills (`filledQty`), order
 lifecycle (`OrderStatus`), locked balances (`Balance.locked`). The four
 `Map`/array exports are the in-memory state to fill in.

---

## Part 4 — Run & smoke test

Two `.env` files filled, datastore reachable, migration applied
(`cd backend && bunx prisma migrate dev`). Then **two terminals**:

```bash
# terminal 1 — engine first (so no request waits)
cd engine && bun run dev
# → "Engine listening on Redis queue: backend-to-engine-broker"

# terminal 2 — backend
cd backend && bun run dev
# → "Backend running on http://localhost:3000"
# → "Response queue: response-queue-<id>"
```

Manual checks (terminal 3):

```bash
# health = backend + redis up
curl -s localhost:3000/health # {"ok":true}

# signup → 201 + token
curl -s -X POST localhost:3000/signup \
 -H 'Content-Type: application/json' \
 -d '{"username":"alice","password":"hunter2"}'

# grab the token, then the full 7-hop round trip:
TOKEN="<paste token>"
curl -s -X POST localhost:3000/order \
 -H 'Content-Type: application/json' \
 -H "Authorization: Bearer $TOKEN" \
 -d '{"type":"limit","side":"buy","symbol":"BTC","price":100,"qty":1}'
# → {"orderId":"...","status":"filled",...} ← stub came back through the engine
```

That `create_order` response traveled: curl → express.json → requireAuth (JWT) →
createOrder (zod) → sendToEngine → `lPush` broker queue → **Redis** → engine
`brPop` → handler stub → `lPush` response queue → **Redis** → backend
`listenForEngineResponses` `brPop` → `resolveEngineResponse` → Promise resolves →
HTTP 200. **Every hop verified.**

`GET /depth/BTC` (with token) returns `400 {"error":"TODO(student): ..."}` — that
is *correct*: it proves the queue path works for an unimplemented type too. The
engine reached, threw, and the error came back fast.

`POST /signin` **hangs** (empty TODO → no response → 30 s timeout). Expected
current state.

### The repo ships three test helpers

- **`smoke-test.sh`** — boots engine + backend, runs ~9 end-to-end assertions
 (health, signup 201, duplicate 409, bad body 400, no-token 401, the create
 round-trip, depth/balance reach the engine, signin hangs), then tears
 everything down. `./smoke-test.sh`; exit 0 = pipeline works.
- **`CHECK-FLOW.md`** — manual flow walkthrough (needs a JWT, so do `signin` first).
- **`BARE_MINIMUM_TEST.md`** — the minimum to call it working.

Run `./smoke-test.sh` after any change — it's the fastest "did I break the
pipeline" check.

---

## Part 5 — First-principles cheat sheet

The transferable ideas. If you remember nothing else, remember these.

| Concept | The one-sentence version |
|---|---|
| **Web tier vs stateful worker** | Split when one part owns hot in-RAM state that must be single-owner and deterministic; the other stays stateless and scalable. |
| **Queue (list + LPUSH/BRPOP)** | A Redis list is a FIFO: push one end, blocking-pop the other. Decouples producer speed from consumer speed. |
| **RPC over a one-way queue** | Attach a `correlationId` + a `responseQueue` to each request; keep a `Map<id, {resolve,reject,timeout}>`; resolve the right Promise when the reply arrives. |
| **Deferred Promise** | `new Promise((res,rej)=>{ store res/rej somewhere })` — the only way to resolve a Promise from *outside* its creation site. |
| **Two Redis clients** | A blocking `BRPOP` monopolizes its connection; give blocking reads their own client so writes aren't stuck behind them. |
| **Timeout every awaited remote call** | Or one dead dependency hangs every request and exhausts the server. |
| **ORM / schema-first** | Declare schema once → generated typed client + versioned migrations. One source of truth for data shape. |
| **Driver adapter** | Modern Prisma drives the standard `pg` driver instead of bundling its own engine binary. |
| **Hash passwords (slow+salted)** | bcrypt with a cost factor; never plaintext, never plain SHA. Verify with `bcrypt.compare`. |
| **JWT** | Signed (not encrypted) `header.payload.sig`. Server holds the secret, verifies statelessly. Don't put secrets in the payload. |
| **Runtime validation (Zod)** | TS types are erased at runtime; validate untrusted input at the boundary with `safeParse`. |
| **Discriminated union** | Model "shape depends on a tag field" (limit vs market) so the type system enforces the right fields per variant. |
| **Express middleware** | `(req,res,next)` — respond or `next()`. Forgetting `next()` hangs the request. |
| **`asyncHandler`** | Express doesn't await handlers; wrap async ones so rejections reach the central error handler. |
| **4-arg error middleware, registered last** | Express recognizes `(err,req,res,next)` arity; it must come after routes to catch their errors. |
| **Declaration merging** | Add fields to a third-party type (e.g. `Request.userId`) without forking it. |
| **Typed `env` object, fail-fast** | Parse/validate all config once at startup; crash early with a clear message, not late with `undefined`. |
| **`.env` out of git, `.env.example` in** | Secrets per-machine; template documents the keys. |
| **Generated code out of git** | Rebuildable from source; committing it = noisy diffs. |

---

## Part 6 — The assignment

The boilerplate deliberately omits the brain. To finish it:

1. **`signin`** in `backend/src/controllers/auth-controller.ts` — validate body
 with `authSchema`, `prisma.user.findUnique({where:{username}})`,
 `bcrypt.compare(password, user.password)`, return `createToken({userId})` or
 `401`. Mirror `signup`; ~15 lines. Do this first (quick, completes the auth loop).
2. **The matching engine** in `engine/src/store/exchange-store.ts` +
 `engine/src/index.ts` — replace the stub. Implement `create_order` (limit +
 market, price-time priority, partial fills, balance debits/credits),
 `get_depth` (bids high→low, asks low→high, grouped by price level),
 `get_user_balance`, `get_order`, `cancel_order`. Wire each into
 `handleEngineRequest` (replace the `throw`). The types in `exchange-store.ts`
 are the spec; see [README.md](README.md) for exact matching/depth/cancel rules.

Then `./smoke-test.sh` should pass *including* signin not hanging.

---

## Part 7 — Rebuild-from-memory checklist

Close this file. Recreate the repo. Tick each without looking; peek only when stuck.

**Skeleton**
- [ ] `git init`, two package dirs, root `.gitignore` (`node_modules`, `.env*`, `!.env.example`)
- [ ] `backend/.gitignore` ignores `/src/generated/prisma`

**Backend config & DB**
- [ ] deps installed; one `dev` script
- [ ] `utils/env.ts` — `readRequiredEnv`, typed object, `responseQueue` derivation
- [ ] `schema.prisma` — `prisma-client` generator → `../src/generated/prisma`, no `url`, `User` model
- [ ] `db.ts` — `PrismaPg` adapter, one shared client
- [ ] `bunx prisma migrate dev --name init`

**Auth**
- [ ] `auth-schema.ts` (Zod)
- [ ] `auth.ts` — `createToken`, `requireAuth` (Bearer → verify → `req.userId` → `next()`)
- [ ] `auth-controller.ts` — `signup` (safeParse → bcrypt.hash → create → 201/409); `signin` TODO

**Broker (do this without peeking — it's the core)**
- [ ] `types/engine.ts` — `EngineRequest{correlationId,responseQueue,type,payload}`, `EngineResponse{correlationId,ok,data?,error?}`
- [ ] `pending-responses.ts` — `Map`, `waitForEngineResponse` (deferred Promise + timeout), `resolveEngineResponse`
- [ ] `engine-client.ts` — publisher + subscriber clients, `connectRedis`, `sendToEngine` (register *before* lPush), `listenForEngineResponses` (`for(;;)` brPop)

**Plumbing & routes**
- [ ] `async-handler.ts`, `express.d.ts` (declaration merge), `validation.ts`
- [ ] `exchange-schema.ts` — discriminated union on `type`
- [ ] `exchange-controller.ts` — validate → sendToEngine → `ok? data : {error}`
- [ ] `routes/*` — authRouter, exchangeRouter (`requireAuth` + `asyncHandler`), appRouter
- [ ] `index.ts` — `await connectRedis()`, `void listenForEngineResponses()`, cors, json, /health, appRouter, **4-arg error handler last**

**Engine**
- [ ] `utils/env.ts`
- [ ] `store/exchange-store.ts` — types + `BALANCES/ORDERBOOKS/ORDERS/FILLS`
- [ ] `index.ts` — two clients, `brPop` loop, handler returns/throws, loop wraps `{ok,data}`/`{ok,error}`

**Verify**
- [ ] both `.env` filled, `REDIS_URL`/`INCOMING_QUEUE` identical across both
- [ ] engine up, backend up, `./smoke-test.sh` green (signin hang expected)

When you can tick the **Broker** section from memory and explain *why two
clients* and *why register the pending entry before lPush*, you've actually got
it back.
```