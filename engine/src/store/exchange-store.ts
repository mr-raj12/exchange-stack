export type Side = "buy" | "sell";
export type OrderType = "limit" | "market";

export interface Order {
  orderId: string;
  userId: string;
  market: string;
  side: Side;
  price: number;
  filledQuantity: number;
  orderType: OrderType;
  quantity: number;
  status: "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED";
}

export interface OrderBook {
  // bids sorted by price high -> low (best buyer first)
  bids: Order[];
  // asks sorted by price low -> high (best seller first)
  asks: Order[];
}

export interface Fill {
  makerOrderId: string;
  takerOrderId: string;
  price: number;
  quantity: number;
}

export interface OrderSummary {
  orderId: string;
  status: string;
  filledQuantity: number;
  fills: Fill[];
  avgPrice: number;
}

class ExchangeStore {
  private static MARKETS = new Set([
    // any base vs USD
    "BTC_USD", "ETH_USD", "SOL_USD",
    // USDT quote
    "BTC_USDT",
    // SOL quote
    "ETH_SOL",
  ]);
  private static ASSETS = new Set(
    [...ExchangeStore.MARKETS].flatMap(m => m.split("_") as [string, string])
  );
  private orderBooks = new Map<string, OrderBook>();
  private orders = new Map<string, Order>();
  // orderId -> fills that involved this order (both as taker and maker)
  private orderFillsMap = new Map<string, Fill[]>();
  // userId -> asset -> available amount
  private balance = new Map<string, Map<string, number>>();
  // userId -> asset -> locked amount (funds reserved for open orders)
  private locked = new Map<string, Map<string, number>>();

  // ── balance helpers ──────────────────────────────────────────────────────

  private availableBalance(userId: string): Map<string, number> {
    let m = this.balance.get(userId);
    if (!m) { m = new Map(); this.balance.set(userId, m); }
    return m;
  }

  private lockedBalance(userId: string): Map<string, number> {
    let m = this.locked.get(userId);
    if (!m) { m = new Map(); this.locked.set(userId, m); }
    return m;
  }

  // Move `amount` of `asset` from available → locked.
  private lock(userId: string, asset: string, amount: number): void {
    const bal = this.availableBalance(userId);
    bal.set(asset, (bal.get(asset) ?? 0) - amount);
    const lk = this.lockedBalance(userId);
    lk.set(asset, (lk.get(asset) ?? 0) + amount);
  }

  // Move `amount` of `asset` from locked → available (refund).
  private unlock(userId: string, asset: string, amount: number): void {
    if (amount <= 0) return;
    const lk = this.lockedBalance(userId);
    lk.set(asset, (lk.get(asset) ?? 0) - amount);
    const bal = this.availableBalance(userId);
    bal.set(asset, (bal.get(asset) ?? 0) + amount);
  }

  // Consume `amount` from locked (the asset has been transferred to the counterparty).
  private deductLocked(userId: string, asset: string, amount: number): void {
    const lk = this.lockedBalance(userId);
    lk.set(asset, (lk.get(asset) ?? 0) - amount);
  }

  // Add `amount` to available (asset received from a fill).
  private credit(userId: string, asset: string, amount: number): void {
    const bal = this.availableBalance(userId);
    bal.set(asset, (bal.get(asset) ?? 0) + amount);
  }

  // ── order-book helpers ───────────────────────────────────────────────────

  private insertBid(bids: Order[], order: Order): void {
    // bids: high → low
    let i = 0;
    while (i < bids.length && bids[i]!.price >= order.price) i++;
    bids.splice(i, 0, order);
  }

  private insertAsk(asks: Order[], order: Order): void {
    // asks: low → high
    let i = 0;
    while (i < asks.length && asks[i]!.price <= order.price) i++;
    asks.splice(i, 0, order);
  }

  // ── public methods ───────────────────────────────────────────────────────

  checkForCreateOrder(input: Omit<Order, "orderId" | "filledQuantity" | "status">): void {
    if (!ExchangeStore.MARKETS.has(input.market))
      throw new Error(`unsupported market ${input.market}`);
    if (input.side !== "sell" && input.side !== "buy")
      throw new Error(`unsupported side ${input.side}`);
    if (input.orderType !== "limit" && input.orderType !== "market")
      throw new Error(`unsupported order type ${input.orderType}`);
    if (input.orderType === "limit" && input.price <= 0)
      throw new Error(`price must be positive for limit orders`);
    if (input.quantity <= 0)
      throw new Error(`quantity must be positive`);
  }

  createOrder(input: Omit<Order, "orderId" | "filledQuantity" | "status">): OrderSummary {
    this.checkForCreateOrder(input);
    const { userId, market, side, price, quantity, orderType } = input;

    const [base, quote] = market.split("_") as [string, string];

    // ── 1. Compute funds to lock ──────────────────────────────────────────
    let lockAsset: string;
    let lockAmount: number;

    if (side === "buy") {
      lockAsset = quote;
      if (orderType === "market") {
        // lock all available USD; unused portion refunded after matching
        lockAmount = this.availableBalance(userId).get(quote) ?? 0;
      } else {
        // limit buy: lock exactly price * quantity USD
        lockAmount = price * quantity;
      }
    } else {
      // sell (limit or market): lock the base asset being sold
      lockAsset = base;
      lockAmount = quantity;
    }

    const avail = this.availableBalance(userId).get(lockAsset) ?? 0;
    if (avail < lockAmount || lockAmount <= 0) {
      return { orderId: "", status: "REJECTED", filledQuantity: 0, fills: [], avgPrice: 0 };
    }

    this.lock(userId, lockAsset, lockAmount);

    // ── 2. Create order object ────────────────────────────────────────────
    const orderId = crypto.randomUUID();
    const order: Order = {
      orderId, userId, market, side, price, quantity,
      filledQuantity: 0, orderType, status: "OPEN",
    };
    this.orders.set(orderId, order);

    if (!this.orderBooks.has(market)) {
      this.orderBooks.set(market, { bids: [], asks: [] });
    }
    const book = this.orderBooks.get(market)!;

    // ── 3. Match loop ─────────────────────────────────────────────────────
    const opposites = side === "buy" ? book.asks : book.bids;
    const fills: Fill[] = [];
    let totalCost = 0; // total quote exchanged across all fills

    while (order.filledQuantity < quantity && opposites.length > 0) {
      const best = opposites[0]!;

      // Price eligibility for limit orders
      if (orderType === "limit") {
        if (side === "buy" && best.price > price) break;
        if (side === "sell" && best.price < price) break;
      }

      const remaining = quantity - order.filledQuantity;
      const makerRemaining = best.quantity - best.filledQuantity;
      const fillQty = Math.min(remaining, makerRemaining);
      const fillPrice = best.price; // always fill at maker's resting price
      const cost = fillQty * fillPrice;

      // Update fill quantities
      order.filledQuantity += fillQty;
      best.filledQuantity += fillQty;
      totalCost += cost;

      // Settle balances
      if (side === "buy") {
        this.deductLocked(userId, quote, cost);
        this.credit(userId, base, fillQty);
        this.deductLocked(best.userId, base, fillQty);
        this.credit(best.userId, quote, cost);
      } else {
        this.deductLocked(userId, base, fillQty);
        this.credit(userId, quote, cost);
        this.deductLocked(best.userId, quote, cost);
        this.credit(best.userId, base, fillQty);
      }

      const fill: Fill = { makerOrderId: best.orderId, takerOrderId: orderId, price: fillPrice, quantity: fillQty };
      fills.push(fill);

      // track fills per order so getOrder can compute avgPrice
      const takerList = this.orderFillsMap.get(orderId) ?? [];
      takerList.push(fill);
      this.orderFillsMap.set(orderId, takerList);
      const makerList = this.orderFillsMap.get(best.orderId) ?? [];
      makerList.push(fill);
      this.orderFillsMap.set(best.orderId, makerList);

      // yha >= neeche m defensive coding h, === will work as upar min() used h  
      if (best.filledQuantity >= best.quantity) {
        best.status = "FILLED";
        opposites.shift(); // fully filled → remove from book
      } else {
        best.status = "PARTIALLY_FILLED"; // maker partially filled, taker must be done
      }
    }

    // ── 4. Post-match: rest or cancel remainder, refund over-lock ─────────
    const filledQty = order.filledQuantity;
    const remaining = quantity - filledQty;

    if (remaining > 0) {
      if (orderType === "limit") {
        // Rest unfilled portion in the book
        order.status = filledQty > 0 ? "PARTIALLY_FILLED" : "OPEN";
        if (side === "buy") {
          this.insertBid(book.bids, order);
          // Refund any over-lock: we locked price*qty, used totalCost for fills,
          // and still need price*remaining locked for the resting order.
          // over-lock = price*filledQty - totalCost  (≥0 because fills happen at ≤ limit price)
          this.unlock(userId, quote, price * filledQty - totalCost);
        } else {
          this.insertAsk(book.asks, order);
          // Sell: locked exactly `quantity` base, deducted `filledQty` — remainder stays locked. No refund needed.
        }
      } else {
        // Market order: cancel remainder, release unused lock
        order.status = filledQty > 0 ? "PARTIALLY_FILLED" : "CANCELLED";
        if (side === "buy") {
          this.unlock(userId, quote, lockAmount - totalCost);
        } else {
          this.unlock(userId, base, remaining);
        }
      }
    } else {
      order.status = "FILLED";
      if (side === "buy") {
        // Limit buy filled entirely — refund over-lock if filled cheaper than limit price
        this.unlock(userId, quote, price * quantity - totalCost);
      }
    }

    return {
      orderId,
      status: order.status,
      filledQuantity: filledQty,
      fills,
      avgPrice: filledQty > 0 ? totalCost / filledQty : 0,
    };
  }

  cancelOrder(market: string, orderId: string): unknown {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`order ${orderId} not found`);
    if (order.market !== market) throw new Error(`order ${orderId} does not belong to market ${market}`);

    if (order.status === "FILLED" || order.status === "CANCELLED") {
      return { orderId, status: order.status, message: "order already in terminal state" };
    }

    // Remove from order book
    const book = this.orderBooks.get(market);
    if (book) {
      if (order.side === "buy") {
        const idx = book.bids.findIndex(o => o.orderId === orderId);
        if (idx !== -1) book.bids.splice(idx, 1);
      } else {
        const idx = book.asks.findIndex(o => o.orderId === orderId);
        if (idx !== -1) book.asks.splice(idx, 1);
      }
    }

    // Release locked funds for the unfilled remainder.
    // After createOrder's post-match step, a resting buy has exactly price*remaining locked,
    // and a resting sell has exactly remaining base locked.
    const [base, quote] = market.split("_") as [string, string];
    const remaining = order.quantity - order.filledQuantity;

    if (order.side === "buy") {
      this.unlock(order.userId, quote, order.price * remaining);
    } else {
      this.unlock(order.userId, base, remaining);
    }

    order.status = "CANCELLED";
    return { orderId, status: "CANCELLED" };
  }

  getOrder(orderId: string): unknown {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`order ${orderId} not found`);

    const remaining = order.quantity - order.filledQuantity;
    const fills = this.orderFillsMap.get(orderId) ?? [];
    const totalFillCost = fills.reduce((sum, f) => sum + f.price * f.quantity, 0);
    const avgPrice = order.filledQuantity > 0 ? totalFillCost / order.filledQuantity : 0;

    return {
      orderId: order.orderId,
      userId: order.userId,
      market: order.market,
      side: order.side,
      price: order.price,
      orderType: order.orderType,
      quantity: order.quantity,
      filledQuantity: order.filledQuantity,
      remaining,
      status: order.status,
      avgPrice,
    };
  }

  getDepth(market: string): unknown {
    if (!ExchangeStore.MARKETS.has(market)) throw new Error(`unsupported market ${market}`);

    // book looks like:
    // {
    //   bids: [
    //     { orderId: "x1", price: 50100, quantity: 2, filledQuantity: 0, side: "buy", ... },
    //     { orderId: "x2", price: 50100, quantity: 1, filledQuantity: 0, side: "buy", ... },  // same price, different order
    //     { orderId: "x3", price: 50000, quantity: 3, filledQuantity: 1, side: "buy", ... },  // lower price level
    //   ],
    //   asks: [
    //     { orderId: "y1", price: 50200, quantity: 1, filledQuantity: 0, side: "sell", ... },
    //     { orderId: "y2", price: 50300, quantity: 4, filledQuantity: 2, side: "sell", ... },
    //   ]
    // }
    //
    // We want to produce:
    // {
    //   bids: [ [50100, 3], [50000, 2] ],   // x1 + x2 merged at 50100 (2+1=3); x3 has 3-1=2 remaining
    //   asks: [ [50200, 1], [50300, 2] ],   // y1 has 1 remaining; y2 has 4-2=2 remaining
    // }
    const book = this.orderBooks.get(market);
    if (!book) {
      return { bids: [], asks: [] };
    }

    // ── aggregate bid levels ─────────────────────────────────────────────────
    // bidLevels: price → total remaining quantity across all resting orders at that price
    const bidLevels = new Map<number, number>();
    for (const order of book.bids) {
      const remaining = order.quantity - order.filledQuantity;
      const existing = bidLevels.get(order.price);
      if (existing === undefined) {
        bidLevels.set(order.price, remaining);
      } else {
        bidLevels.set(order.price, existing + remaining);
      }
    }

    // ── aggregate ask levels ─────────────────────────────────────────────────
    const askLevels = new Map<number, number>();
    for (const order of book.asks) {
      const remaining = order.quantity - order.filledQuantity;
      const existing = askLevels.get(order.price);
      if (existing === undefined) {
        askLevels.set(order.price, remaining);
      } else {
        askLevels.set(order.price, existing + remaining);
      }
    }

    // ── build output arrays ──────────────────────────────────────────────────
    // bids: high → low  e.g. [ [50100, 3], [50000, 2] ]
    const bidEntries = [...bidLevels.entries()];
    bidEntries.sort(function (a, b) { return b[0] - a[0]; });
    const bids: [number, number][] = [];
    for (const entry of bidEntries) {
      bids.push([entry[0], entry[1]]);
    }

    // asks: low → high  e.g. [ [50200, 1], [50300, 2] ]
    const askEntries = [...askLevels.entries()];
    askEntries.sort(function (a, b) { return a[0] - b[0]; });
    const asks: [number, number][] = [];
    for (const entry of askEntries) {
      asks.push([entry[0], entry[1]]);
    }

    return { bids, asks };
  }

  getUserBalance(userId: string): unknown {
    const available = this.balance.get(userId);
    if (!available) throw new Error(`no balance found for ${userId}`);
    const locked = this.locked.get(userId);
    return {
      available: Object.fromEntries(available),
      locked: Object.fromEntries(locked ?? new Map()),
    };
  }

  deposit(userId: string, asset: string, amount: number): unknown {
    if (!ExchangeStore.ASSETS.has(asset)) throw new Error(`unsupported asset ${asset}`);
    if (amount <= 0) throw new Error(`deposit amount must be positive`);
    this.credit(userId, asset, amount);
    return this.getUserBalance(userId);
  }
}

export const exchangeStore = new ExchangeStore();
