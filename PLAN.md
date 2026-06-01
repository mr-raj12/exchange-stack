# CEX-v2 Architecture Migration Plan

## Table of Contents
1. [Current State](#1-current-state)
2. [Target Architecture](#2-target-architecture)
3. [New Services Inventory](#3-new-services-inventory)
4. [Overall Changes Summary](#4-overall-changes-summary)
5. [Phase 0 — Groundwork: Shared Package + Env Config](#phase-0--groundwork-shared-package--env-config)
6. [Phase 1 — Redis Streams + Per-Backend Response Pub/Sub](#phase-1--redis-streams--per-backend-response-pubsub)
7. [Phase 2 — Database Persistence](#phase-2--database-persistence)
8. [Phase 2A — Liquidation Orders via Orderbook](#phase-2a--liquidation-orders-via-orderbook)
9. [Phase 2B — Snapshot & Replay (WAL + State Checkpointing)](#phase-2b--snapshot--replay-wal--state-checkpointing)
10. [Phase 3 — Decouple Binance: Mark Price Poller Service](#phase-3--decouple-binance-mark-price-poller-service)
11. [Phase 3A — Funding Rate](#phase-3a--funding-rate)
12. [Phase 4 — Engine Event Publishing (Fills, Positions, Orderbook)](#phase-4--engine-event-publishing)
13. [Phase 5 — WebSocket Server (User Events + Market Data)](#phase-5--websocket-server)
14. [Phase 6 — Poller Service (DB Snapshots → Market WS)](#phase-6--poller-service)
15. [Phase 7 — Backend WebSocket Route (HTTP Upgrade)](#phase-7--backend-websocket-upgrade-route)
16. [Phase 8 — Cleanup, Wire-up & Testing](#phase-8--cleanup-wire-up--testing)
17. [Complete File Change Inventory](#complete-file-change-inventory)
18. [Environment Variables Reference](#environment-variables-reference)
19. [Architecture Diagrams (ASCII)](#architecture-diagrams)

---

## 1. Current State

```
┌─────────────┐    HTTP     ┌────────────┐  LPUSH   ┌──────────────┐
│  Client     │────────────▶│  Backend   │─────────▶│  Redis       │
│ (curl/HTTP) │             │  (Express) │          │  LPUSH/BRPOP │
└─────────────┘             └─────┬──────┘          └──────┬───────┘
                                  │ BRPOP response          │ BRPOP incoming
                                  │                         ▼
                                  │                  ┌──────────────┐
                                  └──────────────────│   Engine     │
                                    (response queue) │  (in-memory) │
                                                     └──────┬───────┘
                                                            │ direct call
                                                     ┌──────▼───────┐
                                                     │  BinanceWS   │
                                                     │ (inside eng) │
                                                     └──────────────┘
```

**Problems:**
- LPUSH/BRPOP response queues cannot scale horizontally — multiple backend instances
  compete for responses, pulling messages destined for other instances
- BinancePriceWs lives inside the engine, tight coupling
- No real-time push to clients (no WebSocket)
- All state is in-memory; restart = total data loss
- No rate limit, no persistence, no user event stream

---

## 2. Target Architecture

```
                         ┌──────────────────────────────────────────────────────┐
┌──────────┐             │                    BACKEND CLUSTER                   │
│ Website  │──HTTP/WS──▶ │  backend-1  backend-2  backend-N                     │
│ Mobile   │             │  Each instance has unique BACKEND_INSTANCE_ID        │
└──────────┘             └─────────┬──────────────────────┬────────────────────┘
                                   │ XADD (stream)         │ SUB backend:{id}:responses
                                   ▼                       │
                         ┌─────────────────┐               │
                         │  Redis          │               │
                         │                 │  PUB backend:{id}:responses
                         │  Streams:       │◀──────────────┤
                         │  SPOT_stream    │               │
                         │  PERPS_stream   │  PUB user:{uid}:events
                         │  mark_price_    │  PUB market:{sym}:orderbook
                         │  stream         │               │
                         │                 │               │
                         │  Pub/Sub:       │               │
                         │  backend:*      │               │
                         │  user:*:events  │               │
                         │  market:*:      │               │
                         │  orderbook      │               │
                         └────────┬────────┘               │
                                  │ XREADGROUP              │
                                  ▼                        │
                         ┌─────────────────┐               │
                         │    Engine       │───────────────┘
                         │  (single, but   │  publish events after every match
                         │   reads 3       │
                         │   streams)      │──────────────▶ Postgres DB
                         └─────────────────┘  write orders/trades/positions
                                  ▲
                         ┌────────┴────────┐
                         │  mark_price_    │
                         │  stream (XADD)  │
                         └────────▲────────┘
                                  │
                         ┌────────┴────────┐
                         │  Mark Price     │
                         │  Poller         │──▶ wss://stream.binance.com
                         └─────────────────┘

                         ┌─────────────────┐
                         │   WS Server     │◀─── Redis SUB user:*:events
                         │                 │◀─── Redis SUB market:*:orderbook
                         │  /user          │     (individual + global events)
                         │  /market        │
                         └────────┬────────┘
                                  │ push
                         ┌────────▼────────┐
                         │ Website/Mobile  │
                         │  (live fills,   │
                         │   positions,    │
                         │   orderbook)    │
                         └─────────────────┘

                         ┌─────────────────┐
                         │    Poller       │◀─── Postgres DB (orderbook snapshots)
                         │                 │────▶ Redis PUB market:{sym}:orderbook
                         └─────────────────┘      OR disk snapshot files
```

---

## 3. New Services Inventory

| Service | Location | Role |
|---------|----------|------|
| `shared` | `shared/` | Shared TypeScript types, queue names, event schemas |
| `mark-price-poller` | `mark-price-poller/` | Binance WS → Redis `mark_price_stream` XADD |
| `ws-server` | `ws-server/` | WebSocket server: user events + market data channels |
| `poller` | `poller/` | Reads orderbook snapshots from DB → publishes to market WS channel |
| `funding-timer` | `funding-timer/` | Emits funding settlement triggers every 8h to `funding_rate_stream` |

**Modified existing services:**
- `backend/` — Replace broker LPUSH/BRPOP with Streams + per-instance pub/sub sub
- `engine/` — Replace BRPOP with XREADGROUP on 5 streams; publish events; write to DB; WAL; liquidation orders; funding settlement

---

## 4. Overall Changes Summary

| Layer | Current | Target | Why |
|-------|---------|--------|-----|
| Request transport | `LPUSH` | `XADD` Redis Stream | Persistent, replayable, consumer groups |
| Response transport | `BRPOP` shared queue | `PUBLISH backend:{id}:responses` | Each backend reads only its own responses |
| Mark price feed | Direct in engine (`BinancePriceWs`) | `mark-price-poller` → `mark_price_stream` | Decouple, can swap price source later |
| State persistence | In-memory only | Postgres (orders, trades, positions, balances) | Survive restarts, audit log |
| Client real-time | HTTP response only | WebSocket server + Redis pub/sub | Live fills, position, orderbook |
| Orderbook snapshots | None | Poller reads DB → files / WS push | Historical depth + real-time feed |
| Binance coupling | `binance-ws.ts` inside engine | Standalone `mark-price-poller` service | Independent scaling and replacement |
| Backend scaling | Single instance only | N instances, each identified by `BACKEND_INSTANCE_ID` | Horizontal scaling |
| Liquidation | Direct margin seize, no orderbook | Liquidation order placed in orderbook; surplus/deficit to insurance fund; ADL fallback | Real exchange behavior, fair price discovery |
| Engine restart recovery | Total state loss | WAL stream + periodic snapshots; replay delta on restart | Sub-second recovery; no data loss |
| Funding rate | None | Periodic settlement via `funding-timer` + engine settlement loop | Perps price anchored to spot/index |

---

## Phase 0 — Groundwork: Shared Package + Env Config

### Goal
Create a `shared/` package with queue names, event type enums, and message contracts so
all services stay in sync when message shapes change.

### 0.1 Create `shared/` package

```
shared/
  src/
    queue-names.ts       ← all Redis key/stream/channel name builders
    events.ts            ← typed event payloads (FillEvent, PositionEvent, etc.)
    messages.ts          ← move engine request/response types here (from engine/src/types/messages.ts)
  package.json
  tsconfig.json
```

**`shared/src/queue-names.ts`:**
```ts
// Single source of truth for all Redis key names.
// Import in backend, engine, ws-server, poller.

export const SPOT_INCOMING_STREAM   = "SPOT_incoming_stream";
export const PERPS_INCOMING_STREAM  = "PERPS_incoming_stream";
export const MARK_PRICE_STREAM      = "mark_price_stream";
export const ENGINE_CONSUMER_GROUP  = "engine-group";
export const ENGINE_CONSUMER_NAME   = "engine-consumer-1";

// Per-backend response channel (pub/sub)
export const backendResponseChannel = (backendId: string) =>
  `backend:${backendId}:responses`;

// Per-user event channel (pub/sub)
export const userEventsChannel = (userId: string) =>
  `user:${userId}:events`;

// Per-market orderbook channel (pub/sub)
export const orderbookChannel = (market: string) =>
  `market:${market}:orderbook`;
```

**`shared/src/events.ts`:**
```ts
export type EventType =
  | "fill"
  | "order_update"
  | "position_update"
  | "liquidation"
  | "orderbook_snapshot"
  | "mark_price";

export interface FillEvent {
  type: "fill";
  orderId: string;
  market: string;
  side: "buy" | "sell";
  price: number;
  quantity: number;
  fee: number;
  timestamp: number;
}

export interface PositionUpdateEvent {
  type: "position_update";
  userId: string;
  market: string;
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  liquidationPrice: number;
  unrealizedPnl: number;
  margin: number;
  leverage: number;
}

export interface LiquidationEvent {
  type: "liquidation";
  userId: string;
  market: string;
  side: "long" | "short";
  markPrice: number;
  liquidationPrice: number;
  marginLost: number;
}

export interface OrderbookSnapshotEvent {
  type: "orderbook_snapshot";
  market: string;
  bids: [string, string][];   // [price, qty]
  asks: [string, string][];
  timestamp: number;
}

export interface MarkPriceEvent {
  type: "mark_price";
  market: string;
  price: number;
  timestamp: number;
}

export type UserEvent = FillEvent | PositionUpdateEvent | LiquidationEvent;
export type MarketEvent = OrderbookSnapshotEvent | MarkPriceEvent;
```

### 0.2 Update each service's `package.json` to reference `shared`

```json
// backend/package.json, engine/package.json, ws-server/package.json, poller/package.json
"dependencies": {
  "shared": "file:../shared",
  ...
}
```

### 0.3 Add `BACKEND_INSTANCE_ID` to backend env

Each backend process needs a unique identity so the engine can route responses back.
```
# backend/.env
BACKEND_INSTANCE_ID=backend-1    # change per deployment instance / pod name
```

In Kubernetes / Docker Compose this is typically the pod name or container hostname:
```
BACKEND_INSTANCE_ID=${HOSTNAME}
```

---

## Phase 1 — Redis Streams + Per-Backend Response Pub/Sub

### Goal
Replace the LPUSH/BRPOP pattern with Redis Streams for requests and Redis Pub/Sub for
responses. After this phase, multiple backend instances can run without stealing each
other's responses.

### Why Redis Streams over LPUSH/BRPOP

| Property | LPUSH/BRPOP | Redis Streams |
|----------|-------------|---------------|
| Competing consumers | Only one consumer wins | Consumer groups — engine reads each message once |
| Message loss on crash | Gone if engine crashes mid-process | Message stays pending in stream until XACK |
| Replay / audit | Not possible | XRANGE lets you replay history |
| Multi-stream fan-in | BRPOP on N queues — one at a time, order-dependent | XREADGROUP can read from multiple streams in one call |
| Back-pressure visibility | Queue depth with LLEN | Stream lag with XPENDING |

### 1.1 Engine: Switch from BRPOP to XREADGROUP

**File: `engine/src/index.ts`** — replace the `main()` loop:

```ts
// Before: BRPOP
const result = await redis.brpop(SPOT_IQ, PERPS_IQ, 0);

// After: XREADGROUP from two streams simultaneously
async function ensureConsumerGroups() {
  for (const stream of [SPOT_INCOMING_STREAM, PERPS_INCOMING_STREAM, MARK_PRICE_STREAM]) {
    try {
      // "0" = start from the beginning if group is new
      await redis.xgroup("CREATE", stream, ENGINE_CONSUMER_GROUP, "0", "MKSTREAM");
    } catch (e: any) {
      if (!e.message.includes("BUSYGROUP")) throw e; // ignore "group already exists"
    }
  }
}

async function main() {
  await ensureConsumerGroups();
  console.log("Engine listening on streams...");

  while (true) {
    try {
      // Read from SPOT + PERPS incoming streams in one blocking call
      // ">" = only undelivered messages (not pending retries)
      const results = await redis.xreadgroup(
        "GROUP", ENGINE_CONSUMER_GROUP, ENGINE_CONSUMER_NAME,
        "COUNT", "1",
        "BLOCK", "0",       // block until a message arrives
        "STREAMS",
        SPOT_INCOMING_STREAM, PERPS_INCOMING_STREAM,
        ">", ">"            // one ">" per stream
      );
      if (!results) continue;

      for (const [streamName, messages] of results) {
        for (const [msgId, fields] of messages) {
          // fields is an alternating [key, val, key, val, ...] array from ioredis
          const raw = fieldsToObject(fields);
          const request = JSON.parse(raw.payload) as SpotEngineRequest | PerpsEngineRequest;

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

          // Publish response to the originating backend instance's pub/sub channel
          // backendId was embedded in the request by the broker
          await redis.publish(
            backendResponseChannel(request.backendId),
            JSON.stringify({ correlationId: request.correlationId, payload })
          );

          // Acknowledge the message so it's removed from pending
          await redis.xack(streamName, ENGINE_CONSUMER_GROUP, msgId);
        }
      }
    } catch (err) {
      console.error("engine loop error:", err);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// ioredis xreadgroup returns fields as flat [k,v,k,v] array
function fieldsToObject(fields: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
  return obj;
}
```

**Add `backendId` + `streamMsgId` to engine message types** in `shared/src/messages.ts`:
```ts
export type SpotEngineRequest = {
  type: EngineRequestTypes;
  data: SpotEngineRequestData;
  correlationId: string;
  backendId: string;          // NEW — which backend instance sent this
  responseQueue?: string;     // DEPRECATED — remove after full migration
};
```

### 1.2 Backend Broker: XADD + Subscribe to Own Pub/Sub Channel

**File: `backend/src/utils/broker.ts`** — full replacement:

```ts
import { redis, makeRedisClient } from "./redis.js";
import { v4 as uuidv4 } from "uuid";
import {
  SPOT_INCOMING_STREAM, PERPS_INCOMING_STREAM,
  backendResponseChannel
} from "shared/src/queue-names.js";

const BACKEND_ID = process.env.BACKEND_INSTANCE_ID!;  // must be set, unique per instance
const TIMEOUT_MS = Number(process.env.ENGINE_TIMEOUT_MS) || 30_000;

// Dedicated subscriber connection — must not be shared with XADD connection
const redisSub = makeRedisClient();
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

// Subscribe ONCE at startup to this backend's response channel
export async function initBroker(): Promise<void> {
  const channel = backendResponseChannel(BACKEND_ID);
  await redisSub.subscribe(channel);

  redisSub.on("message", (_chan: string, raw: string) => {
    const msg = JSON.parse(raw) as { correlationId: string; payload: unknown };
    const handler = pending.get(msg.correlationId);
    if (!handler) return;  // not ours or already timed out
    clearTimeout(handler.timer);
    pending.delete(msg.correlationId);
    handler.resolve(msg.payload);
  });

  console.log(`[broker] subscribed to ${channel}`);
}

export async function sendToEngine<TResponse = unknown>(
  type: string,
  data: unknown,
  queue: "SPOT" | "PERPS"
): Promise<TResponse> {
  const correlationId = uuidv4();
  const stream = queue === "SPOT" ? SPOT_INCOMING_STREAM : PERPS_INCOMING_STREAM;

  return new Promise<TResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(correlationId);
      reject(new Error("engine timeout"));
    }, TIMEOUT_MS);

    pending.set(correlationId, { resolve: resolve as (v: unknown) => void, reject, timer });

    // XADD: fields are key-value pairs
    // We put the full request as a single JSON field "payload"
    redis.xadd(
      stream,
      "*",                                  // auto-generate message ID
      "payload", JSON.stringify({ type, data, correlationId, backendId: BACKEND_ID })
    ).catch(err => {
      clearTimeout(timer);
      pending.delete(correlationId);
      reject(err);
    });
  });
}
```

**File: `backend/src/index.ts`** — call `initBroker()` on startup (replace `startResponseLoop()`):
```ts
import { initBroker } from "./utils/broker.js";
// ...
await initBroker();  // subscribe to this instance's pub/sub channel before accepting requests
app.listen(PORT, () => console.log(`backend ${BACKEND_ID} listening on :${PORT}`));
```

### 1.3 Handle Pending Messages on Engine Restart (Dead Letter)

When the engine crashes mid-processing, messages remain in the stream's "pending entries list"
(PEL) unacknowledged. On startup, process these first:

```ts
// engine/src/index.ts — add after ensureConsumerGroups()
async function drainPending() {
  for (const stream of [SPOT_INCOMING_STREAM, PERPS_INCOMING_STREAM]) {
    // "0" instead of ">" reads pending (previously delivered but unacknowledged) messages
    const pending = await redis.xreadgroup(
      "GROUP", ENGINE_CONSUMER_GROUP, ENGINE_CONSUMER_NAME,
      "COUNT", "100", "STREAMS", stream, "0"
    );
    if (!pending) continue;
    for (const [streamName, messages] of pending) {
      for (const [msgId, fields] of messages) {
        // re-process or dead-letter if too old
        const raw = fieldsToObject(fields);
        const idleMs = Date.now() - parseInt(msgId.split("-")[0]);
        if (idleMs > 60_000) {
          // too old: XACK to remove, log for investigation
          console.warn(`[engine] dead-lettering msgId=${msgId}`);
          await redis.xack(streamName, ENGINE_CONSUMER_GROUP, msgId);
          continue;
        }
        // re-process normally
        const request = JSON.parse(raw.payload);
        // ... same processing logic
      }
    }
  }
}
```

### 1.4 Migration Checklist — Phase 1

- [ ] Create `shared/` package with `queue-names.ts` and update `tsconfig.json` paths
- [ ] Add `BACKEND_INSTANCE_ID` env var to backend `.env` and deployment configs
- [ ] Update `engine/src/types/messages.ts` → add `backendId` field to request types
- [ ] Replace `engine/src/index.ts` BRPOP loop with XREADGROUP loop
- [ ] Replace `backend/src/utils/broker.ts` LPUSH with XADD + pub/sub subscription
- [ ] Remove `startResponseLoop()` call from `backend/src/index.ts`, add `initBroker()`
- [ ] Remove `RESPONSE_QUEUE` env var (no longer needed)
- [ ] Test: send order from backend-1 only backend-1 receives response (simulate with two processes)
- [ ] Test: engine crash + restart picks up pending messages from PEL

---

## Phase 2 — Database Persistence

### Goal
Write orders, fills, positions, and balance snapshots to Postgres so state survives engine
restarts and provides an audit trail.

### 2.1 Prisma Schema — New Models

**File: `backend/prisma/schema.prisma`** — add to existing schema:

```prisma
model User {
  id        String   @id @default(uuid())
  username  String   @unique
  password  String
  orders    Order[]
  positions Position[]
  balances  Balance[]
}

model Order {
  id             String      @id @default(uuid())
  userId         String
  user           User        @relation(fields: [userId], references: [id])
  market         String
  side           String      // "buy" | "sell"
  orderType      String      // "limit" | "market"
  price          Decimal     @db.Decimal(20, 8)
  quantity       Decimal     @db.Decimal(20, 8)
  filledQty      Decimal     @db.Decimal(20, 8) @default(0)
  avgFillPrice   Decimal?    @db.Decimal(20, 8)
  status         String      // "OPEN" | "FILLED" | "PARTIALLY_FILLED" | "CANCELLED" | "PARTIALLY_CANCELLED"
  leverage       Int?        // perps only
  reduceOnly     Boolean     @default(false)
  exchange       String      // "SPOT" | "PERPS"
  fills          Fill[]
  createdAt      DateTime    @default(now())
  updatedAt      DateTime    @updatedAt
}

model Fill {
  id        String   @id @default(uuid())
  orderId   String
  order     Order    @relation(fields: [orderId], references: [id])
  price     Decimal  @db.Decimal(20, 8)
  quantity  Decimal  @db.Decimal(20, 8)
  makerSide String   // "buy" | "sell"
  createdAt DateTime @default(now())
}

model Position {
  id               String   @id @default(uuid())
  userId           String
  user             User     @relation(fields: [userId], references: [id])
  market           String
  side             String   // "long" | "short"
  quantity         Decimal  @db.Decimal(20, 8)
  entryPrice       Decimal  @db.Decimal(20, 8)
  liquidationPrice Decimal  @db.Decimal(20, 8)
  margin           Decimal  @db.Decimal(20, 8)
  leverage         Int
  stopLoss         Decimal? @db.Decimal(20, 8)
  takeProfit       Decimal? @db.Decimal(20, 8)
  equity           Decimal? @db.Decimal(20, 8)
  realizedPnl      Decimal  @db.Decimal(20, 8) @default(0)
  status           String   // "OPEN" | "CLOSED"
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@unique([userId, market, status])  // one open position per user per market
}

model Balance {
  id        String   @id @default(uuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  asset     String
  available Decimal  @db.Decimal(20, 8) @default(0)
  locked    Decimal  @db.Decimal(20, 8) @default(0)
  updatedAt DateTime @updatedAt

  @@unique([userId, asset])
}

model OrderbookSnapshot {
  id        String   @id @default(uuid())
  market    String
  exchange  String   // "SPOT" | "PERPS"
  bids      Json     // [[price, qty], ...]
  asks      Json
  createdAt DateTime @default(now())

  @@index([market, createdAt])
}
```

### 2.2 Run Migration

```bash
cd backend
bunx prisma migrate dev --name add_orders_positions_balances
bunx prisma generate
```

### 2.3 DB Writer in Engine

The engine writes to Postgres after every successful match. Two options:

**Option A — Direct write (simpler, recommended for single engine):**
Add Prisma client to engine, write synchronously after each match but without blocking
the matching loop (fire-and-forget writes to a local async queue).

```ts
// engine/src/db/writer.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Local in-memory write queue to avoid blocking the matching loop
const writeQueue: (() => Promise<void>)[] = [];
let flushing = false;

export function enqueueWrite(fn: () => Promise<void>) {
  writeQueue.push(fn);
  if (!flushing) flushWriteQueue();
}

async function flushWriteQueue() {
  flushing = true;
  while (writeQueue.length > 0) {
    const fn = writeQueue.shift()!;
    try { await fn(); } catch (e) { console.error("[db-writer] write error:", e); }
  }
  flushing = false;
}

export function writeOrder(order: /* Order type from shared */) {
  enqueueWrite(() =>
    prisma.order.upsert({
      where: { id: order.id },
      update: {
        status: order.status,
        filledQty: order.filledQuantity.toString(),
        avgFillPrice: order.avgPrice?.toString(),
        updatedAt: new Date(),
      },
      create: {
        id: order.id,
        userId: order.userId,
        market: order.market,
        side: order.side,
        orderType: order.orderType,
        price: order.price.toString(),
        quantity: order.quantity.toString(),
        filledQty: "0",
        status: order.status,
        exchange: order.exchange,
      }
    })
  );
}

export function writeFill(fill: /* Fill type */) {
  enqueueWrite(() =>
    prisma.fill.create({ data: { ...fill } })
  );
}

export function writePosition(position: /* Position type */) {
  enqueueWrite(() =>
    prisma.position.upsert({
      where: { userId_market_status: { userId: position.userId, market: position.market, status: "OPEN" } },
      update: { ...position, updatedAt: new Date() },
      create: { ...position }
    })
  );
}

export function writeBalance(userId: string, asset: string, available: number, locked: number) {
  enqueueWrite(() =>
    prisma.balance.upsert({
      where: { userId_asset: { userId, asset } },
      update: { available: available.toString(), locked: locked.toString(), updatedAt: new Date() },
      create: { userId, asset, available: available.toString(), locked: locked.toString() }
    })
  );
}
```

**Option B — Event stream (deferred, for later scaling):**
Engine publishes write events to `db_write_stream`, a separate `db-writer` process consumes
and writes. Keeps engine pure. Add this if engine becomes bottlenecked on DB I/O.

### 2.4 Call DB Writer from Store Methods

In `spot-exchange-store.ts` and `perps-exchange-store.ts`, after every fill and order update:

```ts
// After match in createOrder():
for (const fill of fills) {
  writeFill(fill);
}
writeOrder(incomingOrder);
writeOrder(matchedOrder);
writeBalance(userId, baseAsset, ...);
writeBalance(userId, quoteAsset, ...);
```

```ts
// In perps store, after updatePositionFromFill():
writePosition(updatedPosition);
```

### 2.5 Migration Checklist — Phase 2

- [ ] Update `backend/prisma/schema.prisma` with new models
- [ ] Run `prisma migrate dev`
- [ ] Create `engine/src/db/writer.ts` with async write queue
- [ ] Add DB write calls in `spot-exchange-store.ts` after fills
- [ ] Add DB write calls in `perps-exchange-store.ts` after fills and position updates
- [ ] Add DB write calls in `balance-store.ts` on credit/deduct
- [ ] Test: place order, restart engine, verify order still queryable from DB via backend API
- [ ] Test: DB write errors do not break matching loop

---

## Phase 2A — Liquidation Orders via Orderbook

### Goal
Replace the current direct-margin-seize liquidation with a proper liquidation order placed
into the orderbook. This is how real perpetual exchanges (Binance, Bybit, dYdX) work:
the liquidation engine becomes a participant in the orderbook, and price discovery is
preserved. Surplus fills flow into an insurance fund; deficits draw from it. If the fund
runs dry, Auto-Deleveraging (ADL) force-closes the most-profitable opposing positions.

### 2A.1 Current vs Target Liquidation Behavior

**Current (`checkAndLiquidate`):**
```
mark price crosses liquidation price
  → seize all margin directly
  → close position in memory
  → done
```
Problems: ignores real market price, unfair to user, no price discovery.

**Target:**
```
mark price crosses liquidation price
  → engine creates a LIQUIDATION market order (opposite side, same qty)
  → order enters the normal matching loop (price-time priority)
  → fills happen at real market prices
  → compare fill price vs bankruptcy price:
       fill > bankruptcy price → surplus = (fillPrice - bankruptcyPrice) * qty
                                 → credit insurance fund
       fill < bankruptcy price → deficit absorbed by insurance fund
                                 → if fund exhausted → trigger ADL
  → publish LiquidationEvent to user's pub/sub channel
```

### 2A.2 Key Concepts

| Term | Definition |
|------|-----------|
| **Liquidation price** | Price at which engine force-closes position. Already computed in engine. |
| **Bankruptcy price** | Price at which margin = 0. Long: `entryPrice × (1 − 1/leverage)`. Short: `entryPrice × (1 + 1/leverage)` |
| **Insurance fund** | Pool funded by liquidation surpluses; absorbs deficits. Tracked as a special system balance. |
| **ADL (Auto-Deleveraging)** | Last resort: force-close the most profitable opposing positions when insurance fund is empty and no liquidity exists. |
| **Liquidation bot** | A virtual userId (`SYSTEM_LIQUIDATION`) used to place liquidation orders. Exempt from margin requirements. |

### 2A.3 Implementation Steps

**Step 1 — Add `SYSTEM_LIQUIDATION` virtual userId to engine constants:**
```ts
// engine/src/constants.ts
export const LIQUIDATION_BOT_USER_ID = "SYSTEM_LIQUIDATION";
export const INSURANCE_FUND_USER_ID  = "SYSTEM_INSURANCE_FUND";
```

**Step 2 — Add `isLiquidation` flag to order types:**
```ts
// shared/src/messages.ts
export type perpsCreateOrderRequest = baseCreateOrderRequest<{
  leverage: number;
  isLiquidation?: boolean;   // NEW — bypasses margin validation
  liquidatedUserId?: string; // NEW — whose position is being liquidated
}>;
```

**Step 3 — Refactor `checkAndLiquidate` in `perps-exchange-store.ts`:**
```ts
checkAndLiquidate(market: string, markPrice: number): void {
  const bookPositions = this.perpsPosition.get(market);
  if (!bookPositions) return;

  for (const [userId, position] of bookPositions) {
    const shouldLiquidate =
      position.side === "long"  ? markPrice <= position.liquidationPrice :
      position.side === "short" ? markPrice >= position.liquidationPrice : false;

    if (!shouldLiquidate) continue;

    const bankruptcyPrice = position.side === "long"
      ? position.entryPrice * (1 - 1 / position.leverage)
      : position.entryPrice * (1 + 1 / position.leverage);

    // Place a market order on behalf of LIQUIDATION_BOT (opposite side, reduce-only)
    const liquidationOrder = this.createPerpsOrder({
      userId:           LIQUIDATION_BOT_USER_ID,
      market,
      side:             position.side === "long" ? "sell" : "buy",
      orderType:        "market",
      price:            markPrice,        // reference price only (market order)
      quantity:         position.quantity,
      leverage:         1,               // LIQUIDATION_BOT needs no leverage
      reduceOnly:       true,
      isLiquidation:    true,
      liquidatedUserId: userId,
    });

    // After fills: compute surplus/deficit vs bankruptcy price
    for (const fill of liquidationOrder.fills) {
      const surplusPerUnit = position.side === "long"
        ? fill.price - bankruptcyPrice
        : bankruptcyPrice - fill.price;
      const surplus = surplusPerUnit * fill.qty;

      if (surplus >= 0) {
        // Fill was better than bankruptcy — surplus to insurance fund
        balanceStore.credit(INSURANCE_FUND_USER_ID, "USDT", surplus);
      } else {
        // Fill worse than bankruptcy — draw from insurance fund
        const fundBalance = balanceStore.getBalance(INSURANCE_FUND_USER_ID)?.get("USDT") ?? 0;
        if (fundBalance >= Math.abs(surplus)) {
          balanceStore.deductLocked(INSURANCE_FUND_USER_ID, "USDT", Math.abs(surplus));
        } else {
          // Insurance fund exhausted — trigger ADL for the remaining shortfall
          this.triggerADL(market, position.side === "long" ? "short" : "long", Math.abs(surplus) - fundBalance);
        }
      }
    }

    // Publish liquidation event to the user
    publishUserEvent(userId, {
      type: "liquidation",
      userId,
      market,
      side: position.side,
      markPrice,
      liquidationPrice: position.liquidationPrice,
      bankruptcyPrice,
      marginLost: position.margin,
    }).catch(console.error);
  }
}
```

**Step 4 — Bypass margin check for liquidation orders in `createPerpsOrder`:**
```ts
createPerpsOrder(data: perpsCreateOrderRequest) {
  // Skip margin lock for LIQUIDATION_BOT — it has no balance to lock
  if (data.userId !== LIQUIDATION_BOT_USER_ID) {
    // ... existing margin lock logic ...
  }
  // ... rest of matching logic unchanged ...
}
```

**Step 5 — ADL (Auto-Deleveraging):**
ADL is complex; implement as a stub first, then complete:
```ts
triggerADL(market: string, side: "long" | "short", shortfall: number): void {
  // Get all open positions on the given side, sorted by unrealized PnL descending
  // (most profitable positions are deleveraged first)
  const positions = [...(this.perpsPosition.get(market)?.values() ?? [])]
    .filter(p => p.side === side && p.status === "OPEN")
    .sort((a, b) => b.unrealizedPnl - a.unrealizedPnl);

  let remaining = shortfall;
  for (const pos of positions) {
    if (remaining <= 0) break;
    // Force-close this position at mark price, no premium/discount
    // Credit their account at bankruptcy price (they absorb the loss)
    // Emit ADL event to affected user
    publishUserEvent(pos.userId, {
      type: "adl",
      userId: pos.userId,
      market,
      amountAbsorbed: Math.min(remaining, pos.margin),
    }).catch(console.error);
    remaining -= pos.margin;
  }
}
```

**Step 6 — Add to Prisma schema:**
```prisma
model InsuranceFundEvent {
  id        String   @id @default(uuid())
  market    String
  amount    Decimal  @db.Decimal(20, 8)  // positive = inflow, negative = outflow
  reason    String   // "liquidation_surplus" | "liquidation_deficit" | "adl"
  createdAt DateTime @default(now())
  @@index([market, createdAt])
}
```

**Step 7 — Add `adl` event to shared events:**
```ts
// shared/src/events.ts
export interface ADLEvent {
  type: "adl";
  userId: string;
  market: string;
  amountAbsorbed: number;
}
export type UserEvent = FillEvent | PositionUpdateEvent | LiquidationEvent | ADLEvent | FundingPaymentEvent;
```

### 2A.4 Why This Matters

- The existing `checkAndLiquidate` directly sets position to closed and seizes margin at
  mark price — that is not how any real exchange works. A $50k position being liquidated
  at a fixed price with no counterparty participation is incorrect.
- By routing through the orderbook: if there are resting orders, the liquidation fills at
  those prices (potentially better than mark); if the book is empty, the liquidation order
  goes unfilled and ADL is triggered.
- The insurance fund exists precisely to handle the gap between liquidation price and
  bankruptcy price — without it, every losing liquidation is a free loss.

### 2A.5 Migration Checklist — Phase 2A

- [ ] Add `engine/src/constants.ts` with LIQUIDATION_BOT and INSURANCE_FUND user IDs
- [ ] Add `isLiquidation` + `liquidatedUserId` fields to `perpsCreateOrderRequest`
- [ ] Refactor `checkAndLiquidate` to call `createPerpsOrder` instead of direct seize
- [ ] Add bypass in `createPerpsOrder` for `LIQUIDATION_BOT_USER_ID` margin check
- [ ] Add `computeBankruptcyPrice` helper function
- [ ] Implement `triggerADL` stub (log only for now, full implementation later)
- [ ] Add `InsuranceFundEvent` Prisma model and migration
- [ ] Add `adl` event type to `shared/src/events.ts`
- [ ] Seed insurance fund with initial balance for testability
- [ ] Test: open 100x long → drive mark price below liq price → observe liquidation order in book
- [ ] Test: liquidation fills at better-than-bankruptcy → insurance fund balance increases
- [ ] Test: no resting orders → liquidation order unfilled → ADL stub logs

---

## Phase 2B — Snapshot & Replay (WAL + State Checkpointing)

### Goal
Replace the naive "read all open orders from DB on restart" approach with a proper
Write-Ahead Log (WAL) + periodic state snapshot pattern. This gives:
- Sub-second engine restarts (replay only the delta since last snapshot)
- Guaranteed no state loss (every mutation is logged before being applied)
- Ability to replay the engine's history for debugging or audit

### 2B.1 Core Concepts

```
Time ─────────────────────────────────────────────────────▶

snapshot-1        snapshot-2        snapshot-3
    │                 │                 │
    ├── WAL entry ────┼── WAL entry ────┼── WAL entry ──▶  current
    ├── WAL entry     ├── WAL entry     ├── WAL entry
    └── WAL entry     └── WAL entry     └── WAL entry

On restart:
  1. Load latest snapshot  (snapshot-3)
  2. XRANGE wal_stream snapshot-3.walCursor +  ← replay only the delta
  3. Apply delta to in-memory state
  4. Engine is live
```

### 2B.2 WAL Event Types

Every state-changing operation the engine performs must append a WAL entry BEFORE
(or atomically with) mutating in-memory state:

```ts
// shared/src/wal.ts
export type WalEventType =
  | "order_created"
  | "order_fill"
  | "order_cancelled"
  | "position_opened"
  | "position_updated"
  | "position_closed"
  | "balance_deposit"
  | "balance_deduct"
  | "balance_credit"
  | "balance_lock"
  | "balance_unlock"
  | "liquidation_triggered"
  | "funding_settled";

export interface WalEntry<T = unknown> {
  type: WalEventType;
  market?: string;
  userId?: string;
  data: T;
  timestamp: number;  // Date.now() at write time
}
```

### 2B.3 WAL Writer in Engine

```ts
// engine/src/wal/writer.ts
import { redis } from "../utils/redis.js";

export const WAL_STREAM = "wal_stream";
// Keep 7 days of WAL. At ~1000 trades/sec that's ~600M entries — use MAXLEN with APPROXIMATE trim
const WAL_MAXLEN = 10_000_000;  // tune based on throughput

export async function appendWAL(entry: WalEntry): Promise<string> {
  // XADD returns the auto-generated stream ID (used as WAL cursor in snapshots)
  return redis.xadd(
    WAL_STREAM,
    "MAXLEN", "~", WAL_MAXLEN.toString(),  // approximate trim for performance
    "*",
    "payload", JSON.stringify(entry)
  );
}
```

**Usage in stores — write WAL before mutating state:**
```ts
// In createOrder (spot-exchange-store.ts), before any balance mutation:
await appendWAL({ type: "order_created", market, userId, data: newOrder, timestamp: Date.now() });
balanceStore.lock(userId, asset, amount);  // in-memory mutation happens after WAL write

// After each fill:
await appendWAL({ type: "order_fill", market, data: { orderId, fillPrice, fillQty }, timestamp: Date.now() });
```

### 2B.4 Periodic State Snapshot

A snapshot captures the complete engine state at a known WAL cursor position:

```ts
// engine/src/wal/snapshot.ts
import { prisma } from "../db/client.js";
import { redis } from "../utils/redis.js";
import { WAL_STREAM } from "./writer.js";
import { spotExchangeStore } from "../store/spot-exchange-store.js";
import { perpsExchangeStore } from "../store/perps-exchange-store.js";
import { balanceStore } from "../store/balance-store.js";

const SNAPSHOT_INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS) || 5 * 60_000; // 5 min

export async function takeSnapshot(): Promise<void> {
  // Get the current WAL cursor — the last message ID in the stream
  const lastEntry = await redis.xrevrange(WAL_STREAM, "+", "-", "COUNT", "1");
  const walCursor = lastEntry?.[0]?.[0] ?? "0-0";

  const state = {
    balances:       balanceStore.serialize(),          // all userId→asset→{available, locked}
    spotOrders:     spotExchangeStore.serializeOpenOrders(),
    spotOrderBooks: spotExchangeStore.serializeOrderBooks(),
    perpsOrders:    perpsExchangeStore.serializeOpenOrders(),
    perpsPositions: perpsExchangeStore.serializePositions(),
    perpsOrderBooks:perpsExchangeStore.serializeOrderBooks(),
  };

  await prisma.engineSnapshot.create({
    data: {
      walCursor,
      state: JSON.stringify(state),
      createdAt: new Date(),
    }
  });

  console.log(`[snapshot] taken at walCursor=${walCursor}`);
}

export function startSnapshotLoop(): void {
  setInterval(() => takeSnapshot().catch(e => console.error("[snapshot] failed:", e)), SNAPSHOT_INTERVAL_MS);
}
```

**Add `serialize` / `restore` methods to each store:**
Each store needs two new methods:
- `serializeOpenOrders(): OpenOrder[]` — return all in-memory open orders as plain objects
- `restoreFromSnapshot(data: SnapshotData): void` — rebuild in-memory state from snapshot object

### 2B.5 Replay on Engine Restart

```ts
// engine/src/wal/replay.ts
import { prisma } from "../db/client.js";
import { redis } from "../utils/redis.js";
import { WAL_STREAM } from "./writer.js";
import { applyWalEntry } from "./apply.js";

export async function restoreFromSnapshotAndReplay(): Promise<void> {
  // 1. Load the most recent snapshot
  const snapshot = await prisma.engineSnapshot.findFirst({
    orderBy: { createdAt: "desc" }
  });

  if (!snapshot) {
    console.log("[replay] no snapshot found — starting fresh (or hydrating from DB)");
    await hydrateFromDB();  // fallback to Phase 2's DB hydration for the very first boot
    return;
  }

  // 2. Restore in-memory state from snapshot
  const state = JSON.parse(snapshot.state);
  balanceStore.restoreFromSnapshot(state.balances);
  spotExchangeStore.restoreFromSnapshot(state.spotOrders, state.spotOrderBooks);
  perpsExchangeStore.restoreFromSnapshot(state.perpsOrders, state.perpsPositions, state.perpsOrderBooks);
  console.log(`[replay] snapshot loaded (walCursor=${snapshot.walCursor})`);

  // 3. Replay WAL entries since the snapshot's cursor
  let cursor = snapshot.walCursor;
  let replayed = 0;

  while (true) {
    // XRANGE: read 500 entries after cursor (exclusive, hence the increment)
    const entries = await redis.xrange(WAL_STREAM, `(${cursor}`, "+", "COUNT", "500");
    if (!entries || entries.length === 0) break;

    for (const [msgId, fields] of entries) {
      const obj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
      const entry = JSON.parse(obj.payload) as WalEntry;
      applyWalEntry(entry);   // re-apply the mutation to in-memory state
      cursor = msgId;
      replayed++;
    }

    if (entries.length < 500) break;  // reached end of stream
  }

  console.log(`[replay] replayed ${replayed} WAL entries since snapshot`);
}
```

**`engine/src/wal/apply.ts`** — maps WAL event types back to in-memory mutations:
```ts
export function applyWalEntry(entry: WalEntry): void {
  switch (entry.type) {
    case "balance_deposit":
      balanceStore.credit(entry.data.userId, entry.data.asset, entry.data.amount);
      break;
    case "balance_lock":
      balanceStore.lock(entry.data.userId, entry.data.asset, entry.data.amount);
      break;
    case "order_fill":
      // find order in store, update filledQty + avgPrice
      spotExchangeStore.applyFill(entry.data);
      break;
    case "position_updated":
      perpsExchangeStore.applyPositionUpdate(entry.data);
      break;
    // ... one case per WalEventType ...
  }
}
```

### 2B.6 New Prisma Model

```prisma
model EngineSnapshot {
  id        String   @id @default(uuid())
  walCursor String                       // Redis stream ID at snapshot time
  state     Json                         // full serialized engine state
  createdAt DateTime @default(now())
  @@index([createdAt])
}
```

### 2B.7 Why This Approach (vs just reading from DB)

| Scenario | DB hydration only | WAL + snapshot |
|----------|------------------|----------------|
| 1M open orders | Load 1M rows from DB on start | Load snapshot (one JSON blob) + replay delta (tiny) |
| Engine crash mid-fill | Partial fill in memory, no DB write → state mismatch | WAL captured the fill intent before memory mutation → can replay exactly |
| Debugging a wrong state | No history | XRANGE wal_stream 0 + shows every mutation ever made |
| Hot reload | Minutes of DB queries | < 1 second snapshot restore + sub-second WAL replay |

### 2B.8 WAL Trimming Strategy

WAL grows forever without trimming. Strategy:
- `XADD ... MAXLEN ~ 10_000_000` — Redis trims approximately (efficient, not exact)
- After taking a snapshot: `XTRIM wal_stream MINID <snapshot.walCursor>` — trim everything before the snapshot cursor (we no longer need it for replay since snapshot covers it)
- Keep at least 2 snapshots worth of WAL as a safety margin

### 2B.9 Migration Checklist — Phase 2B

- [ ] Add `EngineSnapshot` Prisma model and migration
- [ ] Create `engine/src/wal/writer.ts` — `appendWAL(entry)`
- [ ] Create `engine/src/wal/snapshot.ts` — `takeSnapshot()` + `startSnapshotLoop()`
- [ ] Create `engine/src/wal/replay.ts` — `restoreFromSnapshotAndReplay()`
- [ ] Create `engine/src/wal/apply.ts` — `applyWalEntry()` for all event types
- [ ] Add `serialize` + `restoreFromSnapshot` methods to `BalanceStore`
- [ ] Add `serialize` + `restoreFromSnapshot` methods to `SpotExchangeStore`
- [ ] Add `serialize` + `restoreFromSnapshot` methods to `PerpsExchangeStore`
- [ ] Add WAL write calls in `balance-store.ts` for every mutation (lock, unlock, credit, deduct)
- [ ] Add WAL write calls in `spot-exchange-store.ts` (order create, fill, cancel)
- [ ] Add WAL write calls in `perps-exchange-store.ts` (same + position open/update/close)
- [ ] Call `restoreFromSnapshotAndReplay()` in `engine/src/index.ts` before main loop
- [ ] Call `startSnapshotLoop()` in `engine/src/index.ts` after main loop starts
- [ ] Add `SNAPSHOT_INTERVAL_MS` to `engine/.env`
- [ ] Test: fill 100 orders, kill engine, restart → all orders/positions back in memory
- [ ] Test: snapshot taken, WAL trimmed before cursor → restart still works from snapshot
- [ ] Benchmark: restart time with 10k open orders (should be < 1s with snapshot)

---

## Phase 3 — Decouple Binance: Mark Price Poller Service

### Goal
Move `BinancePriceWs` out of the engine into a standalone `mark-price-poller/` service.
Engine receives mark prices via `mark_price_stream` Redis stream instead of direct function calls.

### 3.1 Create `mark-price-poller/` Service

```
mark-price-poller/
  src/
    index.ts          ← main entry point
    binance-ws.ts     ← moved from engine/src/services/binance-ws.ts
  package.json
  tsconfig.json
  .env
```

**`mark-price-poller/src/index.ts`:**
```ts
import "dotenv/config";
import WebSocket from "ws";
import { redis } from "./redis.js";
import { MARK_PRICE_STREAM } from "shared/src/queue-names.js";

const MARKETS: Record<string, string> = {
  // binance symbol → our internal market
  "BTCUSDT": "BTC_USD",
  "ETHUSDT": "ETH_USD",
  // add more here without touching engine
};

function connect(symbol: string) {
  const url = `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@miniTicker`;
  const ws = new WebSocket(url);

  ws.on("message", async (data) => {
    const msg = JSON.parse(data.toString());
    const price = Number(msg.c);
    if (!price || isNaN(price)) return;

    const market = MARKETS[msg.s];
    if (!market) return;

    // XADD to mark_price_stream — engine reads this
    await redis.xadd(
      MARK_PRICE_STREAM,
      "*",
      "market", market,
      "price", price.toString(),
      "timestamp", Date.now().toString()
    );
    console.log(`[mark-price-poller] ${market} = ${price}`);
  });

  ws.on("close", () => setTimeout(() => connect(symbol), 3000));
  ws.on("error", (e) => console.error(`[mark-price-poller] ws error:`, e.message));
}

// Subscribe to all configured markets
for (const symbol of Object.keys(MARKETS)) {
  connect(symbol);
}
```

### 3.2 Engine: Read Mark Price from Stream

**File: `engine/src/index.ts`** — add a separate loop (or merge into main loop with multi-stream XREADGROUP):

```ts
// In main() — extend the XREADGROUP call to include MARK_PRICE_STREAM
const results = await redis.xreadgroup(
  "GROUP", ENGINE_CONSUMER_GROUP, ENGINE_CONSUMER_NAME,
  "COUNT", "10",
  "BLOCK", "100",       // short block so we alternate between order and price streams
  "STREAMS",
  SPOT_INCOMING_STREAM, PERPS_INCOMING_STREAM, MARK_PRICE_STREAM,
  ">", ">", ">"
);

// In processing loop:
if (streamName === MARK_PRICE_STREAM) {
  const { market, price } = raw;
  perpsExchangeStore.checkAndLiquidate(market, Number(price));
  await redis.xack(MARK_PRICE_STREAM, ENGINE_CONSUMER_GROUP, msgId);
  continue;
}
```

### 3.3 Remove Binance WS from Engine

- Delete `engine/src/services/binance-ws.ts`
- Remove `const bs = new BinancePriceWs(); bs.connect();` from `engine/src/index.ts`
- Remove `ws` from engine's `package.json` dependencies (no longer needed)

### 3.4 Why a Separate Stream (Not Direct Pub/Sub)

| Concern | Explanation |
|---------|-------------|
| Backpressure | If engine is behind, price updates queue up in stream instead of being dropped |
| Multiple markets | Add ETH_USD, SOL_USD without changing engine code — just expand MARKETS map |
| Swap source | Replace Binance WS with internal oracle by changing only `mark-price-poller` |
| Engine restart | On restart, engine can replay recent mark prices from stream to recalculate liquidation state |

### 3.5 Migration Checklist — Phase 3

- [ ] Create `mark-price-poller/` with own `package.json`, `tsconfig.json`
- [ ] Move and adapt `binance-ws.ts` → publishes to `mark_price_stream`
- [ ] Create consumer group for `MARK_PRICE_STREAM` in engine `ensureConsumerGroups()`
- [ ] Engine main loop reads from 3 streams (SPOT + PERPS + MARK_PRICE)
- [ ] Delete `engine/src/services/binance-ws.ts`
- [ ] Remove BinancePriceWs instantiation from `engine/src/index.ts`
- [ ] Test: set BTC price via mark-price-poller mock → engine triggers liquidation
- [ ] Test: engine restart → replays recent mark prices, liquidation state re-evaluated

---

## Phase 3A — Funding Rate

### Goal
Implement periodic funding rate settlement for perpetual futures. Every 8 hours (configurable),
longs pay shorts (or vice versa) based on the gap between the mark price and the index price.
This is the primary mechanism that keeps the perps price anchored to spot.

### 3A.1 What is Funding Rate and Why It Matters

Without funding rate, a perpetual future can trade at a persistent premium or discount to
spot indefinitely — there's no expiry to force convergence. Funding rate creates a continuous
cash flow incentive: if perps trade above spot, longs pay shorts (discouraging overbidding);
if below, shorts pay longs (discouraging overselling).

**Standard formula (simplified):**
```
premiumIndex   = (markPrice - indexPrice) / indexPrice
fundingRate    = clamp(premiumIndex, −0.0005, +0.0005)   // ±0.05% per 8h interval

notionalValue  = positionQuantity × markPrice
fundingPayment = notionalValue × fundingRate

  fundingRate > 0  →  longs  PAY  shorts  (mark > index, market overbought)
  fundingRate < 0  →  shorts PAY  longs   (mark < index, market oversold)
```

`indexPrice` = spot price from Binance (already available via `mark_price_stream`).
For a simpler v1, `markPrice == indexPrice` so fundingRate defaults to the configured
interest rate (0.01% / 8h). Add premium calculation in v2.

### 3A.2 New Service: `funding-timer/`

A dedicated service that emits a funding trigger to `funding_rate_stream` every 8 hours
(or on configured interval). Keeping this outside the engine ensures the timer is durable
across engine restarts.

```
funding-timer/
  src/
    index.ts    ← setInterval → XADD funding_rate_stream
  package.json
  .env          ← REDIS_URL, FUNDING_INTERVAL_MS
```

**`funding-timer/src/index.ts`:**
```ts
import "dotenv/config";
import { redis } from "./redis.js";
import { FUNDING_RATE_STREAM } from "shared/src/queue-names.js";

const INTERVAL_MS = Number(process.env.FUNDING_INTERVAL_MS) || 8 * 60 * 60 * 1000; // 8h

const MARKETS = (process.env.MARKETS || "BTC_USD,ETH_USD").split(",");

async function emitFundingTrigger() {
  for (const market of MARKETS) {
    await redis.xadd(
      FUNDING_RATE_STREAM,
      "*",
      "type",      "funding_trigger",
      "market",    market,
      "timestamp", Date.now().toString()
    );
    console.log(`[funding-timer] emitted trigger for ${market}`);
  }
}

// Emit once on startup (to catch up if missed), then on interval
emitFundingTrigger();
setInterval(emitFundingTrigger, INTERVAL_MS);
```

### 3A.3 Update Shared Queue Names

```ts
// shared/src/queue-names.ts — add:
export const FUNDING_RATE_STREAM  = "funding_rate_stream";
export const fundingRateChannel   = (market: string) => `market:${market}:funding_rate`;
```

### 3A.4 Update Shared Events

```ts
// shared/src/events.ts — add:
export interface FundingPaymentEvent {
  type: "funding_payment";
  userId: string;
  market: string;
  positionSide: "long" | "short";
  amount: number;        // positive = received, negative = paid from user's margin
  rate: number;          // the funding rate applied
  markPrice: number;
  notionalValue: number;
  timestamp: number;
}

export interface FundingRateAnnouncementEvent {
  type: "funding_rate";
  market: string;
  rate: number;
  markPrice: number;
  indexPrice: number;
  nextFundingAt: number;  // Unix timestamp ms
}

// Add to union types:
export type UserEvent   = FillEvent | PositionUpdateEvent | LiquidationEvent | ADLEvent | FundingPaymentEvent;
export type MarketEvent = OrderbookSnapshotEvent | MarkPriceEvent | FundingRateAnnouncementEvent;
```

### 3A.5 Engine: Read `funding_rate_stream` and Settle

**Add `FUNDING_RATE_STREAM` to `ensureConsumerGroups()` and to the XREADGROUP call:**
```ts
// engine/src/index.ts
const results = await redis.xreadgroup(
  "GROUP", ENGINE_CONSUMER_GROUP, ENGINE_CONSUMER_NAME,
  "COUNT", "10",
  "BLOCK", "100",
  "STREAMS",
  SPOT_INCOMING_STREAM, PERPS_INCOMING_STREAM, MARK_PRICE_STREAM, FUNDING_RATE_STREAM,
  ">", ">", ">", ">"
);

// In processing loop:
if (streamName === FUNDING_RATE_STREAM) {
  const { market } = raw;
  await perpsExchangeStore.settleFunding(market);
  await redis.xack(FUNDING_RATE_STREAM, ENGINE_CONSUMER_GROUP, msgId);
  continue;
}
```

**`settleFunding` method in `perps-exchange-store.ts`:**
```ts
async settleFunding(market: string): Promise<void> {
  const markPrice = this.lastMarkPrice.get(market);
  if (!markPrice) {
    console.warn(`[funding] no mark price for ${market}, skipping settlement`);
    return;
  }

  // v1: use a fixed interest rate (configurable). v2: compute from premium index.
  const FUNDING_RATE = 0.0001;  // 0.01% per 8h interval — typical baseline

  const bookPositions = this.perpsPosition.get(market);
  if (!bookPositions) return;

  const payments: { userId: string; amount: number; side: "long" | "short" }[] = [];

  for (const [userId, position] of bookPositions) {
    if (position.status !== "OPEN") continue;

    const notionalValue   = position.quantity * markPrice;
    let fundingPayment    = notionalValue * FUNDING_RATE;

    // Positive rate: longs pay, shorts receive
    if (position.side === "short") fundingPayment = -fundingPayment;  // shorts receive (negative deduction)

    // Deduct from or add to user's margin
    position.margin -= fundingPayment;
    payments.push({ userId, amount: -fundingPayment, side: position.side });

    // If margin went negative after funding → trigger liquidation
    if (position.margin <= 0) {
      this.checkAndLiquidate(market, markPrice);
    }

    // Publish event to user
    publishUserEvent(userId, {
      type: "funding_payment",
      userId,
      market,
      positionSide: position.side,
      amount: -fundingPayment,      // negative = paid, positive = received (from user's perspective)
      rate: FUNDING_RATE,
      markPrice,
      notionalValue,
      timestamp: Date.now(),
    }).catch(console.error);

    // Write to WAL
    appendWAL({
      type: "funding_settled",
      market,
      userId,
      data: { fundingPayment, rate: FUNDING_RATE, markPrice, notionalValue },
      timestamp: Date.now(),
    }).catch(console.error);
  }

  // Persist funding rate to DB
  writeFundingRate(market, FUNDING_RATE, markPrice, markPrice, payments);

  // Announce the rate on the market channel (so clients can display next funding rate)
  publishMarketEvent(market, {
    type: "funding_rate",
    market,
    rate: FUNDING_RATE,
    markPrice,
    indexPrice: markPrice,   // v1: index == mark
    nextFundingAt: Date.now() + 8 * 60 * 60 * 1000,
  }).catch(console.error);

  console.log(`[funding] settled ${market} at rate=${FUNDING_RATE} markPrice=${markPrice}, positions=${bookPositions.size}`);
}
```

**Track `lastMarkPrice` in engine** (updated every time `MARK_PRICE_STREAM` delivers a price):
```ts
// perps-exchange-store.ts — add field:
private lastMarkPrice: Map<string, number> = new Map();

// In checkAndLiquidate or a new updateMarkPrice() called from engine index.ts:
updateMarkPrice(market: string, price: number): void {
  this.lastMarkPrice.set(market, price);
  this.checkAndLiquidate(market, price);
}
```

### 3A.6 New Prisma Models

```prisma
model FundingRate {
  id           String          @id @default(uuid())
  market       String
  rate         Decimal         @db.Decimal(20, 10)
  markPrice    Decimal         @db.Decimal(20, 8)
  indexPrice   Decimal         @db.Decimal(20, 8)
  settledAt    DateTime        @default(now())
  payments     FundingPayment[]
  @@index([market, settledAt])
}

model FundingPayment {
  id            String      @id @default(uuid())
  userId        String
  user          User        @relation(fields: [userId], references: [id])
  market        String
  positionSide  String      // "long" | "short"
  amount        Decimal     @db.Decimal(20, 8)  // negative = paid, positive = received
  fundingRateId String
  fundingRate   FundingRate @relation(fields: [fundingRateId], references: [id])
  settledAt     DateTime    @default(now())
  @@index([userId, market])
}
```

### 3A.7 Backend: New Funding Rate API Endpoints

Add to `backend/src/routes/market-route.ts`:
```
GET /perps/funding-rate/:market          ← current rate + next funding timestamp
GET /perps/funding-history/:market       ← paginated historical rates
GET /perps/funding-payments/:market      ← user's funding payment history (auth required)
```

### 3A.8 Migration Checklist — Phase 3A

- [ ] Create `funding-timer/` service
- [ ] Add `FUNDING_RATE_STREAM` to `shared/src/queue-names.ts`
- [ ] Add `FundingPaymentEvent` + `FundingRateAnnouncementEvent` to `shared/src/events.ts`
- [ ] Add `FundingRate` + `FundingPayment` Prisma models and run migration
- [ ] Add `lastMarkPrice` map to `perps-exchange-store.ts`; update on every mark price message
- [ ] Implement `settleFunding(market)` in `perps-exchange-store.ts`
- [ ] Add `FUNDING_RATE_STREAM` to engine `ensureConsumerGroups()` and XREADGROUP call
- [ ] Add `writeFundingRate` to `engine/src/db/writer.ts`
- [ ] Add funding rate backend routes (`GET /perps/funding-rate/:market`, etc.)
- [ ] Add `ADLEvent` to shared events (depends on Phase 2A)
- [ ] Test: trigger funding settlement manually → verify per-position margin deduction
- [ ] Test: long position pays when rate > 0; short position receives
- [ ] Test: funding pushes margin to 0 → liquidation triggered immediately after settlement
- [ ] Test: WS client subscribed to `/market` receives `funding_rate` announcement event

---

## Phase 4 — Engine Event Publishing

### Goal
After every fill and position update, the engine publishes events to Redis pub/sub channels.
These events power the WebSocket server in Phase 5.

### 4.1 What to Publish and Where

| Event | Channel | Trigger | Shape |
|-------|---------|---------|-------|
| Fill (taker) | `user:{takerId}:events` | After every fill | `FillEvent` |
| Fill (maker) | `user:{makerId}:events` | After every fill | `FillEvent` |
| Order update | `user:{userId}:events` | After status change | `OrderUpdateEvent` |
| Position update | `user:{userId}:events` | After `updatePositionFromFill` | `PositionUpdateEvent` |
| Liquidation | `user:{userId}:events` | After `checkAndLiquidate` closes position | `LiquidationEvent` |
| Orderbook snapshot | `market:{symbol}:orderbook` | After any fill (orderbook changed) | `OrderbookSnapshotEvent` |

### 4.2 Create `engine/src/publisher.ts`

```ts
import { redis } from "./utils/redis.js";
import { userEventsChannel, orderbookChannel } from "shared/src/queue-names.js";
import type { UserEvent, OrderbookSnapshotEvent } from "shared/src/events.js";

export async function publishUserEvent(userId: string, event: UserEvent): Promise<void> {
  await redis.publish(userEventsChannel(userId), JSON.stringify(event));
}

export async function publishOrderbookSnapshot(market: string, bids: [string, string][], asks: [string, string][]): Promise<void> {
  const event: OrderbookSnapshotEvent = {
    type: "orderbook_snapshot",
    market,
    bids,
    asks,
    timestamp: Date.now(),
  };
  await redis.publish(orderbookChannel(market), JSON.stringify(event));
}
```

### 4.3 Call Publisher from Stores

**In `spot-exchange-store.ts`:**
```ts
// After match loop completes, for each fill:
for (const fill of newFills) {
  await publishUserEvent(takerUserId, {
    type: "fill",
    orderId: incomingOrder.id,
    market,
    side: incomingOrder.side,
    price: fill.price,
    quantity: fill.qty,
    fee: 0,
    timestamp: Date.now(),
  });
  await publishUserEvent(makerUserId, { /* same shape, different orderId */ });
}
// After updating orderbook:
await publishOrderbookSnapshot(market,
  bids.map(o => [o.price.toString(), o.remainingQuantity.toString()]),
  asks.map(o => [o.price.toString(), o.remainingQuantity.toString()])
);
```

**In `perps-exchange-store.ts`:**
```ts
// After updatePositionFromFill():
await publishUserEvent(userId, {
  type: "position_update",
  userId,
  market,
  side: position.side,
  quantity: position.quantity,
  entryPrice: position.entryPrice,
  liquidationPrice: position.liquidationPrice,
  unrealizedPnl: /* calculate */ 0,
  margin: position.margin,
  leverage: position.leverage,
});

// After checkAndLiquidate closes a position:
await publishUserEvent(userId, {
  type: "liquidation",
  userId,
  market,
  side: position.side,
  markPrice,
  liquidationPrice: position.liquidationPrice,
  marginLost: position.margin,
});
```

**Important:** `publishUserEvent` / `publishOrderbookSnapshot` must be called asynchronously
but without blocking the matching loop. Use fire-and-forget (`.catch(console.error)`):

```ts
publishUserEvent(userId, event).catch(e => console.error("[publisher]", e));
```

### 4.4 Migration Checklist — Phase 4

- [ ] Create `engine/src/publisher.ts`
- [ ] Add fill event publish in `spot-exchange-store.ts` (taker + maker)
- [ ] Add fill event publish in `perps-exchange-store.ts` (taker + maker)
- [ ] Add position update publish in `perps-exchange-store.ts`
- [ ] Add liquidation event publish in `perps-exchange-store.ts`
- [ ] Add orderbook snapshot publish in both stores after each match
- [ ] Test: place order, check Redis SUBSCRIBE shows fill event on correct channel

---

## Phase 5 — WebSocket Server

### Goal
New `ws-server/` service that maintains WebSocket connections from clients and relays
Redis pub/sub events in real time. Two namespaces:
- `/user` — authenticated user receives fills, position updates, liquidations
- `/market` — public; receive orderbook snapshots for a market

### 5.1 Service Structure

```
ws-server/
  src/
    index.ts            ← HTTP server + WebSocket upgrade handler
    auth.ts             ← JWT verification (reuse from backend/src/utils/auth.ts)
    user-handler.ts     ← manage /user connections + subscriptions
    market-handler.ts   ← manage /market connections + subscriptions
    redis-sub.ts        ← single shared Redis subscriber connection
  package.json
  tsconfig.json
  .env
```

### 5.2 Connection Protocol

**Client → WS Server messages:**
```json
// Authenticate (must be first message on /user)
{ "type": "auth", "token": "<jwt>" }

// Subscribe to a market orderbook
{ "type": "subscribe_market", "market": "BTC_USD" }

// Unsubscribe
{ "type": "unsubscribe_market", "market": "BTC_USD" }
```

**WS Server → Client messages:**
```json
// Auth result
{ "type": "auth_ok", "userId": "..." }
{ "type": "auth_error", "message": "Invalid token" }

// User events (fill, position_update, liquidation)
{ "type": "fill", "orderId": "...", "market": "BTC_USD", "price": 45000, "quantity": 0.1, ... }
{ "type": "position_update", "market": "BTC_USD", "side": "long", ... }
{ "type": "liquidation", "market": "BTC_USD", ... }

// Market events
{ "type": "orderbook_snapshot", "market": "BTC_USD", "bids": [...], "asks": [...], "timestamp": ... }
```

### 5.3 `ws-server/src/index.ts`

```ts
import "dotenv/config";
import http from "http";
import { WebSocket, WebSocketServer } from "ws";
import { handleUserConnection } from "./user-handler.js";
import { handleMarketConnection } from "./market-handler.js";

const PORT = Number(process.env.WS_PORT) || 4000;
const server = http.createServer();
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url!, `http://localhost`);
  if (url.pathname === "/user") {
    wss.handleUpgrade(req, socket, head, (ws) => handleUserConnection(ws, req));
  } else if (url.pathname === "/market") {
    wss.handleUpgrade(req, socket, head, (ws) => handleMarketConnection(ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => console.log(`[ws-server] listening on :${PORT}`));
```

### 5.4 `ws-server/src/redis-sub.ts`

```ts
// Single shared subscriber connection — all subscriptions use one connection
import { makeRedisClient } from "./redis.js";
import type { UserEvent, MarketEvent } from "shared/src/events.js";

const redisSub = makeRedisClient();

type Callback = (event: UserEvent | MarketEvent) => void;
const listeners = new Map<string, Set<Callback>>();

redisSub.on("message", (channel: string, raw: string) => {
  const event = JSON.parse(raw);
  listeners.get(channel)?.forEach(cb => cb(event));
});

export async function subscribeChannel(channel: string, cb: Callback): Promise<void> {
  if (!listeners.has(channel)) {
    listeners.set(channel, new Set());
    await redisSub.subscribe(channel);
  }
  listeners.get(channel)!.add(cb);
}

export async function unsubscribeChannel(channel: string, cb: Callback): Promise<void> {
  const set = listeners.get(channel);
  if (!set) return;
  set.delete(cb);
  if (set.size === 0) {
    listeners.delete(channel);
    await redisSub.unsubscribe(channel);  // only unsubscribe from Redis when no listeners remain
  }
}
```

### 5.5 `ws-server/src/user-handler.ts`

```ts
import type { WebSocket, IncomingMessage } from "ws";
import { verifyToken } from "./auth.js";
import { subscribeChannel, unsubscribeChannel } from "./redis-sub.js";
import { userEventsChannel } from "shared/src/queue-names.js";

export function handleUserConnection(ws: WebSocket, req: IncomingMessage) {
  let userId: string | null = null;
  let redisCb: ((event: unknown) => void) | null = null;

  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "auth") {
      try {
        const payload = verifyToken(msg.token);
        userId = payload.userId;

        // Subscribe to user's event channel in Redis
        redisCb = (event) => ws.send(JSON.stringify(event));
        await subscribeChannel(userEventsChannel(userId), redisCb);

        ws.send(JSON.stringify({ type: "auth_ok", userId }));
        console.log(`[ws-server] user ${userId} connected`);
      } catch {
        ws.send(JSON.stringify({ type: "auth_error", message: "Invalid token" }));
        ws.close();
      }
    }
  });

  ws.on("close", async () => {
    if (userId && redisCb) {
      await unsubscribeChannel(userEventsChannel(userId), redisCb);
      console.log(`[ws-server] user ${userId} disconnected`);
    }
  });
}
```

### 5.6 `ws-server/src/market-handler.ts`

```ts
import type { WebSocket } from "ws";
import { subscribeChannel, unsubscribeChannel } from "./redis-sub.js";
import { orderbookChannel } from "shared/src/queue-names.js";

export function handleMarketConnection(ws: WebSocket, _req: unknown) {
  const subscribed = new Map<string, (e: unknown) => void>();

  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "subscribe_market") {
      const { market } = msg;
      if (subscribed.has(market)) return;
      const cb = (event: unknown) => ws.send(JSON.stringify(event));
      subscribed.set(market, cb);
      await subscribeChannel(orderbookChannel(market), cb);
    }

    if (msg.type === "unsubscribe_market") {
      const cb = subscribed.get(msg.market);
      if (cb) {
        await unsubscribeChannel(orderbookChannel(msg.market), cb);
        subscribed.delete(msg.market);
      }
    }
  });

  ws.on("close", async () => {
    for (const [market, cb] of subscribed) {
      await unsubscribeChannel(orderbookChannel(market), cb);
    }
  });
}
```

### 5.7 Migration Checklist — Phase 5

- [ ] Create `ws-server/` with own `package.json`, `tsconfig.json`, `.env`
- [ ] Implement `index.ts`, `redis-sub.ts`, `user-handler.ts`, `market-handler.ts`
- [ ] Copy `verifyToken` logic into `ws-server/src/auth.ts` (or import from shared)
- [ ] Test: connect to `ws://localhost:4000/user`, authenticate, place order, observe fill event
- [ ] Test: connect to `ws://localhost:4000/market`, subscribe to BTC_USD, observe orderbook updates
- [ ] Test: disconnect client → unsubscribed from Redis (no memory leak)

---

## Phase 6 — Poller Service

### Goal
Periodically snapshot the orderbook from DB and write timestamped files (as shown in the
diagram with `orderbook_19_march_2026_9:15PM.txt`) AND publish to the Redis orderbook
channel so WS clients get snapshots on an interval even between fills.

### 6.1 Two Responsibilities

1. **File snapshots** — written to disk at configurable intervals (e.g., every 15 min)
   for historical analysis and backfill
2. **Live push** — publish `orderbook_snapshot` to Redis pub/sub at shorter interval (e.g.,
   every 1s) so WS clients see orderbook even when no trades happen

### 6.2 Service Structure

```
poller/
  src/
    index.ts          ← entry point, schedules snapshot loops
    db-reader.ts      ← reads latest orderbook snapshot from DB (OrderbookSnapshot model)
    file-writer.ts    ← writes timestamped snapshot files
    publisher.ts      ← publishes to orderbookChannel
  snapshots/          ← output directory for snapshot files
  package.json
  tsconfig.json
```

### 6.3 `poller/src/index.ts`

```ts
import "dotenv/config";
import { readLatestSnapshot } from "./db-reader.js";
import { writeSnapshotFile } from "./file-writer.js";
import { publishSnapshot } from "./publisher.js";

const MARKETS = (process.env.MARKETS || "BTC_USD,ETH_USD").split(",");
const LIVE_INTERVAL_MS = Number(process.env.LIVE_INTERVAL_MS) || 1000;     // 1s live push
const FILE_INTERVAL_MS = Number(process.env.FILE_INTERVAL_MS) || 900_000;  // 15min file snapshot

// Live push loop (short interval)
async function liveLoop() {
  while (true) {
    for (const market of MARKETS) {
      const snapshot = await readLatestSnapshot(market);
      if (snapshot) await publishSnapshot(market, snapshot);
    }
    await new Promise(r => setTimeout(r, LIVE_INTERVAL_MS));
  }
}

// File snapshot loop (long interval)
async function fileLoop() {
  while (true) {
    for (const market of MARKETS) {
      const snapshot = await readLatestSnapshot(market);
      if (snapshot) await writeSnapshotFile(market, snapshot);
    }
    await new Promise(r => setTimeout(r, FILE_INTERVAL_MS));
  }
}

liveLoop().catch(e => { console.error("[poller] live loop crashed:", e); process.exit(1); });
fileLoop().catch(e => { console.error("[poller] file loop crashed:", e); process.exit(1); });
```

### 6.4 `poller/src/file-writer.ts`

```ts
import fs from "fs/promises";
import path from "path";

const SNAPSHOTS_DIR = path.join(process.cwd(), "snapshots");

export async function writeSnapshotFile(market: string, snapshot: object) {
  await fs.mkdir(SNAPSHOTS_DIR, { recursive: true });
  const ts = new Date();
  const filename = `orderbook_${market}_${ts.getDate()}_${ts.toLocaleString("default", {month: "long"})}_${ts.getFullYear()}_${ts.getHours()}:${String(ts.getMinutes()).padStart(2, "0")}PM.txt`;
  const filepath = path.join(SNAPSHOTS_DIR, filename);
  await fs.writeFile(filepath, JSON.stringify(snapshot, null, 2));
  console.log(`[poller] wrote ${filepath}`);
}
```

### 6.5 Note: Engine Also Writes Snapshots to DB

For the poller to read from DB, the engine must write `OrderbookSnapshot` rows after each
fill (in the DB writer from Phase 2):

```ts
// engine/src/db/writer.ts — add:
export function writeOrderbookSnapshot(market: string, exchange: string, bids: unknown[], asks: unknown[]) {
  enqueueWrite(() =>
    prisma.orderbookSnapshot.create({
      data: { market, exchange, bids, asks }
    })
  );
}
```

And call from stores after each match, same as `publishOrderbookSnapshot` in Phase 4.

### 6.6 Migration Checklist — Phase 6

- [ ] Create `poller/` service
- [ ] Implement `db-reader.ts` using Prisma client
- [ ] Implement `file-writer.ts` with timestamped filenames matching diagram format
- [ ] Implement `publisher.ts` (thin wrapper around orderbookChannel PUBLISH)
- [ ] Engine writes `OrderbookSnapshot` rows to DB in `db/writer.ts`
- [ ] Verify file snapshots appear in `poller/snapshots/` directory
- [ ] Verify WS clients subscribed to `/market` receive periodic orderbook pushes without trading

---

## Phase 7 — Backend WebSocket Upgrade Route

### Goal
Allow clients to upgrade their HTTP backend connection to WebSocket for receiving
responses inline — useful for long-running order requests on slow markets.

This is **optional** based on client needs. If the frontend connects directly to `ws-server`
for all real-time data, this phase can be skipped. But if you want one endpoint:

```
ws://backend:3000/ws/user  →  upgrade to WS, proxied to ws-server user handler
```

OR: skip Phase 7 entirely — clients connect to `ws://ws-server:4000/user` directly.

**Recommendation:** Skip Phase 7 for now. Clients use:
- `http://backend:3000/*` for order/auth operations
- `ws://ws-server:4000/user` for user events
- `ws://ws-server:4000/market` for market data

---

## Phase 8 — Cleanup, Wire-up & Testing

### 8.1 Remove Deprecated Code

- [ ] Remove `backend/src/utils/broker.ts` — `startResponseLoop()` function entirely
- [ ] Remove `RESPONSE_QUEUE` env var from all `.env` files and docs
- [ ] Remove `responseQueue` field from engine request types in `shared/src/messages.ts`
- [ ] Delete `engine/src/services/binance-ws.ts`
- [ ] Delete unused `test-binance-ws.ts`, `test-binance-ws-native.ts` in root
- [ ] Remove `ws` from `engine/package.json` (moved to mark-price-poller)

### 8.2 Start-up Order

Services must start in this order:

```
1. Postgres (already running - Aiven)
2. Redis (already running - Upstash)
3. engine/              ← creates consumer groups, restores from snapshot+WAL, starts processing
4. mark-price-poller/   ← starts feeding mark_price_stream
5. funding-timer/       ← starts feeding funding_rate_stream on interval
6. backend/ (×N)        ← each subscribes to its own backend:{id}:responses channel
7. ws-server/           ← subscribes to user:* and market:* pub/sub channels
8. poller/              ← starts reading DB snapshots and pushing to orderbook channels
```

### 8.3 Docker Compose (for local dev)

```yaml
# docker-compose.yml
services:
  engine:
    build: ./engine
    env_file: ./engine/.env
    depends_on: []    # external Redis/Postgres

  mark-price-poller:
    build: ./mark-price-poller
    env_file: ./mark-price-poller/.env

  funding-timer:
    build: ./funding-timer
    env_file: ./funding-timer/.env
    # runs independently; engine reads from funding_rate_stream

  backend:
    build: ./backend
    ports: ["3000:3000"]
    env_file: ./backend/.env
    environment:
      BACKEND_INSTANCE_ID: backend-1    # unique per replica; use ${HOSTNAME} in k8s
    depends_on:
      engine:
        condition: service_started

  ws-server:
    build: ./ws-server
    ports: ["4000:4000"]
    env_file: ./ws-server/.env

  poller:
    build: ./poller
    env_file: ./poller/.env
    depends_on:
      engine:
        condition: service_started
```

### 8.4 End-to-End Test Scenarios

**Scenario 1: Order fill → real-time user event**
```bash
# Terminal 1: connect as user A
wscat -c ws://localhost:4000/user
> { "type": "auth", "token": "<token-A>" }
< { "type": "auth_ok", "userId": "user-A" }

# Terminal 2: connect as user B (maker)
wscat -c ws://localhost:4000/user
> { "type": "auth", "token": "<token-B>" }
< { "type": "auth_ok", "userId": "user-B" }

# Terminal 3: user B places limit buy at 40000
curl -X POST http://localhost:3000/spot/order ... -d '{"side":"buy","price":40000,...}'

# Terminal 4: user A places market sell (crosses with B's order)
curl -X POST http://localhost:3000/spot/order ... -d '{"side":"sell","orderType":"market",...}'

# Expect: Terminal 1 (user A) receives fill event
# Expect: Terminal 2 (user B) receives fill event
```

**Scenario 2: Multi-backend response isolation**
```bash
# Start two backends with different BACKEND_INSTANCE_IDs
BACKEND_INSTANCE_ID=backend-1 PORT=3000 bun run dev &
BACKEND_INSTANCE_ID=backend-2 PORT=3001 bun run dev &

# Send 100 concurrent requests equally to both
# All responses should be received by the correct backend
# No "unknown correlationId" warnings in logs
```

**Scenario 3: Mark price → liquidation → user event**
```bash
# 1. User opens 100x long BTC_USD position at 40000
# 2. Send mark price of 39600 via mark-price-poller mock
#    (or temporarily lower the liquidation trigger threshold in tests)
# 3. Expect: user receives { type: "liquidation", ... } on WS
# 4. Expect: position row in DB has status = "CLOSED"
```

**Scenario 4: Orderbook snapshot via poller**
```bash
wscat -c ws://localhost:4000/market
> { "type": "subscribe_market", "market": "BTC_USD" }
# Without any trades: receive periodic orderbook snapshots from poller
# After placing orders: receive immediate snapshots from engine
```

**Scenario 5: Engine restart — no data loss**
```bash
# 1. Place 5 limit orders across two users
# 2. Kill the engine process
# 3. Restart engine
# 4. Query GET /spot/order/:id — still returns orders from DB
# 5. Place new matching order — fills against existing open orders from in-memory (re-hydrated from DB)
# NOTE: on Phase 2 completion, implement hydration of in-memory store from DB on startup
```

### 8.5 Engine State Hydration on Restart

This is needed to make Phase 2 persistence complete. On startup, before processing any
new requests, the engine should load open orders and positions from DB back into memory:

```ts
// engine/src/store/hydrator.ts
import { prisma } from "../db/client.js";
import { spotExchangeStore } from "./spot-exchange-store.js";
import { perpsExchangeStore } from "./perps-exchange-store.js";
import { balanceStore } from "./balance-store.js";

export async function hydrateFromDB() {
  console.log("[hydrator] loading state from DB...");

  // Restore balances
  const balances = await prisma.balance.findMany();
  for (const b of balances) {
    balanceStore.setBalance(b.userId, b.asset, Number(b.available), Number(b.locked));
  }

  // Restore open spot orders into order books
  const openSpotOrders = await prisma.order.findMany({
    where: { status: { in: ["OPEN", "PARTIALLY_FILLED"] }, exchange: "SPOT" }
  });
  for (const o of openSpotOrders) {
    spotExchangeStore.restoreOrder(o);  // adds to order book without re-locking balance
  }

  // Restore open perps orders + positions
  const openPerpsOrders = await prisma.order.findMany({
    where: { status: { in: ["OPEN", "PARTIALLY_FILLED"] }, exchange: "PERPS" }
  });
  const openPositions = await prisma.position.findMany({ where: { status: "OPEN" } });
  for (const o of openPerpsOrders) perpsExchangeStore.restoreOrder(o);
  for (const p of openPositions)   perpsExchangeStore.restorePosition(p);

  console.log(`[hydrator] loaded ${balances.length} balances, ${openSpotOrders.length} spot orders, ${openPositions.length} positions`);
}
```

Call `await hydrateFromDB()` in `engine/src/index.ts` before starting the main loop.

---

## Complete File Change Inventory

### New Files

| Path | Description |
|------|-------------|
| `shared/package.json` | Shared package config |
| `shared/src/queue-names.ts` | All Redis key/stream/channel names (incl. WAL, funding) |
| `shared/src/events.ts` | Typed event payloads (incl. FundingPaymentEvent, ADLEvent) |
| `shared/src/messages.ts` | Engine request/response types (moved from engine) |
| `shared/src/wal.ts` | WAL entry types (WalEventType, WalEntry) |
| `mark-price-poller/package.json` | Mark price poller package |
| `mark-price-poller/src/index.ts` | Binance WS → XADD mark_price_stream |
| `mark-price-poller/.env` | REDIS_URL |
| `funding-timer/package.json` | Funding timer package |
| `funding-timer/src/index.ts` | setInterval → XADD funding_rate_stream every 8h |
| `funding-timer/.env` | REDIS_URL, FUNDING_INTERVAL_MS, MARKETS |
| `ws-server/package.json` | WS server package |
| `ws-server/src/index.ts` | HTTP upgrade router |
| `ws-server/src/redis-sub.ts` | Shared Redis subscriber |
| `ws-server/src/user-handler.ts` | /user WS handler |
| `ws-server/src/market-handler.ts` | /market WS handler |
| `ws-server/src/auth.ts` | JWT verification |
| `ws-server/.env` | REDIS_URL, JWT_SECRET, WS_PORT |
| `poller/package.json` | Poller package |
| `poller/src/index.ts` | Schedule loops |
| `poller/src/db-reader.ts` | Read from OrderbookSnapshot table |
| `poller/src/file-writer.ts` | Write timestamped snapshot files |
| `poller/src/publisher.ts` | Publish to orderbookChannel |
| `poller/.env` | DATABASE_URL, REDIS_URL, MARKETS, intervals |
| `engine/src/constants.ts` | LIQUIDATION_BOT_USER_ID, INSURANCE_FUND_USER_ID |
| `engine/src/db/writer.ts` | Async DB write queue (incl. writeFundingRate, writeInsuranceFundEvent) |
| `engine/src/db/client.ts` | Prisma client singleton for engine |
| `engine/src/store/hydrator.ts` | Fallback DB hydration for first boot (no snapshot yet) |
| `engine/src/publisher.ts` | Publish fill/position/liquidation/funding events to Redis pub/sub |
| `engine/src/wal/writer.ts` | appendWAL() — XADD to wal_stream before every state mutation |
| `engine/src/wal/snapshot.ts` | takeSnapshot() + startSnapshotLoop() |
| `engine/src/wal/replay.ts` | restoreFromSnapshotAndReplay() on startup |
| `engine/src/wal/apply.ts` | applyWalEntry() — re-applies WAL entries to in-memory state |

### Modified Files

| Path | Change |
|------|--------|
| `backend/src/utils/broker.ts` | XADD request, subscribe to own pub/sub channel |
| `backend/src/index.ts` | Call `initBroker()` instead of `startResponseLoop()` |
| `backend/.env` | Add `BACKEND_INSTANCE_ID` |
| `backend/prisma/schema.prisma` | Add Order, Fill, Position, Balance, OrderbookSnapshot, EngineSnapshot, FundingRate, FundingPayment, InsuranceFundEvent |
| `engine/src/index.ts` | XREADGROUP loop (5 streams: SPOT + PERPS + MARK_PRICE + FUNDING + WAL), ensureConsumerGroups, drainPending, restoreFromSnapshotAndReplay, startSnapshotLoop |
| `engine/src/handler.ts` | Add `isLiquidation` bypass path; no other changes |
| `engine/src/store/spot-exchange-store.ts` | appendWAL before mutations; publishUserEvent + publishOrderbookSnapshot + writeOrder + writeFill after matches; serialize/restoreFromSnapshot methods |
| `engine/src/store/perps-exchange-store.ts` | Same as above + writePosition, publishLiquidation, settleFunding, updateMarkPrice, triggerADL, lastMarkPrice map, serialize/restoreFromSnapshot |
| `engine/src/store/balance-store.ts` | appendWAL + writeBalance after every credit/deduct/lock/unlock; serialize/restoreFromSnapshot |
| `engine/package.json` | Add prisma client, remove ws dependency |

### Deleted Files

| Path | Reason |
|------|--------|
| `engine/src/services/binance-ws.ts` | Moved to mark-price-poller |
| `test-binance-ws.ts` | Superseded |
| `test-binance-ws-native.ts` | Superseded |

---

## Environment Variables Reference

### `backend/.env`
```env
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
JWT_SECRET=...
BACKEND_INSTANCE_ID=backend-1        # NEW — unique per process/pod
INCOMING_QUEUE=backend-to-engine     # becomes stream name prefix
ENGINE_TIMEOUT_MS=30000
PORT=3000
```

### `engine/.env`
```env
REDIS_URL=redis://...
DATABASE_URL=postgresql://...        # NEW — for DB persistence
INCOMING_QUEUE=backend-to-engine     # must match backend
SNAPSHOT_INTERVAL_MS=300000          # NEW — 5 min between state snapshots
```

### `mark-price-poller/.env`
```env
REDIS_URL=redis://...
MARK_PRICE_STREAM=mark_price_stream  # must match engine
```

### `funding-timer/.env`
```env
REDIS_URL=redis://...
FUNDING_INTERVAL_MS=28800000         # 8 hours in ms (8 * 60 * 60 * 1000)
MARKETS=BTC_USD,ETH_USD
```

### `ws-server/.env`
```env
REDIS_URL=redis://...
JWT_SECRET=...                       # same as backend
WS_PORT=4000
```

### `poller/.env`
```env
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
MARKETS=BTC_USD,ETH_USD
LIVE_INTERVAL_MS=1000
FILE_INTERVAL_MS=900000
```

---

## Architecture Diagrams

### Request/Response Flow (Post-Migration)

```
backend-1 (BACKEND_INSTANCE_ID=backend-1)
  │
  │ 1. XADD SPOT_incoming_stream * payload {..., backendId:"backend-1", correlationId:"abc"}
  ▼
Redis Stream: SPOT_incoming_stream
  │
  │ 2. XREADGROUP GROUP engine-group engine-consumer-1
  ▼
engine
  │ 3. process order, get result
  │
  │ 4. PUBLISH backend:backend-1:responses {"correlationId":"abc", "payload":{...}}
  ▼
Redis Pub/Sub: backend:backend-1:responses
  │
  │ 5. redisSub.on("message") fires in backend-1 only
  ▼
backend-1 pending map → resolve Promise → HTTP response to client

backend-2: subscribed to backend:backend-2:responses → never sees backend-1's messages ✓
```

### Event Flow (Post-Migration)

```
Client (user A) ──WS──▶ ws-server:/user ──SUB──▶ Redis user:userA:events
                                                         ▲
                                                         │ PUBLISH
                                                       engine
                                                         │ (after fill)
                         ws-server:/market ◀──SUB── Redis market:BTC_USD:orderbook
                                ▲                        ▲
                                │ WS push                │ PUBLISH
                         client subscribers           engine (after every match)
                                                      poller (every 1s from DB)
```

### Service Dependency Graph

```
         [Postgres] ◀─────────────── [engine] ───────────────▶ [Redis]
              │                          ▲                        │
              │                          │ XADD mark prices       │
              ▼                          │                        │
          [poller] ──────────────▶ [mark-price-poller]           │
              │                                                   │
              │ PUBLISH orderbook                                 │
              ▼                                                   │
          [Redis] ◀──────────────────────────────────────────────┘
              │
              │ SUB
              ▼
          [ws-server]
              │
              │ WS push
              ▼
    [Website / Mobile App]
              │
              │ HTTP
              ▼
          [backend cluster]
```

---

## Implementation Order Recommendation

Do phases in strict order — each one is a testable checkpoint before the next begins.
Phases 2A, 2B, and 3A are inserted between their parent phases because they depend on the
infrastructure those phases establish.

| Step | Phase | What | Dependency |
|------|-------|------|-----------|
| 1 | **Phase 0** | Shared package, types, queue names | — |
| 2 | **Phase 1** | Redis Streams + per-backend pub/sub responses | Phase 0 |
| 3 | **Phase 3** | Mark price poller (decouple Binance first, before adding more engine logic) | Phase 1 |
| 4 | **Phase 2** | DB persistence (orders, fills, positions, balances) | Phase 1 |
| 5 | **Phase 2A** | Liquidation orders via orderbook (needs DB to persist liquidation orders as normal orders) | Phase 2 + Phase 3 (mark price from stream) |
| 6 | **Phase 2B** | WAL + snapshot/replay (builds on DB persistence; replaces Phase 8's hydration) | Phase 2 |
| 7 | **Phase 3A** | Funding rate (needs mark price stream from Phase 3 + DB models from Phase 2) | Phase 2 + Phase 3 |
| 8 | **Phase 4** | Engine event publishing (fill/position/liquidation/funding events) | Phase 2A + Phase 3A |
| 9 | **Phase 5** | WebSocket server (needs Phase 4 pub/sub events to relay) | Phase 4 |
| 10 | **Phase 6** | Poller (orderbook snapshots from DB → WS + disk files) | Phase 2 + Phase 5 |
| 11 | **Phase 8** | Cleanup, Docker Compose, end-to-end tests | All phases |

**Rule:** Each phase ends with a passing, manually-verified test scenario before committing
and moving to the next phase. No half-phases — a phase is either complete or not started.

### Start-up Order (Final System)

```
1. Postgres              (external — Aiven)
2. Redis                 (external — Upstash)
3. engine/               ← creates consumer groups, restores from snapshot+WAL, starts loop
4. mark-price-poller/    ← starts feeding mark_price_stream
5. funding-timer/        ← starts funding interval loop
6. backend/ (N replicas) ← each subscribes to its own response channel
7. ws-server/            ← subscribes to user:* and market:* channels
8. poller/               ← starts reading DB snapshots, publishing to orderbook channels
```
