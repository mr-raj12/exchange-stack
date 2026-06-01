import type { Depth, Fill } from "../types/common-types";
import type {
  PerpsOrder,
  PerpsOrderBook,
  PerpsPosition,
} from "../types/perps-exchange-store-types";
import { randomUUID } from "crypto";
import { balanceStore, BalanceStore } from "./balance-store";
import { writeOrder, writeFill, writePosition, writeBalance, writeInsuranceFundEvent, writeFundingRate, writeOrderbookSnapshot } from "../db/writer.js";
import { INSURANCE_FUND_USER_ID } from "../constants.js";
import { publishUserEvent, publishMarketEvent, publishOrderbookSnapshot } from "../publisher.js";

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

  // Tracks the most recent mark price per market (used by settleFunding in Phase 3A)
  private lastMarkPrice = new Map<string, number>();

  private publishPositionEvent(pos: PerpsPosition): void {
    const markPrice = this.lastMarkPrice.get(pos.market) ?? pos.entryPrice;
    const unrealizedPnl = pos.status === "OPEN"
      ? (pos.side === "LONG"
          ? (markPrice - pos.entryPrice) * pos.size
          : (pos.entryPrice - markPrice) * pos.size)
      : 0;
    publishUserEvent(pos.userId, {
      type: "position_update",
      userId: pos.userId,
      market: pos.market,
      side: pos.side === "LONG" ? "long" : "short",
      quantity: pos.size,
      entryPrice: pos.entryPrice,
      liquidationPrice: pos.liquidationPrice,
      unrealizedPnl,
      margin: pos.margin,
      leverage: pos.leverage,
    });
  }

  private snapshotPerpsOb(market: string): void {
    const ob = this.perpsOrderBooks.get(market);
    if (!ob) return;
    const bidLevels = new Map<number, number>();
    for (const o of ob.bids) {
      bidLevels.set(o.price, (bidLevels.get(o.price) ?? 0) + (o.quantity - o.filledQuantity));
    }
    const askLevels = new Map<number, number>();
    for (const o of ob.asks) {
      askLevels.set(o.price, (askLevels.get(o.price) ?? 0) + (o.quantity - o.filledQuantity));
    }
    const bids: [string, string][] = Array.from(bidLevels.entries()).map(([p, q]) => [p.toString(), q.toString()]);
    const asks: [string, string][] = Array.from(askLevels.entries()).map(([p, q]) => [p.toString(), q.toString()]);
    publishOrderbookSnapshot(market, bids, asks);
    writeOrderbookSnapshot(market, "PERPS", bids, asks);
  }

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

  private computeBankruptcyPrice(
    side: "LONG" | "SHORT",
    entryPrice: number,
    leverage: number,
  ): number {
    // Bankruptcy price = price at which margin = 0.
    // In our model liq_price == bankruptcy_price (no maintenance margin buffer).
    return side === "LONG"
      ? entryPrice * (1 - 1 / leverage)
      : entryPrice * (1 + 1 / leverage);
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
    //   • For reduce-only / liquidation: lockedPrice = 0 → addedMargin = 0 (no new margin) ✓
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
      writePosition(newPos);
      this.publishPositionEvent(newPos);
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
      writePosition(existingPos);
      this.publishPositionEvent(existingPos);
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
      if (!order.reduceOnly && !order.isLiquidation) {
        this.balanceStore.unlock(order.userId, quote, addedMargin);
      }
      writePosition(existingPos);
      this.publishPositionEvent(existingPos);
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
      if (!order.reduceOnly && !order.isLiquidation) {
        this.balanceStore.unlock(order.userId, quote, addedMargin);
      }

      existingPos.status = "CLOSED";
      existingPos.size = 0;
      writePosition(existingPos); // capture closed state before delete
      this.publishPositionEvent(existingPos);
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
      if (!order.reduceOnly && !order.isLiquidation) {
        this.balanceStore.unlock(order.userId, quote, closingPortionMargin);
      }

      const closedSnapForDb: PerpsPosition = { ...existingPos, status: "CLOSED", size: 0 };
      posMap.delete(order.userId);
      writePosition(closedSnapForDb);
      this.publishPositionEvent(closedSnapForDb);

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
      writePosition(flippedPos);
      this.publishPositionEvent(flippedPos);
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

  // --------------------------------------------------------------------------
  // updateMarkPrice — stores last mark price and triggers liquidation check.
  // Called from engine/src/index.ts on every MARK_PRICE_STREAM message.
  // --------------------------------------------------------------------------
  public updateMarkPrice(market: string, price: number): void {
    this.lastMarkPrice.set(market, price);
    this.checkAndLiquidate(market, price);
  }

  // --------------------------------------------------------------------------
  // settleFunding
  //
  // Called when the engine receives a funding_rate_stream trigger. Applies the
  // funding rate to every open position: longs pay, shorts receive (rate > 0).
  // Deducts or credits margin + balance accordingly; positions whose margin
  // hits zero are directly seized rather than relying on liquidationPrice.
  //
  // v1: fixed FUNDING_RATE = 0.01% per interval. v2 can derive from premium index.
  // --------------------------------------------------------------------------
  public settleFunding(market: string): void {
    const markPrice = this.lastMarkPrice.get(market);
    if (!markPrice) {
      console.warn(`[funding] no mark price cached for ${market}, skipping settlement`);
      return;
    }

    const posMap = this.perpsPosition.get(market);
    if (!posMap || posMap.size === 0) return;

    const quote = market.split("_")[1]!;
    const FUNDING_RATE = 0.0001; // 0.01% per 8h — fixed v1 baseline

    const payments: { userId: string; amount: number; side: string }[] = [];
    const toSeize: PerpsPosition[] = [];

    for (const [userId, pos] of posMap) {
      if (pos.status !== "OPEN") continue;

      const notional = pos.size * markPrice;
      // payment > 0 → LONG pays this amount; SHORT receives this amount
      const payment = notional * FUNDING_RATE;

      if (pos.side === "LONG") {
        const actualDeduction = Math.min(payment, pos.margin);
        pos.margin -= actualDeduction;

        const lockedAmt = this.balanceStore.getLocked(userId).get(quote) ?? 0;
        const toDeduct = Math.min(actualDeduction, lockedAmt);
        if (toDeduct > 0) this.balanceStore.deductLocked(userId, quote, toDeduct);

        writeBalance(userId, quote,
          this.balanceStore.getBalance(userId).get(quote) ?? 0,
          this.balanceStore.getLocked(userId).get(quote) ?? 0,
        );

        payments.push({ userId, amount: -actualDeduction, side: "long" }); // negative = paid
        publishUserEvent(userId, {
          type: "funding_payment",
          userId,
          market,
          positionSide: "long",
          amount: -actualDeduction,
          rate: FUNDING_RATE,
          markPrice,
          notionalValue: notional,
          timestamp: Date.now(),
        });
      } else {
        // SHORT receives
        pos.margin += payment;
        this.balanceStore.credit(userId, quote, payment);

        writeBalance(userId, quote,
          this.balanceStore.getBalance(userId).get(quote) ?? 0,
          this.balanceStore.getLocked(userId).get(quote) ?? 0,
        );

        payments.push({ userId, amount: payment, side: "short" }); // positive = received
        publishUserEvent(userId, {
          type: "funding_payment",
          userId,
          market,
          positionSide: "short",
          amount: payment,
          rate: FUNDING_RATE,
          markPrice,
          notionalValue: notional,
          timestamp: Date.now(),
        });
      }

      writePosition(pos);

      if (pos.margin <= 0) {
        toSeize.push(pos);
      }
    }

    // Seize positions whose margin was fully consumed by funding (outside the loop to avoid mutation mid-iteration)
    for (const pos of toSeize) {
      console.warn(`[funding] ${pos.userId} ${market}: margin exhausted by funding, seizing position`);
      this.directSeize(pos, posMap, quote);
    }

    writeFundingRate(market, FUNDING_RATE, markPrice, markPrice, payments);
    publishMarketEvent(market, {
      type: "funding_rate",
      market,
      rate: FUNDING_RATE,
      markPrice,
      indexPrice: markPrice,
      nextFundingAt: Date.now() + 8 * 60 * 60 * 1000,
    });
    console.log(`[funding] settled ${market} rate=${FUNDING_RATE} markPrice=${markPrice} positions=${payments.length}`);
  }

  // --------------------------------------------------------------------------
  // checkAndLiquidate
  //
  // For each position whose liquidation price was crossed by markPrice, places
  // a real market order through the orderbook (proper price discovery). Falls
  // back to direct margin seizure when the book is empty.
  //
  // After each fill batch: routes surplus above bankruptcy price to the
  // insurance fund; draws deficits from the insurance fund; triggers ADL stub
  // when the fund is exhausted.
  // --------------------------------------------------------------------------
  public checkAndLiquidate(market: string, markPrice: number): void {
    const posMap = this.perpsPosition.get(market);
    if (!posMap) return;

    const quote = market.split("_")[1]!;

    // Collect first — modifying posMap while iterating is unsafe.
    const toLiquidate: PerpsPosition[] = [];
    for (const pos of posMap.values()) {
      if (pos.status !== "OPEN") continue;
      const crosses =
        pos.side === "LONG"
          ? markPrice <= pos.liquidationPrice
          : markPrice >= pos.liquidationPrice;
      if (crosses) toLiquidate.push(pos);
    }

    for (const pos of toLiquidate) {
      const { userId, side, size, entryPrice, leverage } = pos;
      const marginSnapshot = pos.margin;       // capture before fills mutate it
      const liqPriceSnapshot = pos.liquidationPrice;
      const bankruptcyPrice = this.computeBankruptcyPrice(side, entryPrice, leverage);

      // Market order price: 0 for SELL (matches any bid) or MAX for BUY (matches any ask).
      const liquidationSide: "buy" | "sell" = side === "LONG" ? "sell" : "buy";
      const liquidationOrderPrice = side === "LONG" ? 0 : Number.MAX_SAFE_INTEGER;

      let order: PerpsOrder;
      try {
        order = this.createPerpsOrder({
          userId,
          market,
          side: liquidationSide,
          orderType: "market",
          price: liquidationOrderPrice,
          quantity: size,
          leverage,
          isLiquidation: true,
        }) as PerpsOrder;
      } catch (err) {
        console.error(`[liquidation] order failed for ${userId} ${market}:`, err);
        this.directSeize(pos, posMap, quote, false);
        publishUserEvent(userId, {
          type: "liquidation",
          userId,
          market,
          side: side === "LONG" ? "long" : "short",
          markPrice,
          liquidationPrice: liqPriceSnapshot,
          marginLost: marginSnapshot,
        });
        continue;
      }

      if (order.filledQuantity === 0) {
        // Empty book — fall back to direct margin seizure.
        console.warn(`[liquidation] ${userId} ${market}: no liquidity, direct seizure`);
        this.directSeize(pos, posMap, quote, false);
        publishUserEvent(userId, {
          type: "liquidation",
          userId,
          market,
          side: side === "LONG" ? "long" : "short",
          markPrice,
          liquidationPrice: liqPriceSnapshot,
          marginLost: marginSnapshot,
        });
        continue;
      }

      // -----------------------------------------------------------------------
      // Insurance fund: route surplus / deficit from fills vs bankruptcy price.
      // -----------------------------------------------------------------------
      let totalSurplus = 0;
      for (const fill of order.fills) {
        // surplus > 0 → fill was better than bankruptcy (inflow to fund)
        // surplus < 0 → fill was worse than bankruptcy (outflow from fund)
        const surplusPerUnit =
          side === "LONG" ? fill.price - bankruptcyPrice : bankruptcyPrice - fill.price;
        totalSurplus += surplusPerUnit * fill.quantity;
      }

      if (totalSurplus > 0) {
        // Fill happened at a better price than bankruptcy — surplus goes to insurance fund.
        // updatePositionFromFill already credited the user with `net` which includes this surplus.
        // We transfer it out of the user's available balance into the fund.
        try {
          this.balanceStore.lock(userId, quote, totalSurplus);
          this.balanceStore.deductLocked(userId, quote, totalSurplus);
          this.balanceStore.credit(INSURANCE_FUND_USER_ID, quote, totalSurplus);
          writeInsuranceFundEvent(market, totalSurplus, "liquidation_surplus");
          // Re-snapshot Alice's balance after surplus transfer
          const bal = this.balanceStore.getBalance(userId);
          const lck = this.balanceStore.getLocked(userId);
          writeBalance(userId, quote, bal.get(quote) ?? 0, lck.get(quote) ?? 0);
        } catch {
          console.warn(`[liquidation] surplus routing failed for ${userId} — keeping in user balance`);
        }
      } else if (totalSurplus < 0) {
        // Fill happened worse than bankruptcy — deficit absorbed by insurance fund.
        const deficit = -totalSurplus;
        const fundBal = this.balanceStore.getBalance(INSURANCE_FUND_USER_ID).get(quote) ?? 0;
        const toDraw = Math.min(deficit, fundBal);

        if (toDraw > 0) {
          this.balanceStore.lock(INSURANCE_FUND_USER_ID, quote, toDraw);
          this.balanceStore.deductLocked(INSURANCE_FUND_USER_ID, quote, toDraw);
          this.balanceStore.credit(userId, quote, toDraw);
          writeInsuranceFundEvent(market, -toDraw, "liquidation_deficit");
          const bal = this.balanceStore.getBalance(userId);
          const lck = this.balanceStore.getLocked(userId);
          writeBalance(userId, quote, bal.get(quote) ?? 0, lck.get(quote) ?? 0);
        }

        if (toDraw < deficit) {
          this.triggerADL(market, side === "LONG" ? "SHORT" : "LONG", deficit - toDraw);
        }
      }

      // If only partially filled, seize remaining position margin directly.
      if (pos.status === "OPEN") {
        this.directSeize(pos, posMap, quote, false);
      }

      // Publish ONE LiquidationEvent per liquidated position (regardless of orderbook vs seize path)
      publishUserEvent(userId, {
        type: "liquidation",
        userId,
        market,
        side: side === "LONG" ? "long" : "short",
        markPrice,
        liquidationPrice: liqPriceSnapshot,
        marginLost: marginSnapshot,
      });

      console.log(
        `[liquidation] ${userId} ${market} liqPrice=${liqPriceSnapshot} markPrice=${markPrice}` +
        ` fills=${order.fills.length} surplus=${totalSurplus.toFixed(4)}`,
      );
    }
  }

  // Seize remaining position margin directly (empty book, partial fill fallback, or funding exhaustion).
  // publishLiquidationEvent=false when called from checkAndLiquidate (it publishes its own event).
  private directSeize(
    pos: PerpsPosition,
    posMap: Map<string, PerpsPosition>,
    quote: string,
    publishLiquidationEvent: boolean = true,
  ): void {
    const marginLost = pos.margin;
    const liqPrice = pos.liquidationPrice;
    const side = pos.side;
    const userId = pos.userId;
    const market = pos.market;

    const lockedAmt = this.balanceStore.getLocked(pos.userId).get(quote) ?? 0;
    const toSeize = Math.min(pos.margin, lockedAmt);
    if (toSeize > 0) this.balanceStore.deductLocked(pos.userId, quote, toSeize);
    pos.status = "LIQUIDATED";
    pos.size = 0;
    pos.margin = 0;
    posMap.delete(pos.userId);
    writePosition(pos);
    if (publishLiquidationEvent) {
      publishUserEvent(userId, {
        type: "liquidation",
        userId,
        market,
        side: side === "LONG" ? "long" : "short",
        markPrice: this.lastMarkPrice.get(market) ?? 0,
        liquidationPrice: liqPrice,
        marginLost,
      });
    }
    this.publishPositionEvent(pos); // qty=0, margin=0 → signals closed to client
    const bal = this.balanceStore.getBalance(pos.userId);
    const lck = this.balanceStore.getLocked(pos.userId);
    writeBalance(pos.userId, quote, bal.get(quote) ?? 0, lck.get(quote) ?? 0);
  }

  // ADL stub — logs shortfall; full implementation deferred to a later phase.
  private triggerADL(market: string, side: "LONG" | "SHORT", shortfall: number): void {
    console.warn(
      `[ADL] ${market} ${side} shortfall=${shortfall.toFixed(4)} USDT` +
      ` — insurance fund exhausted; ADL stub (no positions deleveraged)`,
    );
    writeInsuranceFundEvent(market, -shortfall, "adl");
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
  // Liquidation bypass: isLiquidation=true skips margin checks and lock/unlock.
  // --------------------------------------------------------------------------
  createPerpsOrder(input: CreateOrderInput): unknown {
    const isLiquidation = input.isLiquidation ?? false;

    // Liquidation orders skip all pre-flight checks — position was already validated
    // when it was opened, and the engine has authority to close it at any price.
    if (!isLiquidation) {
      this.checksForCreateOrder(input);
    }

    const quote = input.market.split("_")[1]!;
    const ob = this.perpsOrderBooks.get(input.market) || { bids: [], asks: [] };

    // Fix 2: determine locked price per unit.
    // Liquidation orders lock nothing (position margin is already locked).
    // Market SELL → lock margin at best bid (actual exposure), not input.price (=floor).
    // All other orders → lock at input.price (cap for buys, floor for limit sells).
    let lockedPricePerUnit: number;
    if (isLiquidation) {
      lockedPricePerUnit = 0;
    } else if (input.reduceOnly) {
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

    const requiredMargin = isLiquidation || input.reduceOnly
      ? 0
      : (lockedPricePerUnit * input.quantity) / input.leverage;

    if (!isLiquidation && !input.reduceOnly) {
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
      isLiquidation,
    };

    if (!isLiquidation && !order.reduceOnly) {
      this.balanceStore.lock(input.userId, quote, requiredMargin);
    }

    this.perpsOrders.set(orderId, order);
    writeOrder(order, "PERPS"); // insert row before any fill can reference it

    const oppositeSide = input.side === "buy" ? "asks" : "bids";
    const toIterate = ob[oppositeSide];
    let matched = true;
    const affectedMakerIds = new Set<string>();

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
        writeFill(fill, bestOppositeOrder.side);
        affectedMakerIds.add(bestOppositeOrder.userId);

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
        // Zero / negative for: limit sells (fill >= limit → no excess to release).
        // Liquidation orders have lockedPricePerUnit = 0 → takerDelta always ≤ 0 → no unlock.
        if (!order.reduceOnly && !order.isLiquidation) {
          const takerDelta =
            ((order.lockedPricePerUnit - fillPrice) * fillQty) / order.leverage;
          if (takerDelta > 0) {
            this.balanceStore.unlock(order.userId, quote, takerDelta);
          }
        }

        // Fix 2: also apply delta unlock to the MAKER.
        // Makers (limit buys) can have excess locked when fill < their limit price.
        if (!bestOppositeOrder.reduceOnly && !bestOppositeOrder.isLiquidation) {
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
        writeOrder(bestOppositeOrder, "PERPS");
        // Publish fill events for taker and maker
        publishUserEvent(order.userId, {
          type: "fill",
          orderId: order.orderId,
          userId: order.userId,
          market: input.market,
          side: input.side,
          price: fill.price,
          quantity: fill.quantity,
          fee: 0,
          timestamp: fill.timestamp,
        });
        publishUserEvent(bestOppositeOrder.userId, {
          type: "fill",
          orderId: bestOppositeOrder.orderId,
          userId: bestOppositeOrder.userId,
          market: input.market,
          side: bestOppositeOrder.side,
          price: fill.price,
          quantity: fill.quantity,
          fee: 0,
          timestamp: fill.timestamp,
        });
        // Publish maker order update
        publishUserEvent(bestOppositeOrder.userId, {
          type: "order_update",
          orderId: bestOppositeOrder.orderId,
          userId: bestOppositeOrder.userId,
          market: input.market,
          status: bestOppositeOrder.status === "FILLED" ? "filled" : "partially_filled",
          filledQuantity: bestOppositeOrder.filledQuantity,
          remainingQuantity: bestOppositeOrder.quantity - bestOppositeOrder.filledQuantity,
        });
      }
    }

    if (order.filledQuantity === order.quantity) {
      order.status = "FILLED";
    } else if (order.filledQuantity > 0) {
      if (order.orderType === "market") {
        order.status = "PARTIALLY_CANCELLED";
        // lockedPricePerUnit = 0 for liquidation → amountToUnlock = 0, no unlock needed.
        const amountToUnlock = order.reduceOnly || order.isLiquidation
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
        // Market order with 0 fills — cancel and unlock.
        // Liquidation: requiredMargin = 0, no unlock needed.
        order.status = "CANCELLED";
        if (!order.reduceOnly && !order.isLiquidation) {
          this.balanceStore.unlock(order.userId, quote, requiredMargin);
        }
      }
    }

    writeOrder(order, "PERPS");
    // Skip publishing order updates for liquidation orders — they're system-internal
    if (!order.isLiquidation) {
      publishUserEvent(order.userId, {
        type: "order_update",
        orderId: order.orderId,
        userId: order.userId,
        market: input.market,
        status: order.status === "FILLED"
          ? "filled"
          : order.status === "PARTIALLY_FILLED"
            ? "partially_filled"
            : order.status === "CANCELLED" || order.status === "PARTIALLY_CANCELLED"
              ? "cancelled"
              : "open",
        filledQuantity: order.filledQuantity,
        remainingQuantity: order.quantity - order.filledQuantity,
      });
    }
    this.snapshotPerpsOb(input.market);
    this.flushPerpsBalances(order.userId, affectedMakerIds, quote);
    return order;
  }

  private flushPerpsBalances(
    takerId: string,
    makerIds: Set<string>,
    quote: string,
  ): void {
    for (const userId of [takerId, ...makerIds]) {
      const bal = this.balanceStore.getBalance(userId);
      const lck = this.balanceStore.getLocked(userId);
      writeBalance(userId, quote, bal.get(quote) ?? 0, lck.get(quote) ?? 0);
    }
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

    writeOrder(order, "PERPS");
    publishUserEvent(order.userId, {
      type: "order_update",
      orderId: order.orderId,
      userId: order.userId,
      market: order.market,
      status: "cancelled",
      filledQuantity: order.filledQuantity,
      remainingQuantity: order.quantity - order.filledQuantity,
    });
    this.snapshotPerpsOb(order.market);
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
