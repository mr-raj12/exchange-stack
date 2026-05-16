# Trading Concepts — a from-first-principles reference for implementing the engine

This is your working companion while you implement the five methods in
`engine/src/store/exchange-store.ts`:

- `createOrder` — the hard one (matching, fills, balances)
- `cancelOrder`
- `getOrder`
- `getDepth`
- `getUserBalance`

Every term you'll need is defined here, in the order it becomes relevant,
with worked numeric examples. Read sections 1–6 once before you write any
code. Keep section 11 (cheat sheet) open while you code.

---

## Table of contents

1. [Markets, assets, price, quantity](#1-markets-assets-price-quantity)
2. [Buy vs sell, bid vs ask](#2-buy-vs-sell-bid-vs-ask)
3. [The order book](#3-the-order-book)
4. [Limit orders — the part everyone gets backwards](#4-limit-orders--the-part-everyone-gets-backwards)
5. [Market orders & slippage](#5-market-orders--slippage)
6. [Matching: price-time priority, maker/taker, execution price](#6-matching-price-time-priority-makertaker-execution-price)
7. [Fills, partial fills, order status](#7-fills-partial-fills-order-status)
8. [Balances: available vs locked, settlement, refunds](#8-balances-available-vs-locked-settlement-refunds)
9. [Worked examples (numbers, step by step)](#9-worked-examples)
10. [Edge cases, invariants, decisions you must make](#10-edge-cases-invariants-decisions-you-must-make)
11. [Cheat sheet — per function](#11-cheat-sheet--per-function)
12. [Glossary (A–Z quick lookup)](#12-glossary-az-quick-lookup)
13. [Bootstrapping: seed data to actually test](#13-bootstrapping-seed-data-to-actually-test)

---

## 1. Markets, assets, price, quantity

**Market / trading pair** — a pair of assets you can trade against each
other, written `BASE_QUOTE`, e.g. `BTC_USDT`.

- **Base asset** = the thing being bought/sold. In `BTC_USDT`, base = `BTC`.
- **Quote asset** = the thing it's priced *in*. In `BTC_USDT`, quote = `USDT`.

**Price** — how many units of *quote* per **1 unit of base**.
`price = 42000` in `BTC_USDT` means 1 BTC costs 42,000 USDT.

**Quantity** — always measured in **base** units. `quantity = 0.5` means
0.5 BTC.

**Notional / value of an order** = `price × quantity`, measured in quote.
A buy of 0.5 BTC @ 42,000 has a notional of `0.5 × 42000 = 21,000 USDT` —
that's how much quote the order is worth.

> Keep this straight or every balance calculation will be wrong:
> **price is in quote, quantity is in base, notional = price × quantity is in quote.**

---

## 2. Buy vs sell, bid vs ask

- **Buy** = give up *quote*, receive *base*. (Spend USDT, get BTC.)
- **Sell** = give up *base*, receive *quote*. (Give BTC, get USDT.)

When an order is **resting in the book** (waiting, not yet matched) it has a
name based on its side:

- A resting **buy** order is a **bid**.
- A resting **sell** order is an **ask** (also called an **offer**).

So "bids" = all open buy orders; "asks" = all open sell orders. Same thing
as buy/sell, just the book-side vocabulary.

---

## 3. The order book

The **order book** for a market is two sorted lists:

- **Bids** — all open buy orders, sorted by price **high → low**.
 The first one is the **best bid**: the highest price any buyer is
 currently willing to pay.
- **Asks** — all open sell orders, sorted by price **low → high**.
 The first one is the **best ask**: the lowest price any seller is
 currently willing to accept.

```
 ASKS (sells) sorted low → high, best = top
 43,100 x 2.0
 43,000 x 1.5
 42,600 x 0.8 ← best ask (lowest seller)
 ───────────── spread = 42,600 − 42,500 = 100 ─────────────
 42,500 x 1.0 ← best bid (highest buyer)
 42,300 x 3.0
 42,000 x 0.5
 BIDS (buys) sorted high → low, best = top
```

Derived quantities you may need:

- **Spread** = best ask − best bid. (Above: `42,600 − 42,500 = 100`.)
- **Mid price** = (best bid + best ask) / 2.
- A book is **crossed** if best bid ≥ best ask. A correct engine should
 *never* leave a crossed book — if a new order would cross, it must match
 instead of resting (see §6).

`getDepth` returns this structure, usually **aggregated by price level**
(sum the quantities of all orders sharing a price): e.g.
`bids: [[42500, 1.0], [42300, 3.0], ...]`, `asks: [[42600, 0.8], ...]`.

---

## 4. Limit orders — the part everyone gets backwards

A **limit order** carries a **price limit**: the *worst* price you'll accept.
This is the single most-misunderstood concept, so read slowly.

### Limit BUY @ P

> "Buy, but pay **no more than P**."

- It will execute at any price **≤ P**. A lower price is *better* for the
 buyer and always welcome.
- It matches against **asks** whose price **≤ P**.
- ⚠️ Common mistake: thinking a limit buy means "buy when price goes
 *above* P." **No.** A buyer wants to pay *less*, so a limit buy triggers
 on asks at P **or below**.
- If no ask is at ≤ P when it arrives, the order **rests** in the book as a
 bid at price P and waits.

### Limit SELL @ P

> "Sell, but accept **no less than P**."

- It will execute at any price **≥ P**. A higher price is *better* for the
 seller.
- It matches against **bids** whose price **≥ P**.
- If no bid is at ≥ P when it arrives, the order **rests** as an ask at
 price P.

### The mental rule

| Order | Limit means | Matches against | Wants price to be |
|---|---|---|---|
| **Limit BUY @ P** | pay at most P | asks priced ≤ P | as **low** as possible |
| **Limit SELL @ P** | get at least P | bids priced ≥ P | as **high** as possible |

A limit order that *can* match immediately on arrival (its price crosses the
spread) is called a **marketable limit order** — it behaves like a market
order up to its limit, then rests with whatever quantity is left.

---

## 5. Market orders & slippage

A **market order** has **no price limit**. "Fill me right now at whatever
prices are available, best first, until I'm done."

- A market **buy** eats asks starting from the best (lowest) ask, walking
 *up* the book until the quantity is filled.
- A market **sell** eats bids starting from the best (highest) bid, walking
 *down* the book.

**Slippage** = the difference between the price you hoped for (e.g. best
ask) and the average price you actually got, because a large market order
"walks the book" through worse and worse levels.

**A market order never rests in the book.** If the book runs out of
liquidity before it's fully filled, the unfilled remainder is **cancelled**
(this is the default "immediate-or-cancel" behavior of market orders). It
never becomes a resting order, because it has no price to rest at.

---

## 6. Matching: price-time priority, maker/taker, execution price

### Price-time priority (a.k.a. FIFO matching)

When an incoming order matches the book, the engine picks counterparties in
this order:

1. **Best price first.** For an incoming buy, match the **lowest** ask
 first. For an incoming sell, match the **highest** bid first.
2. **Then earliest time.** Among multiple resting orders at the *same*
 price, the one that arrived **first** matches first (first-in-first-out
 at each price level).

This is why the book is sorted by price, and why within a price level you
must preserve insertion order (a queue). Get this wrong and matching is
unfair / non-deterministic.

### Maker vs taker

- **Maker** — an order that *rests* in the book and provides liquidity.
 When someone later trades against it, the resting order is the "maker."
- **Taker** — an order that *removes* liquidity by matching immediately
 against resting orders on arrival.

A limit order is a **taker** for whatever portion fills on arrival, and a
**maker** for whatever portion is left to rest. A market order is always a
pure taker.

### Execution price — the rule people miss

When a taker matches a maker, **the trade executes at the *maker's*
(resting) price**, not the taker's price.

Example: best ask is a resting sell @ 42,600. A limit buy @ 43,000 arrives.
They match — but the trade price is **42,600** (the maker's price), not
43,000. The buyer said "I'll pay up to 43,000" and got a better deal. That
gap is **price improvement** for the taker. You must charge/settle at the
maker price and refund the difference (see §8).

---

## 7. Fills, partial fills, order status

**Fill (a.k.a. trade / execution)** — a single match between two orders for
some quantity at some price. One incoming order can generate *many* fills
(it ate several resting orders at different levels).

**Quantities to track per order:**

- `quantity` — original requested amount (base units), never changes.
- `filledQuantity` — how much has matched so far. Starts 0, only increases.
- `remaining` = `quantity − filledQuantity` (derive it; don't store a third
 field that can drift out of sync).

**Full fill** — `filledQuantity == quantity`, `remaining == 0`.
**Partial fill** — `0 < filledQuantity < quantity`; some matched, the rest
either rests (limit) or is cancelled (market).

**Order status lifecycle** (decide your exact strings, but the states are):

```
 ┌──────────────► REJECTED (failed validation / insufficient balance,
 │ never entered the book)
 (new order)
 │
 ▼
 OPEN ──────► PARTIALLY_FILLED ──────► FILLED (remaining hit 0)
 │ │
 └──────────────────┴────────────► CANCELLED (user cancelled, or
 market order leftover)
```

- **OPEN / NEW** — accepted, resting, nothing matched yet.
- **PARTIALLY_FILLED** — some quantity matched, still resting for the rest.
- **FILLED** — fully matched. Terminal state.
- **CANCELLED** — removed before fully filling. Terminal state.
- **REJECTED** — never accepted (bad input, no balance). Terminal state.

`getOrder` returns a snapshot of one order: its status, `filledQuantity`,
`remaining`, and usually the **average fill price**
(`sum(fillQty × fillPrice) / filledQuantity`) since different fills can
happen at different prices.

---

## 8. Balances: available vs locked, settlement, refunds

Every user has, **per asset**, two numbers:

- **available** — free to spend / place new orders with.
- **locked** (a.k.a. reserved / on-hold) — set aside to back open orders so
 they can't double-spend.

`total = available + locked`. `getUserBalance` returns both per asset.

### Locking when an order is placed

You must lock funds **before** an order enters the book, or a user could
place infinite orders with money they don't have.

- **Limit BUY**, qty `Q` @ price `P`: lock `Q × P` of **quote** (you might
 spend up to that much).
- **Limit SELL**, qty `Q`: lock `Q` of **base** (you're committing to
 deliver that base).
- **Market BUY**: trickier — there's no limit price. Common approaches:
 require the user to specify a max spend, or lock against `available`
 quote and stop when it's exhausted. Pick a policy and document it.
- **Market SELL**, qty `Q`: lock `Q` of base, same as limit sell.

If the user lacks the funds to lock → **reject** the order (status
REJECTED), don't enter it in the book.

### Settlement when a fill happens

For each fill of `q` base units at execution price `x`:

- **Buyer**: `locked quote -= q × x`; `available base += q`.
- **Seller**: `locked base -= q`; `available quote += q × x`.

(The base/quote each side *receives* goes to `available`, immediately
spendable.)

### The price-improvement refund (don't forget this)

A limit buy @ `P` that fills against a cheaper ask @ `x < P` locked `q × P`
but only spent `q × x`. The difference `q × (P − x)` is **over-locked** and
must be **released back to available quote**. Symmetrically, a limit sell
that fills at a *better* (higher) price than its limit has no over-lock
issue (it locked base, not quote), but mind your accounting.

### Releasing on cancel

When `cancelOrder` removes a resting order with `remaining > 0`, release the
**still-locked** funds for the unfilled remainder back to `available`:

- cancelled buy: release `remaining × P` quote.
- cancelled sell: release `remaining` base.

### Conservation invariant (use this to test yourself)

For any single trade, total assets in the system are unchanged — value just
moves between the two users. After every operation:
`sum over all users of (available + locked)` for each asset is constant
(no money created or destroyed). If a test breaks this, your settlement math
is wrong.

---

## 9. Worked examples

### Example A — limit buy that rests (no match)

Book is empty. Alice places **limit BUY 1.0 BTC @ 42,000**.

1. No asks exist → nothing to match.
2. Lock `1.0 × 42,000 = 42,000 USDT` from Alice's available → locked.
3. Order rests as a **bid** @ 42,000. Status `OPEN`, `filledQuantity = 0`.

Depth now: `bids: [[42000, 1.0]]`, `asks: []`.

### Example B — marketable limit buy with price improvement & partial fill

Book:

```
ASKS: 42,600 x 0.3 (Bob, resting, t=1)
 42,800 x 0.5 (Carol, resting, t=2)
BIDS: (none)
```

Dave places **limit BUY 0.6 BTC @ 42,900**.

Dave's limit (42,900) ≥ best ask (42,600) → marketable, he's the taker.

1. **Match against Bob @ 42,600** (best price, earliest). Fill `0.3` BTC at
 the **maker price 42,600**.
 - Dave: locked quote `−0.3×42,600 = −12,780`; base `+0.3`.
 - Bob: locked base `−0.3`; available quote `+12,780`.
 - Bob's order now `FILLED`. Dave `filledQuantity = 0.3`, `remaining 0.3`.
2. **Match against Carol @ 42,800** (next best). Carol's price 42,800 ≤
 Dave's limit 42,900 → still matches. Fill `0.3` BTC at maker price
 **42,800**.
 - Dave: quote `−0.3×42,800 = −12,840`; base `+0.3`.
 - Carol: base `−0.3`; quote `+12,840`. Carol now `PARTIALLY_FILLED`
 (she had 0.5, 0.3 filled, 0.2 still resting @ 42,800).
 - Dave `filledQuantity = 0.6`, `remaining 0` → **FILLED**.
3. **Refund Dave's over-lock.** Dave locked `0.6 × 42,900 = 25,740`. He
 actually spent `12,780 + 12,840 = 25,620`. Release
 `25,740 − 25,620 = 120` USDT back to Dave's available.

Dave never rests — he fully filled as a taker. Average fill price =
`25,620 / 0.6 = 42,700`.

### Example C — market sell walking the book

Book:

```
BIDS: 42,500 x 0.4 (best)
 42,300 x 1.0
ASKS: ...
```

Eve places **market SELL 0.7 BTC**.

1. Match best bid 42,500 x 0.4 → fill 0.4 @ 42,500. `remaining 0.3`.
2. Match next bid 42,300 x 1.0 → fill 0.3 @ 42,300. `remaining 0`.
 (That bid has 0.7 left, stays resting.)
3. Eve fully filled across two prices. Avg price
 `= (0.4×42,500 + 0.3×42,300) / 0.7 ≈ 42,414.29`. Slippage vs the 42,500
 top-of-book = ~85.71 quote/BTC.

If Eve had sold 2.0 BTC, the book (1.4 total) would exhaust; she'd fill 1.4
and the remaining 0.6 would be **cancelled** (market orders don't rest).

### Example D — cancel releases locked funds

From Example A, Alice cancels her resting **BUY 1.0 @ 42,000** (nothing
filled). Release `1.0 × 42,000 = 42,000` USDT locked → available. Order
status → `CANCELLED`. Remove it from the bids list.

---

## 10. Edge cases, invariants, decisions you must make

These aren't all "right answers" — they're decisions. Pick one, be
consistent, and a reviewer will respect it:

- **Self-trade**: should a user's incoming buy match their own resting
 sell? Real exchanges prevent this ("self-trade prevention"). Simplest
 boilerplate choice: allow it (it's just a no-op transfer to yourself) or
 skip the user's own orders while matching. Document your choice.
- **Zero / negative price or quantity**: reject before anything else.
- **Unknown market**: reject (or lazily create an empty book — decide).
- **Insufficient balance to lock**: reject with a clear status, never enter
 the book.
- **Time-in-force** (advanced; the boilerplate likely only needs two):
 - **GTC** (Good-Til-Cancelled) — the default for limit orders: rest
 until filled or cancelled.
 - **IOC** (Immediate-Or-Cancel) — fill what you can now, cancel the
 rest. (Market orders are effectively IOC.)
 - **FOK** (Fill-Or-Kill) — fill the *entire* quantity immediately or
 cancel the whole thing. Only implement if asked.
- **Floating-point money**: `0.1 + 0.2 !== 0.3` in JS. For a learning
 project, floats are usually accepted; just know that production engines
 use integers (smallest unit, e.g. satoshis) or decimal libraries. Be
 consistent and round defensively if you compare amounts.
- **Determinism**: given the same sequence of orders, the book must always
 end in the same state. Price-time priority + single-threaded processing
 (the engine consumes the queue one message at a time) gives you this for
 free — don't introduce randomness or parallelism.
- **Cancelling a filled/cancelled order**: must be a safe no-op or a clear
 error, never a double-refund.

---

## 11. Cheat sheet — per function

### `createOrder(input)`

1. Validate: market exists, `price > 0` (limit), `quantity > 0`, side ∈
 {buy, sell}, type ∈ {limit, market}.
2. Compute funds to lock; if `available` < needed → return REJECTED.
3. Move funds `available → locked`.
4. Assign `orderId`, `filledQuantity = 0`, status OPEN.
5. **Match loop** (taker side): while `remaining > 0` and there's an
 eligible opposite order (best price; for limit, price within your
 limit):
 - fill `min(remaining, makerRemaining)` at the **maker's price**;
 - update both orders' `filledQuantity`;
 - settle balances for both (see §8);
 - if maker fully filled, remove it from the book; else update it;
 - record the fill.
6. After the loop:
 - **limit** with `remaining > 0` → rest it in the book at its price,
 status OPEN/PARTIALLY_FILLED; keep its remaining lock.
 - **market** with `remaining > 0` → cancel the remainder, release the
 unused lock.
 - if you over-locked (limit buy filled cheaper) → refund the difference.
7. Return order summary (id, status, filledQuantity, fills, avg price).

### `cancelOrder(market, orderId)`

1. Find the order; if missing or already terminal → safe no-op / error.
2. If resting with `remaining > 0`: remove from book, release the locked
 funds for the **unfilled remainder** (§8).
3. Set status CANCELLED. Return confirmation.

### `getOrder(orderId)`

Return a snapshot: status, `quantity`, `filledQuantity`,
`remaining = quantity − filledQuantity`, average fill price, side, price,
market. No state change.

### `getDepth(market)`

Aggregate the book by price level:
`bids` sorted **high → low**, `asks` sorted **low → high**, each level
`[price, totalRemainingQtyAtThatPrice]`. No state change.

### `getUserBalance(userId)`

Return, per asset, `{ available, locked }` (and optionally `total`). No
state change.

---

## 12. Glossary (A–Z quick lookup)

- **Ask / Offer** — a resting sell order; its price is what a seller wants.
- **Available balance** — funds free to use for new orders.
- **Base asset** — the asset being traded (BTC in BTC_USDT).
- **Best ask** — lowest ask price (top of the ask side).
- **Best bid** — highest bid price (top of the bid side).
- **Bid** — a resting buy order.
- **Crossed book** — best bid ≥ best ask; an invalid state a correct engine
 prevents by matching instead of resting.
- **Depth** — aggregated quantity available at each price level.
- **Execution price** — the price a fill happens at = the **maker's** price.
- **Fill / Trade / Execution** — one match between two orders.
- **FOK (Fill-Or-Kill)** — fill entirely now or cancel entirely.
- **GTC (Good-Til-Cancelled)** — rest until filled or cancelled (limit
 default).
- **IOC (Immediate-Or-Cancel)** — fill now, cancel the rest.
- **Limit order** — has a worst-acceptable price; rests if not immediately
 matchable.
- **Locked / Reserved balance** — funds set aside to back open orders.
- **Maker** — a resting order that provides liquidity.
- **Marketable limit order** — a limit order that crosses the spread and
 executes immediately on arrival.
- **Market order** — no price limit; fills immediately against best
 available; never rests.
- **Mid price** — (best bid + best ask) / 2.
- **Notional** — order value in quote = price × quantity.
- **Partial fill** — only part of an order's quantity matched.
- **Price improvement** — taker getting a better price than its limit
 because it filled at the maker's better price.
- **Price-time priority** — match best price first, then earliest order at
 that price (FIFO per level).
- **Quote asset** — the pricing asset (USDT in BTC_USDT).
- **Settlement** — moving assets between the two users when a fill occurs.
- **Side** — buy or sell.
- **Slippage** — gap between expected price and realized average price when
 a market order walks the book.
- **Spread** — best ask − best bid.
- **Taker** — an order that removes liquidity by matching immediately.
- **Time-in-force** — how long an order stays active (GTC / IOC / FOK).

---

## 13. Bootstrapping: seed data to actually test

**Read this before you try to place your first order**, or every
`createOrder` will be REJECTED for insufficient balance and you'll think
your code is broken when it isn't.

### Why this is needed

The boilerplate has **no deposit / mint endpoint**. The message contract
(`EngineRequestType`) is only:

```
create_order | cancel_order | get_order | get_depth | get_user_balance
```

There is no `deposit`. So a freshly signed-up user has an **empty balance
map**. `createOrder` tries to lock funds → finds nothing → must reject.
Until a user has funds, no matching can be tested. You must give users
starting money somehow. This is a deliberate gap in the boilerplate — how
you fill it is your call.

### Markets do NOT need seeding

You never "create" a market. Lazily create an empty book the first time any
order references a market string:

```ts
private getBook(market: string): OrderBook {
 let book = this.orderBooks.get(market);
 if (!book) {
 book = { bids: [], asks: [] };
 this.orderBooks.set(market, book);
 }
 return book;
}
```

Optionally restrict to an allowlist and reject unknown markets:

```ts
private static MARKETS = new Set(["BTC_USDT", "ETH_USDT"]);
// in createOrder: if (!ExchangeStore.MARKETS.has(market)) reject(...)
```

Either way: **no market seed data required.**

### Balances — the real bootstrapping problem

A user needs **quote** (USDT) to test a buy and **base** (BTC) to test a
sell. Pick one of these:

#### Option B (recommended for learning): faucet-on-first-sight

The first time the engine sees a `userId`, auto-grant generous balances.
Zero friction, works with the random UUIDs that signup produces.

```ts
private static SEED: Record<string, number> = {
 USDT: 1_000_000,
 BTC: 100,
 ETH: 1_000,
};

private ensureUser(userId: string): Map<string, number> {
 let bal = this.balances.get(userId);
 if (!bal) {
 bal = new Map(Object.entries(ExchangeStore.SEED));
 this.balances.set(userId, bal);
 }
 return bal;
}
```

Call `this.ensureUser(userId)` at the **top of `createOrder` and
`getUserBalance`** (and anywhere else you read a user's balance). Now every
real signed-up user starts with money the moment they act. (Track
`available` and `locked` per asset — the snippet shows one number per asset
for brevity; expand to `{ available, locked }` per §8.)

#### Option C (do-it-properly upgrade): a `deposit` message type

More realistic — mirrors how real users get funds. Costs more wiring:

1. Add `"deposit"` to `EngineRequestType` in **both**
 `backend/src/types/engine-messages.ts` **and**
 `engine/src/types/messages.ts` (keep the two copies in lockstep).
2. Add a `deposit` case in `engine/src/handler.ts` →
 `exchangeStore.deposit(userId, asset, amount)`.
3. Add a backend route + controller (e.g. `POST /api/v1/user/deposit`,
 behind `authMiddleware`) that calls
 `sendToEngine("deposit", { userId, asset, amount })`.
4. `deposit` in the store just credits `available`.

Use this if you want the project to feel like a real exchange. Otherwise
Option B gets you testing matching in five minutes.

### End-to-end test recipe (once balances exist)

Matching needs **two users on opposite sides**:

1. Sign up **user A** and **user B** (both auto-funded via Option B).
2. As A: `POST /order/create` — limit **SELL** 1.0 BTC @ 42,000.
 → rests as an ask (no bids yet). Check `getDepth` shows it.
3. As B: `POST /order/create` — limit **BUY** 1.0 BTC @ 42,000 (or higher).
 → crosses, matches A's ask, fills at 42,000.
4. `getOrder` on both → FILLED.
5. `getUserBalance` on both → A: −1 BTC, +42,000 USDT; B: +1 BTC,
 −42,000 USDT. Confirm the conservation invariant (§8).
6. `getDepth` → book empty again.

If steps 5–6 balance out, your matching + settlement is correct.

### Reminder: in-memory state resets on restart

All balances/orders live in engine RAM. Restarting the engine wipes
everything (including faucet grants — they're re-granted on next sight with
Option B, which is fine). Don't expect persistence; that's not in scope for
the boilerplate.
