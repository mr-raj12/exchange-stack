# Exchange Store — Implementation Notes

## Starting State

The file had stub implementations that threw `"not implemented"` for all methods:
- `createOrder`, `cancelOrder`, `getOrder`, `getDepth`, `getUserBalance`

The `handler.ts` only returned a hardcoded stub for `create_order` and threw for everything else.

---

## What Was Built

### handler.ts
Wired each request type to the corresponding `exchangeStore` method.

Pattern for every case:
1. Cast `request.data` to the expected shape using a local type
2. Extract fields
3. Call the store method
4. Return the result

Used `as SomeType` cast per case (not Zod — data is already validated at the backend controller boundary). Used plain `type` aliases (not interfaces) since these are simple data contracts with no merging or extension needed.

All cases wrapped in `{}` to avoid block-scope redeclaration errors for `const data`.

---

## exchange-store.ts

### Data Structures

```ts
private static readonly MARKETS = ["BTC_USD", "ETH_USD", "ETH_BTC", "BTC_SOL"];
private static readonly ASSETS = new Set<string>(MARKETS.flatMap(m => m.split("_")));

private orderBooks = new Map<string, OrderBook>();   // market -> { bids, asks }
private orders    = new Map<string, Order>();         // orderId -> Order
private balance   = new Map<string, Map<string, number>>(); // userId -> asset -> amount
private locked    = new Map<string, Map<string, number>>(); // userId -> asset -> amount
```

- `MARKETS` and `ASSETS` are `static readonly` — belong to the class, not instances; never reassigned (but `.push()/.add()` is still allowed if markets need to change at runtime)
- `ASSETS` derived from `MARKETS` via `flatMap` — single source of truth
- `balance` = available balance; `locked` = reserved for open orders
- Quote currency derived per-call: `const [base, quote] = market.split("_")`

---

### Types Added to Order

```ts
export interface Order {
  orderId: string;
  userId: string;
  market: string;
  side: Side;
  price: number;
  quantity: number;          // added — original order quantity
  filledQuantity: number;
  avgPrice: number;          // added — running weighted average fill price
  orderType: OrderType;
  status: OrderStatus;       // added — OPEN | PARTIALLY_FILLED | FILLED | CANCELLED | PARTIALLY_CANCELLED
  fills: Fill[];             // added — list of individual fills
  timestamp: number;         // added — for price-time priority sorting
}

export type Fill = {
  price: number;
  quantity: number;
  timestamp: number;
}

export interface Depth {
  bids: DepthLevel[];
  asks: DepthLevel[];
}

export interface DepthLevel {
  price: number;
  count: number;
}
```

---

### Balance Helpers

Four helpers manage balance state. Understanding these is key to the whole system:

| Helper | What it does |
|--------|-------------|
| `lock(userId, asset, amount)` | Moves amount from `balance` → `locked` (reserves for open order) |
| `unlock(userId, asset, amount)` | Moves amount from `locked` → `balance` (refund on cancel or over-lock) |
| `deductLocked(userId, asset, amount)` | Removes from `locked` only — asset is being transferred to counterparty |
| `credit(userId, asset, amount)` | Adds to `balance` only — asset received from counterparty |

**Why deductLocked + credit instead of just unlock?**
`unlock` returns an asset back to the same user. But in a trade, the buyer's locked quote goes *to the seller*, and the seller's locked base goes *to the buyer*. So the flow is:
- `deductLocked` on giver (asset leaves their locked)
- `credit` on receiver (asset arrives in their balance)

---

### deposit

- Validates asset is in `ASSETS`
- Initializes `balance` map for user if not present
- Initializes `locked` map for user (must happen here so `lock` works later)
- Returns serialized balance via `getUserBalance`

---

### getUserBalance

- Returns `{}` if user has no balance map
- Converts `Map<string,number>` → plain object via `Object.fromEntries(m)` because Maps don't serialize to JSON correctly

---

### getDepth

- Validates market exists
- Aggregates bids and asks by price level: sums `quantity - filledQuantity` for all orders at the same price
- Uses `Map<number, number>` (price → total remaining qty) — Map preserves insertion order, so bids come out high→low (correct) and asks come out low→high (correct), matching the sort order of the underlying order book arrays
- Converts via `Array.from(map.entries())` — keys stay as `number`, no `Number(price)` cast needed unlike `Object.entries`
- Returns `{ bids: [{price, count}], asks: [{price, count}] }`
- Note: computed on every call — can be optimized by maintaining a pre-aggregated structure updated on each createOrder/cancelOrder

**Why not `Record<number, number>`?** Plain objects with numeric keys are always iterated in ascending order by V8, regardless of insertion order. So `Object.entries(bidLevels)` would return low→high — wrong for bids. `Map` avoids this entirely.

---

### getOrder

- Simple map lookup by orderId
- Throws if not found
- Returns the full Order object (including current status, fills, avgPrice)

---

### cancelOrder

Steps:
1. Look up order in `orders` map — throw if not found
2. Find it in the correct side of the order book (`buy` → `bids`, `sell` → `asks`) — throw if not found
3. Remove from order book via `splice`
4. Set status: `CANCELLED` if `filledQuantity === 0`, else `PARTIALLY_CANCELLED`
5. Refund remaining locked balance:
   - Buy order: `unlock(userId, quote, (quantity - filledQuantity) * price)` — remaining quote cost
   - Sell order: `unlock(userId, base, quantity - filledQuantity)` — remaining base quantity

**Why `* order.price` for buy refund?**
The per-fill over-lock delta is unlocked during matching (see createOrder). So after all fills, remaining locked = `price * remaining_quantity` exactly. This math holds.

---

### createOrder

The most complex method. Steps in order:

#### 1. Validate
`checksForCreateOrder` — market valid, side valid, orderType valid, quantity > 0, price > 0 for limit orders.

#### 2. Determine what to lock
- **Limit buy**: lock `price * quantity` in quote
- **Market buy**: lock entire available quote balance (worst-case reserve)
- **Limit sell / Market sell**: lock `quantity` in base (exact amount being sold)

#### 3. Build order object, lock balance, register in orders map

#### 4. Matching loop
```
while filledQuantity < quantity AND opposite side has orders:
  peek best opposite order (toIterate[0])
  
  for limit orders — price check:
    buy: break if best ask price > limit price (too expensive)
    sell: break if best bid price < limit price (too cheap)
  
  calculate fill:
    qtyToFill = min(bestOrder.remaining, incoming.remaining)
    fillPrice = bestOrder.price (maker sets the price)
  
  update both orders:
    filledQuantity += qtyToFill
    fills.push(fill)
    avgPrice = running weighted average
  
  settle balances:
    buy trade (incoming=taker/buyer, resting=maker/seller):
      deductLocked(buyer, quote, fillPrice * qty)   — buyer pays
      credit(buyer, base, qty)                       — buyer receives base
      deductLocked(seller, base, qty)                — seller delivers base
      credit(seller, quote, fillPrice * qty)         — seller receives quote
    
    sell trade (incoming=taker/seller, resting=maker/buyer):
      deductLocked(seller, base, qty)
      credit(seller, quote, fillPrice * qty)
      deductLocked(buyer, quote, fillPrice * qty)
      credit(buyer, base, qty)
  
  over-lock refund (limit buy only):
    buyer locked at limit price but filled at lower maker price
    delta = (limitPrice - fillPrice) * fillQty
    unlock(buyer, quote, delta)   — refund the difference
  
  if bestOrder fully filled: status=FILLED, remove from book (shift)
  if incoming fully filled: status=FILLED, return early
  else if partially filled: status=PARTIALLY_FILLED
```

#### 5. Post-loop handling

**Market order with remaining quantity:**
- Set status `CANCELLED` (0 fills) or `PARTIALLY_CANCELLED` (some fills)
- Refund remaining locked:
  - Buy: `unlock(userId, quote, amountToLock - sum(fill.price * fill.qty))`
  - Sell: `unlock(userId, base, quantity - filledQuantity)`
- Return immediately — market orders never rest in the book

**Limit order with remaining quantity:**
- Push to correct side of order book
- Sort to maintain price-time priority:
  - Bids: higher price first, earlier timestamp as tiebreaker
  - Asks: lower price first, earlier timestamp as tiebreaker

---

## Key Bugs Found and Fixed During Implementation

1. **`lock` was a no-op for new users** — `currentLocked?.set(...)` does nothing if map is undefined. Fixed by initializing `locked` in `deposit` and reassigning local variable in `lock` after creating the map.

2. **`remainingQtyBuyable` used wrong order's filledQuantity** — was using `order.filledQuantity` instead of `bestOrder.filledQuantity`.

3. **Maker balance settlement used `unlock` instead of `deductLocked + credit`** — `unlock` returns assets to the same user. In a trade, assets cross between users.

4. **Market order remaining locked never refunded (partial fill)** — after partial fill, the unused locked balance was stuck forever. Fixed by explicit unlock after the matching loop.

5. **Market buy fully filled leaked locked funds** — the excess unlock (`amountToLock - totalSpent`) was inside `if (filledQuantity < quantity)`. When a market buy fully fills, that block is skipped entirely and the excess quote stays permanently locked. Fixed by moving the market buy excess unlock **above** the `if (filledQuantity < quantity)` block so it runs unconditionally for all market buys regardless of fill status. The `if (excess > 0)` guard prevents calling `unlock(0)`.

6. **Market order with 0 fills got status `PARTIALLY_CANCELLED`** — should be `CANCELLED`. Fixed with `filledQuantity === 0` check.

7. **`cancelOrder` used `oppositeSide` instead of `inOrderBookSide`** — a buy order rests in `bids`, not `asks`.

8. **`ob` fallback in createOrder creates orphan object** — `orderBooks.get(market) || { bids:[], asks:[] }` creates an anonymous object that is never stored back. Safe only because market validation guarantees the key always exists.

9. **`credit` was a no-op when user had no balance map** — fixed by initializing the map if missing before setting.

---

## Known Remaining Issues (Not Fixed)

1. **`bestOpposite` and `bestOrder` are the same object** — both are `toIterate[0]`. One variable is redundant. Minor cleanup only.

---

## Bugs Found and Fixed (Second Round of Review)

1. **Market buy with 0 balance corrupts state mid-loop (Bug 1 & 4)** — `lock(userId, quote, 0)` passes the balance check (0 < 0 is false). The order is created and registered. The matching loop then updates `filledQuantity` and `fills` on both the incoming and maker orders. When `deductLocked(takerUserId, quote, cost)` is called, it throws because locked=0 < cost. No money moves, but both orders now have corrupted `filledQuantity` and `fills` permanently. The maker resting order is stuck with wrong state forever.

   Fix: After computing `amountToLock` for market buy, throw early if `amountToLock <= 0` — before the order is ever created. This matches the behavior of market sell (which throws at `lock` when `quantity > balance`).

   ```ts
   amountToLock = currentBalance;
   if (amountToLock <= 0) {
     throw new Error("insufficient quote balance for market buy");
   }
   ```

2. **Maker order status never set to PARTIALLY_FILLED (Bug 2)** — After the matching loop processes a fill, the maker (resting) order's status is only updated when it is fully filled (`bestOrder.status = "FILLED"`). When the maker is only partially consumed, the `else` branch was missing — status stayed `"OPEN"` even with fills recorded. A `getOrder` call on it would return `status: "OPEN"` despite `filledQuantity > 0`.

   Fix: Add the missing `else` branch:

   ```ts
   if (bestOrder.filledQuantity === bestOrder.quantity) {
     bestOrder.status = "FILLED";
     toIterate.shift();
   } else {
     bestOrder.status = "PARTIALLY_FILLED";
   }
   ```

---

## Issues Found and Fixed Post-Implementation

1. **`cancelOrder` used passed `market` param instead of `order.market`** — fixed by using `this.orderBooks.get(order.market)` directly from the stored order. The `market` parameter is now named `_market` to suppress the unused-variable TypeScript hint.

2. **`getDepth` returned bids in ascending price order** — `Record<number,number>` + `Object.entries` always iterates numeric keys ascending regardless of insertion order. Fixed by switching to `Map<number,number>` + `Array.from(map.entries())` which preserves insertion order (matching the already-sorted order book arrays).

3. **`cancelOrder` gave misleading error for non-resting orders** — cancelling a FILLED, CANCELLED, or PARTIALLY_CANCELLED order would find the order in `this.orders`, then fail at `findIndex` in the book (order already removed) and throw `"order not found in order book"`. The real reason is the order's terminal status. Fixed by checking `order.status` immediately after the lookup and throwing `"order cannot be cancelled (status: <status>)"` before ever touching the order book.

---

## End-to-End Flow

```
HTTP POST /order
  → order-controller (Zod validate)
  → sendToEngine("create_order", data)
  → Redis LPUSH incoming-queue
  → engine/src/index.ts (brpop loop)
  → handleEngineRequest(request)
  → exchangeStore.createOrder(data)
  → result pushed back to Redis response queue
  → broker.ts resolves the pending Promise
  → res.json(result) back to client
```

Test order:
1. `POST /deposit` — fund the account
2. `POST /order` — place a limit order
3. `GET /depth/:symbol` — see it in the book
4. `POST /order` — place crossing order to trigger a fill
5. `GET /order/:id` — verify fill status and avgPrice
