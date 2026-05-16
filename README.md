# cex-v2-boilercode

A minimal centralized-exchange boilerplate.

Two processes:

- `backend/` — Express API:
  - auth with Postgres
  - forwards order commands to engine over Redis request/response queues

- `engine/` — single worker:
  - consumes Redis queue
  - owns the in-memory order book

---

# Prisma Workflow

Every schema change follows 3 steps:

```bash
# 1. Edit schema
schema.prisma

# 2. Create migration
bunx prisma migrate dev --name <change_name>

# 3. Regenerate Prisma client
bunx prisma generate
```

---

# Redis CLI

```bash
redis-cli -u "$REDIS_URL"
```

---

# Request Flow

```text
curl
  ↓
backend HTTP
  ↓
controller
  ↓
sendToEngine()
  ↓
Redis (backend-to-engine-broker)
  ↓
engine BRPOP
  ↓
handler (stub)
  ↓
Redis (response-queue-1)
  ↓
backend response loop
  ↓
resolve Promise
  ↓
HTTP response
  ↓
curl
```

---

# Detailed Order Flow

1. `curl` → `POST /api/v1/order/create`

2. backend:
   - `express.json()` parses request body

3. backend:
   - `authMiddleware` verifies JWT
   - sets `req.userId`

4. backend:
   - `createOrder` validates request using Zod
   - calls:

```ts
sendToEngine("create_order", ...)
```

5. backend:
   - `LPUSH backend-to-engine-broker`
   - attaches `correlationId`

---

## Redis Boundary

6. engine:
   - `BRPOP` unblocks
   - `JSON.parse`
   - `handleEngineRequest()` → stub handler

7. engine:
   - `LPUSH response-queue-1`
   - echoes same `correlationId`

---

## Backend Response Loop

8. backend:
   - response loop `BRPOP` unblocks
   - matches `correlationId`
   - resolves awaiting Promise

9. backend:

```ts
res.status(201).json(result)
```

---

# Architecture Diagram

```text
                    ┌──────────────────────────────────────┐
   HTTP clients ───▶│  backend (Express :3000)             │
                    │                                      │
                    │  auth → Postgres (Aiven)             │
                    │  orders → sendToEngine()             │
                    └──────────────┬───────────────┬───────┘
                                   │ LPUSH         │ BRPOP
                                   ▼               ▲
                    ┌──────────────────────────────────────┐
                    │         Redis (Upstash)              │
                    │                                      │
                    │  backend-to-engine-broker            │
                    │  response-queue-1                    │
                    └──────────────┬───────────────┬───────┘
                                   │ BRPOP         │ LPUSH
                                   ▼               ▲
                    ┌──────────────┴───────────────┴───────┐
                    │          engine (worker)             │
                    │                                      │
                    │  consumer loop → handler → store     │
                    └──────────────────────────────────────┘
```

---

# Setup

## 1. Install dependencies

```bash
cd backend && bun install
cd ../engine && bun install
```

---

## 2. Configure environment variables

Copy:

```bash
.env.example → .env
```

in both `backend/` and `engine/`.

Required:

- `DATABASE_URL`
- `REDIS_URL`

Important:

- `INCOMING_QUEUE` must match in both services
- `REDIS_URL` must point to the same Redis instance

---

## 3. Run database migrations

```bash
cd backend
bunx prisma migrate deploy
```

---

## 4. Start services

Start engine:

```bash
bun run dev
```

Start backend:

```bash
bun run dev
```

---

# Assignment / TODO

## Backend

### `backend/src/controllers/auth-controller.ts`

Implement:

- `signin`

---

## Engine

### `engine/src/store/exchange-store.ts`

Implement:

- price-time priority
- partial fills
- limit orders
- market orders
- order depth
- balances
- cancel order

---

### `engine/src/handler.ts`

Wire store methods into the request handler switch.

Replace placeholder:

```ts
throw new Error(...)
```

with actual implementations.