import type { Depth, Fill } from "../types/common-types";
import type {
  PerpsOrder,
  PerpsOrderBook,
  PerpsPosition,
} from "../types/perps-exchange-store-types";
import { randomUUID } from "crypto";
import { balanceStore, BalanceStore } from "./balance-store";

// Input type for order creation — excludes engine-computed fields; reduceOnly is optional (defaults false).
type CreateOrderInput = Omit<
  PerpsOrder,
  "orderId" | "filledQuantity" | "fills" | "status" | "timestamp" | "avgPrice" | "lockedPricePerUnit" | "reduceOnly"
> & { reduceOnly?: boolean };

class PerpsExchangeStore {
  constructor(private balanceStore: BalanceStore) {
    this.initializePerpsOrderBooksAndPositions();
  }
  private static readonly PERPS_MARKETS = [
    "BTC_USD",
    // "ETH_USD",
  ];
  private static readonly PERPS_ASSETS = new Set<string>(
    this.PERPS_MARKETS.map((m) => m.split("_")[1]!),
  );

  private static readonly MAX_LEVERAGE = 125;

  private calculateLiquidationPrice(
    side: "LONG" | "SHORT",
    entryPrice: number,
    leverage: number,
  ): number {
    if (side === "LONG") {
      return entryPrice * (1 - 1 / leverage);
    } else {
      return entryPrice * (1 + 1 / leverage);
    }
  }

  private initializePerpsOrderBooksAndPositions() {
    for (const market of PerpsExchangeStore.PERPS_MARKETS) {
      this.perpsOrderBooks.set(market, { bids: [], asks: [] });
      this.perpsPosition.set(market, new Map<string, PerpsPosition>());
    }
  }

  private perpsOrders = new Map<string, PerpsOrder>();
  private perpsOrderBooks = new Map<string, PerpsOrderBook>();
  private perpsPosition = new Map<string, Map<string, PerpsPosition>>();

  // --------------------------------------------------------------------------
  // updatePositionFromFill
  //
  // Called for BOTH the taker and maker on every fill. Updates positions and
  // settles PnL (Fix 1). Uses lockedPricePerUnit for accurate margin accounting
  // (Fix 2). Handles reduce-only orders (Fix 4).
  // --------------------------------------------------------------------------
  private updatePositionFromFill(
    order: PerpsOrder,
    fillPrice: number,
    fillQty: number,
  ) {
    const posMap = this.perpsPosition.get(order.market)!;
    const existingPos = posMap.get(order.userId);
    const fillSide: "LONG" | "SHORT" = order.side === "buy" ? "LONG" : "SHORT";
    const quote = order.market.split("_")[1]!;

    // priceForMargin = min(lockedPricePerUnit, fillPrice).
    //   • For limit/market buys: fill ≤ lockedPrice → min = fillPrice ✓
    //   • For limit sells:       fill ≥ lockedPrice → min = lockedPrice ✓  (no delta to release)
    //   • For market sells:      fill ≤ bestBid (= lockedPrice) → min = fillPrice ✓
    //   • For reduce-only:       lockedPrice = 0 → addedMargin = 0 (no new margin) ✓
    const priceForMargin = Math.min(order.lockedPricePerUnit, fillPrice);
    const addedMargin = (priceForMargin * fillQty) / order.leverage;

    // -----------------------------------------------------------------------
    // CASE A — no existing position → open fresh
    // -----------------------------------------------------------------------
    if (!existingPos) {
      const newPos: PerpsPosition = {
        positionId: randomUUID(),
        userId: order.userId,
        market: order.market,
        side: fillSide,
        size: fillQty,
        leverage: order.leverage,
        entryPrice: fillPrice,
        margin: addedMargin,
        liquidationPrice: this.calculateLiquidationPrice(fillSide, fillPrice, order.leverage),
        status: "OPEN",
        timestamp: Date.now(),
      };
      posMap.set(order.userId, newPos);
      return;
    }

    // -----------------------------------------------------------------------
    // CASE B — same side → increase existing position
    // -----------------------------------------------------------------------
    if (existingPos.side === fillSide) {
      const newSize = existingPos.size + fillQty;
      const weightedEntry =
        (existingPos.size * existingPos.entryPrice + fillQty * fillPrice) / newSize;
      existingPos.entryPrice = weightedEntry;
      existingPos.size = newSize;
      existingPos.margin += addedMargin;
      existingPos.liquidationPrice = this.calculateLiquidationPrice(
        existingPos.side,
        weightedEntry,
        existingPos.leverage,
      );
      return;
    }

    // -----------------------------------------------------------------------
    // CASE C — opposite side → reduce / close / flip
    //
    // PnL settlement (Fix 1):
    //   net = max(0, releasedMargin + pnl)  (losses capped at margin)
    //   deductLocked(releasedMargin)  → removes position collateral from locked
    //   credit(net)                   → returns collateral ± pnl to available
    //   unlock(addedMargin)           → releases *this closing order's* fill margin
    //                                   (only for non-reduce-only; reduce-only locked nothing)
    // -----------------------------------------------------------------------

    // PARTIAL CLOSE
    if (fillQty < existingPos.size) {
      const releasedMargin = existingPos.margin * (fillQty / existingPos.size);
      const pnl =
        existingPos.side === "LONG"
          ? (fillPrice - existingPos.entryPrice) * fillQty
          : (existingPos.entryPrice - fillPrice) * fillQty;
      const net = Math.max(0, releasedMargin + pnl);

      existingPos.margin -= releasedMargin;
      existingPos.size -= fillQty;
      existingPos.liquidationPrice = this.calculateLiquidationPrice(
        existingPos.side,
        existingPos.entryPrice,
        existingPos.leverage,
      );

      this.balanceStore.deductLocked(order.userId, quote, releasedMargin);
      this.balanceStore.credit(order.userId, quote, net);
      if (!order.reduceOnly) {
        this.balanceStore.unlock(order.userId, quote, addedMargin);
      }
      return;
    }

    // FULL CLOSE
    if (fillQty === existingPos.size) {
      const pnl =
        existingPos.side === "LONG"
          ? (fillPrice - existingPos.entryPrice) * existingPos.size
          : (existingPos.entryPrice - fillPrice) * existingPos.size;
      const net = Math.max(0, existingPos.margin + pnl);

      this.balanceStore.deductLocked(order.userId, quote, existingPos.margin);
      this.balanceStore.credit(order.userId, quote, net);
      if (!order.reduceOnly) {
        this.balanceStore.unlock(order.userId, quote, addedMargin);
      }

      existingPos.status = "CLOSED";
      existingPos.size = 0;
      posMap.delete(order.userId);
      return;
    }

    // FLIP POSITION (fillQty > existingPos.size)
    {
      const closingQty = existingPos.size;
      const leftoverQty = fillQty - closingQty;

      const pnl =
        existingPos.side === "LONG"
          ? (fillPrice - existingPos.entryPrice) * closingQty
          : (existingPos.entryPrice - fillPrice) * closingQty;
      const net = Math.max(0, existingPos.margin + pnl);

      // Settle closed position
      this.balanceStore.deductLocked(order.userId, quote, existingPos.margin);
      this.balanceStore.credit(order.userId, quote, net);

      // Release closing portion of the order's locked margin
      const closingPortionMargin = (priceForMargin * closingQty) / order.leverage;
      if (!order.reduceOnly) {
        this.balanceStore.unlock(order.userId, quote, closingPortionMargin);
      }

      posMap.delete(order.userId);

      // Open new position in opposite direction (leftover qty)
      const flippedMargin = (priceForMargin * leftoverQty) / order.leverage;
      const flippedPos: PerpsPosition = {
        positionId: randomUUID(),
        userId: order.userId,
        market: order.market,
        side: fillSide,
        size: leftoverQty,
        leverage: order.leverage,
        entryPrice: fillPrice,
        margin: flippedMargin,
        liquidationPrice: this.calculateLiquidationPrice(fillSide, fillPrice, order.leverage),
        status: "OPEN",
        timestamp: Date.now(),
      };
      posMap.set(order.userId, flippedPos);
    }
  }

  private openOrUpdatePosition(
    takerOrder: PerpsOrder,
    makerOrder: PerpsOrder,
    fill: Fill,
  ) {
    this.updatePositionFromFill(takerOrder, fill.price, fill.quantity);
    this.updatePositionFromFill(makerOrder, fill.price, fill.quantity);
  }

  public checkAndLiquidate(market: string, markPrice: number) {
    const toLiquidate: PerpsPosition[] = [];
    const posMap = this.perpsPosition.get(market);
    for (const pos of posMap!.values()) {
      if (pos.side === "LONG") {
        if (markPrice <= pos.liquidationPrice) toLiquidate.push(pos);
      } else {
        if (markPrice >= pos.liquidationPrice) toLiquidate.push(pos);
      }
    }
    const quote = market.split("_")[1]!;
    for (const pos of toLiquidate) {
      pos.status = "LIQUIDATED";
      pos.size = 0;
      const available = this.balanceStore.getLocked(pos.userId).get(quote) ?? 0;
      const toSeize = Math.min(pos.margin, available);
      if (toSeize > 0) this.balanceStore.deductLocked(pos.userId, quote, toSeize);
      pos.margin = 0;
      posMap!.delete(pos.userId);
    }
  }

  // --------------------------------------------------------------------------
  // checksForCreateOrder
  // Fix 4 (reduce-only validation) + Fix 5 (max leverage).
  // --------------------------------------------------------------------------
  private checksForCreateOrder(input: CreateOrderInput): void {
    if (!PerpsExchangeStore.PERPS_MARKETS.includes(input.market)) {
      throw new Error("invalid market");
    }
    // Fix 5: max leverage cap
    if (input.leverage <= 0 || input.leverage > PerpsExchangeStore.MAX_LEVERAGE) {
      throw new Error(`leverage must be between 1 and ${PerpsExchangeStore.MAX_LEVERAGE}`);
    }
    if (input.quantity <= 0) {
      throw new Error("quantity should be greater than 0");
    }
    if (input.price <= 0) {
      throw new Error("price should be greater than 0");
    }
    if (input.side !== "buy" && input.side !== "sell") {
      throw new Error("side should be either buy or sell");
    }
    if (input.orderType !== "limit" && input.orderType !== "market") {
      throw new Error("order type should be either limit or market");
    }
    // Fix 4: reduce-only validation
    if (input.reduceOnly) {
      const posMap = this.perpsPosition.get(input.market)!;
      const existingPos = posMap?.get(input.userId);
      const orderSide = input.side === "buy" ? "LONG" : "SHORT";
      if (!existingPos || existingPos.status !== "OPEN" || existingPos.side === orderSide) {
        throw new Error(
          "reduce-only order requires an existing open position on the opposite side",
        );
      }
      if (input.quantity > existingPos.size) {
        throw new Error("reduce-only quantity exceeds existing position size");
      }
    }
  }

  // --------------------------------------------------------------------------
  // createPerpsOrder
  // Fix 2: lockedPricePerUnit (market sell uses best-bid; unified delta unlock
  //         for both sides; maker also gets delta unlock).
  // Fix 3: self-trade prevention.
  // --------------------------------------------------------------------------
  createPerpsOrder(input: CreateOrderInput): unknown {
    this.checksForCreateOrder(input);

    const quote = input.market.split("_")[1]!;
    const ob = this.perpsOrderBooks.get(input.market) || { bids: [], asks: [] };

    // Fix 2: determine locked price per unit.
    // Market SELL → lock margin at best bid (actual exposure), not input.price (=floor).
    // All other orders → lock at input.price (cap for buys, floor for limit sells).
    let lockedPricePerUnit: number;
    if (input.reduceOnly) {
      lockedPricePerUnit = 0; // reduce-only locks no new margin
    } else if (input.orderType === "market" && input.side === "sell") {
      // Lock at best bid; if book empty → 0 so balance check passes and order cancels immediately
      lockedPricePerUnit = ob.bids[0]?.price ?? 0;
    } else if (input.orderType === "market" && input.side === "buy") {
      // Lock at best ask; if book empty → 0 so balance check passes and order cancels immediately
      lockedPricePerUnit = ob.asks[0]?.price ?? 0;
    } else {
      lockedPricePerUnit = input.price;
    }

    const requiredMargin = input.reduceOnly
      ? 0
      : (lockedPricePerUnit * input.quantity) / input.leverage;

    if (!input.reduceOnly) {
      const userCurrBal = this.balanceStore.getBalance(input.userId).get(quote);
      if (!userCurrBal || userCurrBal < requiredMargin) {
        throw new Error("not enough balance to place order");
      }
    }

    let orderId = randomUUID();
    while (this.perpsOrders.has(orderId)) {
      orderId = randomUUID();
    }

    const order: PerpsOrder = {
      ...input,
      orderId,
      filledQuantity: 0,
      fills: [],
      status: "OPEN",
      timestamp: Date.now(),
      avgPrice: 0,
      lockedPricePerUnit,
      reduceOnly: input.reduceOnly ?? false,
    };

    if (!order.reduceOnly) {
      this.balanceStore.lock(input.userId, quote, requiredMargin);
    }

    this.perpsOrders.set(orderId, order);

    const oppositeSide = input.side === "buy" ? "asks" : "bids";
    const toIterate = ob[oppositeSide];
    let matched = true;

    while (
      toIterate.length > 0 &&
      order.filledQuantity < order.quantity &&
      matched
    ) {
      const bestOppositeOrder = toIterate[0]!;

      // Fix 3: self-trade prevention — stop matching when own order is at the top.
      if (bestOppositeOrder.userId === order.userId) {
        break;
      }

      matched =
        input.side === "buy"
          ? order.price >= bestOppositeOrder.price
          : order.price <= bestOppositeOrder.price;

      if (matched) {
        const fillQty = Math.min(
          order.quantity - order.filledQuantity,
          bestOppositeOrder.quantity - bestOppositeOrder.filledQuantity,
        );
        const fillPrice = bestOppositeOrder.price;
        const fill: Fill = {
          makerOrderId: bestOppositeOrder.orderId,
          takerOrderId: order.orderId,
          price: fillPrice,
          quantity: fillQty,
          timestamp: Date.now(),
        };

        order.filledQuantity += fillQty;
        bestOppositeOrder.filledQuantity += fillQty;
        order.fills.push(fill);
        bestOppositeOrder.fills.push(fill);

        // Update avg prices
        order.avgPrice =
          (order.avgPrice * (order.filledQuantity - fillQty) + fillPrice * fillQty) /
          order.filledQuantity;
        bestOppositeOrder.avgPrice =
          (bestOppositeOrder.avgPrice * (bestOppositeOrder.filledQuantity - fillQty) +
            fillPrice * fillQty) /
          bestOppositeOrder.filledQuantity;

        // Fix 2: unified delta unlock for the TAKER.
        // delta = excess margin locked above actual fill cost.
        // Positive for: limit buys (fill < cap), market buys (fill << 999999), market sells (fill < bestBid).
        // Zero for: limit sells (fill >= limit → no excess to release).
        if (!order.reduceOnly) {
          const takerDelta =
            ((order.lockedPricePerUnit - fillPrice) * fillQty) / order.leverage;
          if (takerDelta > 0) {
            this.balanceStore.unlock(order.userId, quote, takerDelta);
          }
        }

        // Fix 2: also apply delta unlock to the MAKER.
        // Makers (limit buys) can have excess locked when fill < their limit price.
        if (!bestOppositeOrder.reduceOnly) {
          const makerDelta =
            ((bestOppositeOrder.lockedPricePerUnit - fillPrice) * fillQty) /
            bestOppositeOrder.leverage;
          if (makerDelta > 0) {
            this.balanceStore.unlock(bestOppositeOrder.userId, quote, makerDelta);
          }
        }

        this.openOrUpdatePosition(order, bestOppositeOrder, fill);

        if (bestOppositeOrder.filledQuantity === bestOppositeOrder.quantity) {
          bestOppositeOrder.status = "FILLED";
          toIterate.shift();
        } else {
          bestOppositeOrder.status = "PARTIALLY_FILLED";
        }
      }
    }

    if (order.filledQuantity === order.quantity) {
      order.status = "FILLED";
    } else if (order.filledQuantity > 0) {
      if (order.orderType === "market") {
        order.status = "PARTIALLY_CANCELLED";
        const amountToUnlock = order.reduceOnly
          ? 0
          : ((order.quantity - order.filledQuantity) * order.lockedPricePerUnit) /
            order.leverage;
        if (amountToUnlock > 0) {
          this.balanceStore.unlock(order.userId, quote, amountToUnlock);
        }
      } else {
        order.status = "PARTIALLY_FILLED";
        ob[input.side === "buy" ? "bids" : "asks"].push(order);
        ob[input.side === "buy" ? "bids" : "asks"].sort((a, b) => {
          if (a.price === b.price) return a.timestamp - b.timestamp;
          return input.side === "buy" ? b.price - a.price : a.price - b.price;
        });
      }
    } else {
      // filledQuantity === 0
      if (order.orderType === "limit") {
        ob[input.side === "buy" ? "bids" : "asks"].push(order);
        ob[input.side === "buy" ? "bids" : "asks"].sort((a, b) => {
          if (a.price === b.price) return a.timestamp - b.timestamp;
          return input.side === "buy" ? b.price - a.price : a.price - b.price;
        });
      } else {
        // Market order with 0 fills — cancel and unlock
        order.status = "CANCELLED";
        if (!order.reduceOnly) {
          this.balanceStore.unlock(order.userId, quote, requiredMargin);
        }
      }
    }

    return order;
  }

  cancelPerpsOrder(_market: string, orderId: string): PerpsOrder {
    const order = this.perpsOrders.get(orderId);
    if (!order) {
      throw new Error("order not found!");
    }
    if (
      order.status === "FILLED" ||
      order.status === "CANCELLED" ||
      order.status === "PARTIALLY_CANCELLED"
    ) {
      throw new Error(`order cannot be cancelled (status: ${order.status})`);
    }
    const side = order.side;
    const ob = this.perpsOrderBooks.get(order.market);
    const inOrderBookSideArray = side === "buy" ? ob?.bids : ob?.asks;
    const index = inOrderBookSideArray?.findIndex((o) => o.orderId === orderId);
    if (index === -1 || index === undefined) {
      throw new Error("order not found in order book");
    }
    inOrderBookSideArray!.splice(index!, 1);

    if (order.filledQuantity === 0) {
      order.status = "CANCELLED";
    } else {
      order.status = "PARTIALLY_CANCELLED";
    }

    // Unlock the unfilled portion's margin. Reduce-only orders locked nothing.
    if (!order.reduceOnly) {
      const unfilledQty = order.quantity - order.filledQuantity;
      const unfilledMargin = (order.lockedPricePerUnit * unfilledQty) / order.leverage;
      this.balanceStore.unlock(order.userId, order.market.split("_")[1]!, unfilledMargin);
    }

    return order;
  }

  getPerpsOrder(orderId: string, userId: string): PerpsOrder {
    const order = this.perpsOrders.get(orderId);
    if (!order || order.userId !== userId) {
      throw new Error("order not found!");
    }
    return order;
  }

  getDepth(market: string): Depth {
    if (!PerpsExchangeStore.PERPS_MARKETS.includes(market)) {
      throw new Error("invalid perps market");
    }
    const m = this.perpsOrderBooks.get(market);
    const bidLevels = new Map<number, number>();
    for (const order of m?.bids!) {
      const remainingQty = order.quantity - order.filledQuantity;
      bidLevels.set(order.price, (bidLevels.get(order.price) || 0) + remainingQty);
    }
    const askLevels = new Map<number, number>();
    for (const order of m?.asks!) {
      const remainingQty = order.quantity - order.filledQuantity;
      askLevels.set(order.price, (askLevels.get(order.price) || 0) + remainingQty);
    }
    const finalBids = Array.from(bidLevels.entries()).map(([price, count]) => ({ price, count }));
    const finalAsks = Array.from(askLevels.entries()).map(([price, count]) => ({ price, count }));
    return { bids: finalBids, asks: finalAsks };
  }

  getPosition(userId: string, market: string) {
    if (!PerpsExchangeStore.PERPS_MARKETS.includes(market)) {
      throw new Error("invalid perps market");
    }
    const m = this.perpsPosition.get(market);
    const position = m?.get(userId);
    if (!position || position.status !== "OPEN") {
      throw new Error(`no position found in market ${market} for user ${userId}`);
    }
    return position;
  }

  getUserPosition(userId: string) {
    const positions: PerpsPosition[] = [];
    for (const market of PerpsExchangeStore.PERPS_MARKETS) {
      const m = this.perpsPosition.get(market);
      const position = m?.get(userId);
      if (position && position.status === "OPEN") {
        positions.push(position);
      }
    }
    return positions;
  }

  getUserBalance(userId: string): { balance: Record<string, number>; locked: Record<string, number> } {
    return this.balanceStore.getUserBalance(userId);
  }
}

export const perpsExchangeStore = new PerpsExchangeStore(balanceStore);
