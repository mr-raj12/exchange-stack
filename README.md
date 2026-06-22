# Exchange Stack

A centralized crypto exchange backend with spot and perpetual-futures markets, built around
a single in-memory matching engine and a set of stateless services that talk to it over Redis.

The engine holds the order books and positions in memory for speed, and durability comes from
a write-ahead log plus periodic snapshots rather than from touching Postgres on the hot path.
Postgres is the audit trail and the cold-start source of truth; Redis Streams carry every
request into the engine and Redis pub/sub carries responses and live events back out.

## Architecture

```
            HTTP / WS
   clients ───────────────┐
                          │
        ┌─────────────────▼─────────────────┐        ┌──────────────────────┐
        │   backend (Express, :3000, ×N)     │        │   ws-server (:4000)  │
        │   auth · validate · route          │        │   /user   /market    │
        └───────┬───────────────────▲────────┘        └───────────▲──────────┘
                │ XADD               │ SUB                         │ SUB
                │ *_incoming_stream  │ backend:{id}:responses      │ user:{id}:events
                │                    │                             │ market:{m}:orderbook
                ▼                    │                             │
        ┌───────────────────────────┴─────────────────────────────┴──────────┐
        │                              Redis                                   │
        │  Streams:  SPOT_incoming · PERPS_incoming · mark_price · funding     │
        │            wal_stream                                                │
        │  Pub/Sub:  backend:* · user:* · market:*                            │
        └───────▲───────────────┬───────────────────────────────▲────────────┘
                │ XADD           │ XREADGROUP (group: engine-group)│ PUBLISH
                │                ▼                                 │
   ┌────────────┴──────┐  ┌─────────────────────────────┐         │
   │ mark-price-poller │  │           engine            │─────────┘
   │  Binance WS       │  │  spot book · perps book      │
   └───────────────────┘  │  positions · balances        │──────► Postgres
   ┌───────────────────┐  │  WAL + snapshots             │   orders / fills /
   │  funding-timer    │  └──────────────┬──────────────┘   positions / snapshots
   │  interval trigger │                 │ writes snapshots
   └───────────────────┘                 ▼
                                   ┌─────────────┐  reads snapshots, republishes
                                   │   poller    │  to market:* + writes disk files
                                   └─────────────┘
```

Postgres and Redis are external (the project was developed against Aiven Postgres and Upstash
Redis); they are not part of `docker-compose`.

### Why these choices

- **Redis Streams for requests, not a list + `BRPOP`.** A consumer group means the engine reads
  each message exactly once, unacknowledged messages stay in the pending list if the engine dies
  mid-process, and history is replayable. Backpressure is visible via stream length.
- **Per-backend pub/sub for responses.** Each backend subscribes only to `backend:{id}:responses`,
  so adding replicas never causes one instance to consume another's reply.
- **WAL + snapshots instead of writing state to Postgres synchronously.** The matching loop never
  blocks on the database. State is reconstructed on restart by loading the latest snapshot and
  replaying only the WAL delta after it. Postgres writes are fire-and-forget for the audit trail.
- **Mark price as its own service.** Swapping Binance for an internal oracle is a change to one
  service, and a slow engine queues prices in the stream instead of dropping them.

## Contents

- [Architecture](#architecture)
- [Overview](#overview)
- [Features](#features)
- [Request and event lifecycle](#request-and-event-lifecycle)
- [Data model](#data-model)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Running locally](#running-locally)
- [HTTP API](#http-api)
- [WebSocket API](#websocket-api)
- [Operational notes](#operational-notes)
- [Testing](#testing)
- [Known limitations](#known-limitations)

## Overview

The system is split into six runnable services plus one shared library. The split exists so
that the matching engine stays single-threaded and authoritative while everything around it
(HTTP, price feeds, websockets, snapshot publishing) can scale or restart independently.

- **backend** — Express HTTP API. Auth, validation, and request forwarding. Stateless, so you
  can run N replicas behind a load balancer. Each replica has a unique `BACKEND_INSTANCE_ID`
  and only receives the responses addressed to it.
- **engine** — the single matching process. Owns spot order books, perps order books, positions,
  and balances in memory. Consumes four Redis streams, writes a WAL, snapshots to Postgres,
  and publishes fills/positions/orderbook events.
- **mark-price-poller** — subscribes to Binance and feeds mark prices into the engine.
- **funding-timer** — emits a funding-settlement trigger per market on a fixed interval.
- **ws-server** — fans out user events and market data to browser/mobile clients over WebSocket.
- **poller** — reads order-book snapshots from Postgres and republishes them, and writes
  periodic snapshot files to disk.
- **shared** — stream names, channel-name builders, request/response types, event types, WAL types.
  Imported by every service via `file:../shared` so message shapes can't drift between processes.

## Features

**Spot trading**
- Limit and market orders with price-time priority and partial fills
- Order-book depth queries and cancellation
- Per-asset balances with available/locked accounting

**Perpetual futures**
- Leveraged positions with margin tracking and a computed liquidation price
- Position lifecycle: open, increase, partial close, full close, and side flip, with realized PnL
- Liquidation routed through the order book (not a fixed-price seize) so price discovery is real
- Insurance fund absorbs liquidation surplus/deficit; auto-deleveraging (ADL) as the backstop
- Funding-rate settlement on a fixed interval (longs pay shorts or vice versa)
- `reduceOnly` orders

**Platform**
- Horizontal backend scaling with per-instance response routing (no response stealing)
- Redis Streams with a consumer group for request delivery, so messages survive an engine crash
- Write-ahead log + periodic state snapshots; sub-second restarts via snapshot load + WAL replay
- First-boot hydration from Postgres when no snapshot exists yet
- Real-time push of fills, position updates, liquidations, and order-book depth over WebSocket
- Full Postgres audit trail for orders, fills, positions, balances, funding, and insurance events

## Request and event lifecycle

Order placement (HTTP, synchronous to the caller):

```
client ─POST /spot/order─▶ backend
  backend: authMiddleware (JWT) → zod validation → sendToEngine()
  backend: XADD SPOT_incoming_stream  { type, data, correlationId, backendId }
  engine:  XREADGROUP → match → mutate books/balances → append WAL → queue DB writes
  engine:  PUBLISH backend:{backendId}:responses  { correlationId, payload }
  backend: pub/sub message resolves the pending promise by correlationId
  backend: HTTP 200 with the engine result
```

Real-time events (asynchronous, fire-and-forget from the engine):

```
engine ─PUBLISH user:{userId}:events──▶ ws-server ──▶ authenticated /user socket
engine ─PUBLISH market:{m}:orderbook─▶ ws-server ──▶ /market subscribers
poller ─PUBLISH market:{m}:orderbook─▶ ws-server   (periodic depth between fills)
```

Background loops:

```
mark-price-poller ─XADD mark_price_stream──▶ engine.updateMarkPrice() → liquidation checks
funding-timer     ─XADD funding_rate_stream▶ engine.settleFunding(market)
engine            ─XADD wal_stream──────────▶ replayed on next restart
```

## Data model

Postgres schema (Prisma). All money columns are `Decimal(20,8)`.

| Model | Purpose |
|-------|---------|
| `User` | Credentials and relations to orders/positions/balances |
| `Order` | Every order, with `filledQty`, `avgFillPrice`, `status`, `exchange` (SPOT/PERPS) |
| `Fill` | One row per match, with `makerSide` |
| `Position` | Open/closed perps positions: entry, liquidation price, margin, leverage, realized PnL |
| `Balance` | Per-user, per-asset available/locked, unique on `(userId, asset)` |
| `OrderbookSnapshot` | Periodic depth captures (bids/asks JSON) per market |
| `FundingRate` / `FundingPayment` | Settled funding rates and per-user payments |
| `InsuranceFundEvent` | Insurance-fund inflows and outflows with a reason |
| `EngineSnapshot` | Serialized engine state plus the `walCursor` it was taken at |

The engine keeps its own write-only copy of the schema (`engine/prisma`) with no relations and no
migrations — it never owns the database, it only writes to it. The backend owns migrations.

## Tech stack

- **Runtime:** Bun (TypeScript, ESM)
- **HTTP:** Express 5
- **Validation:** Zod
- **Auth:** JSON Web Tokens, bcrypt password hashing
- **Database:** PostgreSQL via Prisma 7 with the `@prisma/adapter-pg` driver adapter
- **Messaging:** Redis (ioredis) — Streams for requests/WAL, pub/sub for responses and events
- **WebSocket:** `ws`
- **External feed:** Binance miniTicker WebSocket
- **Packaging:** per-service Dockerfiles, `docker-compose` for local orchestration

## Repository layout

```
.
├── shared/              # types, stream/channel names, event + WAL definitions
├── backend/             # Express API, Prisma schema + migrations (source of truth)
│   └── src/
│       ├── controllers/ # auth, order, market, user, funding
│       ├── routes/      # spot/perps route trees
│       ├── middleware/  # JWT auth, spot-vs-perps queue selection
│       └── utils/       # broker (XADD + response subscription), redis, validation
├── engine/              # matching engine
│   └── src/
│       ├── store/       # spot book, perps book, balances, DB hydrator
│       ├── wal/         # writer, snapshot, replay, apply
│       ├── db/          # fire-and-forget write queue
│       ├── publisher.ts # user/market event publishing
│       └── index.ts     # 4-stream consumer loop
├── mark-price-poller/   # Binance WS → mark_price_stream
├── funding-timer/       # interval → funding_rate_stream
├── ws-server/           # /user and /market WebSocket fan-out
├── poller/              # DB snapshots → market channel + disk files
└── docker-compose.yml
```

## Running locally

### Prerequisites

- [Bun](https://bun.sh)
- A PostgreSQL database and a Redis instance (local or hosted)

### 1. Install

Each package installs independently:

```bash
for d in shared backend engine mark-price-poller funding-timer ws-server poller; do
  (cd "$d" && bun install)
done
```

### 2. Configure environment

Copy each service's `.env.example` to `.env` and fill in the values. The variables per service:

| Service | Variables |
|---------|-----------|
| backend | `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `PORT`, `BACKEND_INSTANCE_ID`, `ENGINE_TIMEOUT_MS` |
| engine | `DATABASE_URL`, `REDIS_URL`, `SNAPSHOT_INTERVAL_MS`, `INSURANCE_FUND_SEED_USD` (dev only) |
| mark-price-poller | `REDIS_URL` |
| funding-timer | `REDIS_URL`, `FUNDING_INTERVAL_MS`, `MARKETS` |
| ws-server | `REDIS_URL`, `JWT_SECRET` (same as backend), `WS_PORT` |
| poller | `DATABASE_URL`, `REDIS_URL`, `MARKETS`, `LIVE_INTERVAL_MS`, `FILE_INTERVAL_MS` |

`REDIS_URL` must point to the same Redis for every service, and `JWT_SECRET` must match between
backend and ws-server. `BACKEND_INSTANCE_ID` must be unique per backend replica.

### 3. Migrate the database

```bash
cd backend
bunx prisma migrate deploy
bunx prisma generate
```

### 4. Start services

Order matters — the engine creates the consumer groups the others publish into:

```bash
(cd engine            && bun run dev)   # 1. consumer groups, restore, snapshot loop
(cd mark-price-poller && bun run dev)   # 2. mark prices
(cd funding-timer     && bun run dev)   # 3. funding triggers
(cd backend           && bun run dev)   # 4. HTTP API on :3000
(cd ws-server         && bun run dev)   # 5. WebSocket on :4000
(cd poller            && bun run dev)   # 6. snapshot republish + files
```

### With Docker

`docker-compose` builds all six services. Postgres and Redis stay external, so each service's
`.env` must point at reachable instances before you bring the stack up:

```bash
docker compose up --build
```

## HTTP API

Base URL `http://localhost:3000`. Authenticated routes expect `Authorization: Bearer <jwt>`.

**Auth**

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/signup` | no | Create a user |
| POST | `/signin` | no | Return a JWT |

**Spot** (`/spot`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/spot/order` | yes | Place a limit or market order |
| POST | `/spot/order/cancel` | yes | Cancel an order |
| GET | `/spot/order/:id` | yes | Fetch an order |
| GET | `/spot/depth/:symbol` | no | Order-book depth |
| GET | `/spot/balance` | yes | Balances |
| POST | `/spot/deposit` | yes | Credit a balance |

**Perps** (`/perps`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/perps/order` | yes | Place a leveraged order |
| POST | `/perps/order/cancel` | yes | Cancel an order |
| GET | `/perps/order/:id` | yes | Fetch an order |
| GET | `/perps/depth/:symbol` | no | Order-book depth |
| GET | `/perps/balance` | yes | Balances |
| GET | `/perps/position/:market` | yes | One position |
| GET | `/perps/positions` | yes | All positions |
| GET | `/perps/funding/rate/:market` | no | Latest funding rate |
| GET | `/perps/funding/history/:market` | no | Funding-rate history |
| GET | `/perps/funding/payments/:market` | yes | Your funding payments |

**Health/debug:** `GET /health`, `GET /db-check`, `GET /debug/ping-engine`.

Order body fields: `market`, `side` (`buy`/`sell`), `orderType` (`limit`/`market`), `price`,
`quantity`, optional `reduceOnly`, and `leverage` for perps.

## WebSocket API

Base URL `ws://localhost:4000`.

**`/user`** — private events. Authenticate first, then receive everything published to your channel:

```jsonc
// client → server
{ "type": "auth", "token": "<jwt>" }
// server → client
{ "type": "auth_ok", "userId": "..." }
// then, as they happen: fills, order updates, position updates, liquidations, funding payments
```

**`/market`** — public order-book depth:

```jsonc
{ "type": "subscribe_market", "market": "BTC_USD" }
{ "type": "unsubscribe_market", "market": "BTC_USD" }
```

## Operational notes

- **Restarts.** On boot the engine loads the most recent `EngineSnapshot`, replays the `wal_stream`
  delta after its cursor, then starts consuming. If no snapshot exists (first deploy or a Redis
  flush), it hydrates open orders, positions, and balances from Postgres instead.
- **Snapshots.** Taken every `SNAPSHOT_INTERVAL_MS` (default 5 min); the WAL is trimmed ahead of
  the snapshot cursor so it doesn't grow without bound.
- **Liquidation.** When the mark price crosses a position's liquidation price, the engine submits a
  reduce-only market order on behalf of a system account. Fills better than the bankruptcy price
  feed the insurance fund; worse fills draw it down. If the fund is exhausted, ADL force-closes the
  most-profitable opposing positions. Seed the fund in dev with `INSURANCE_FUND_SEED_USD`.
- **Funding.** `funding-timer` emits a trigger per market every `FUNDING_INTERVAL_MS` (default 8h);
  the engine debits one side's margin and credits the other, and records the rate and per-user
  payments in Postgres.
- **Scaling backends.** Run multiple backend processes with distinct `BACKEND_INSTANCE_ID` values.
  The engine is intentionally a single process — it is the serialization point for matching.

## Testing

Shell-driven API and perps suites live at the repository root:

```bash
./smoke-test.sh     # quick end-to-end sanity check
./test-api.sh       # spot HTTP API coverage
./test-perps.sh     # perps lifecycle, funding, liquidation
```

Each service type-checks with `bunx tsc --noEmit`.

## Known limitations

- Funding uses `markPrice == indexPrice` (flat interest rate); a premium-index calculation is the
  intended v2.
- ADL is wired through the liquidation path but kept conservative; the deficit-distribution policy
  is a candidate for refinement.
- Postgres and Redis are assumed managed/external and are not provisioned by `docker-compose`.
