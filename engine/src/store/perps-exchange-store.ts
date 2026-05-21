import type { Depth, Fill } from "../types/common-types";
import type {
  PerpsOrder,
  PerpsOrderBook,
  PerpsPosition,
} from "../types/perps-exchange-store-types";
import { randomUUID } from "crypto";
import { balanceStore, BalanceStore } from "./balance-store";

class PerpsExchangeStore {
  // balance &  locked = new Map<string, Map<string, number>>();
  constructor(private balanceStore: BalanceStore) {
    // this.balanceStore=balanceStore;
    this.initializePerpsOrderBooksAndPositions();
  }
  private static readonly PERPS_MARKETS = [
    "BTC_USD",
    // "ETH_USD",
    // "ETH_BTC",
    // "BTC_SOL",
  ];
  private static readonly PERPS_ASSETS = new Set<string>(
    // map= array of arrays
    // flatmap = array of array ko flattened krdo
    // i.e. [[1,2],[3,4]] => [1,2,3,4]
    this.PERPS_MARKETS.map((m) => m.split("_")[1]!),
  );

  private calculateLiquidationPrice(
    side: "LONG" | "SHORT",
    entryPrice: number,
    leverage: number,
  ): number {
    // very basic liquidation price calculation without considering funding, fees, etc.
    if (side === "LONG") {
      return entryPrice * (1 - 1 / leverage);
    } else {
      return entryPrice * (1 + 1 / leverage);
    }
  }
  private initializePerpsOrderBooksAndPositions() {
    // a in arraay => a = index value in array
    // a of array => a = value in array
    for (const market of PerpsExchangeStore.PERPS_MARKETS) {
      // const key = market.split("_")[0]!;
      // BTC ka perps
      this.perpsOrderBooks.set(market, { bids: [], asks: [] });
      this.perpsPosition.set(market, new Map<string, PerpsPosition>());
    }
  }

  // ek he market rakhna h
  // to ek  market k order p position will only one like for a user id as we are specific market
  // private balanceStore: BalanceStore

  private perpsOrders = new Map<string, PerpsOrder>();
  private perpsOrderBooks = new Map<string, PerpsOrderBook>();
  private perpsPosition = new Map<string, Map<string, PerpsPosition>>();
  //perpsposition: market → userId → Position

  private updatePositionFromFill(
    order: PerpsOrder,
    fillPrice: number,
    fillQty: number,
  ) {
    const posMap = this.perpsPosition.get(order.market)!;

    const existingPos = posMap.get(order.userId);

    const fillSide: "LONG" | "SHORT" = order.side === "buy" ? "LONG" : "SHORT";

    // margin added by this fill
    const addedMargin = (fillPrice * fillQty) / order.leverage;

    // -------------------------------
    // CASE A — no existing position
    // -------------------------------
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
        liquidationPrice: this.calculateLiquidationPrice(
          fillSide,
          fillPrice,
          order.leverage,
        ),
        status: "OPEN",
        timestamp: Date.now(),
      };

      posMap.set(order.userId, newPos);
      return;
    }

    // ----------------------------------------
    // CASE B — same side (increase position)
    // ----------------------------------------
    if (existingPos.side === fillSide) {
      const newSize = existingPos.size + fillQty;

      const weightedEntry =
        (existingPos.size * existingPos.entryPrice + fillQty * fillPrice) /
        newSize;

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

    // ------------------------------------------------
    // CASE C — opposite side (reduce / close / flip)
    // ------------------------------------------------

    // PARTIAL CLOSE
    if (fillQty < existingPos.size) {
      const remainingSize = existingPos.size - fillQty;

      // release proportional margin
      const releasedMargin = existingPos.margin * (fillQty / existingPos.size);

      existingPos.margin -= releasedMargin;

      existingPos.size = remainingSize;

      existingPos.liquidationPrice = this.calculateLiquidationPrice(
        existingPos.side,
        existingPos.entryPrice,
        existingPos.leverage,
      );

      // unlock released margin
      this.balanceStore.unlock(order.userId, "USD", releasedMargin);

      return;
    }

    // FULL CLOSE
    if (fillQty === existingPos.size) {
      this.balanceStore.unlock(order.userId, "USD", existingPos.margin);

      existingPos.status = "CLOSED";
      existingPos.size = 0;

      posMap.delete(order.userId);

      return;
    }

    // FLIP POSITION
    if (fillQty > existingPos.size) {
      const leftoverQty = fillQty - existingPos.size;

      // unlock old margin
      this.balanceStore.unlock(order.userId, "USD", existingPos.margin);

      // close old position
      posMap.delete(order.userId);

      // open fresh opposite position
      const flippedPos: PerpsPosition = {
        positionId: randomUUID(),
        userId: order.userId,
        market: order.market,
        side: fillSide,
        size: leftoverQty,
        leverage: order.leverage,
        entryPrice: fillPrice,
        margin: (fillPrice * leftoverQty) / order.leverage,

        liquidationPrice: this.calculateLiquidationPrice(
          fillSide,
          fillPrice,
          order.leverage,
        ),

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
    // update position for taker and maker
    this.updatePositionFromFill(takerOrder, fill.price, fill.quantity);
    this.updatePositionFromFill(makerOrder, fill.price, fill.quantity);
  }
  public checkAndLiquidate(market: string, markPrice: number) {
    // in all positions of that market liquidate them
    const toLiquidate: PerpsPosition[] = [];
    const posMap = this.perpsPosition.get(market);
    for( const pos of posMap!.values()){
      if(pos.side === "LONG"){
        if(markPrice <= pos.liquidationPrice){
          toLiquidate.push(pos);
          // //liquidate
          // pos.status = "LIQUIDATED";
          // pos.size = 0;
          // this.balanceStore.deductLocked(pos.userId, "USD", pos.margin);
          // posMap!.delete(pos.userId);
          // // we can also remove the position from map but keeping it for record
        }
      } else {
        if(markPrice >= pos.liquidationPrice){
          toLiquidate.push(pos);
          // //liquidate
          // pos.status = "LIQUIDATED";
          // pos.size = 0;
          // this.balanceStore.deductLocked(pos.userId, "USD", pos.margin);
          // // we can also remove the position from map but keeping it for record
        }
      }
    }
    for(const pos of toLiquidate){
      pos.status = "LIQUIDATED";
      pos.size = 0;
      this.balanceStore.deductLocked(pos.userId, "USD", pos.margin);
      pos.margin=0;
      posMap!.delete(pos.userId);
    } 
  }

  private checksForCreateOrder(
    input: Omit<
      PerpsOrder,
      | "orderId"
      | "filledQuantity"
      | "fills"
      | "status"
      | "timestamp"
      | "avgPrice"
    >,
  ): void {
    // check if market is valid
    // TODO: switch MARKETS to a Set for O(1) lookup — currently O(n) per validation call
    if (!PerpsExchangeStore.PERPS_MARKETS.includes(input.market)) {
      throw new Error("invalid market");
    }
    if (input.leverage <= 0) {
      throw new Error("leverage should be greater than 0");
    }
    if (input.quantity <= 0) {
      throw new Error("quantity should be greater than 0");
    }
    if (input.price <= 0) {
      throw new Error("price should be greater than 0");
    }
    if(input.side !== "buy" && input.side !== "sell"){
      throw new Error("side should be either buy or sell");
    }
    if(input.orderType !== "limit" && input.orderType !== "market"){
      throw new Error("order type should be either limit or market");
    }
  }
  createPerpsOrder(
    input: Omit<
      PerpsOrder,
      | "orderId"
      | "filledQuantity"
      | "fills"
      | "status"
      | "timestamp"
      | "avgPrice"
    >,
  ): unknown {
    this.checksForCreateOrder(input);
    const base = input.market.split("_")[0]!;
    const quote = input.market.split("_")[1]!;
    const requiredMargin = (input.price * input.quantity) / input.leverage;
    // Check user has enough available (unlocked) asset  in balance
    const userCurrBal = this.balanceStore.getBalance(input.userId).get(quote);
    if (!userCurrBal || userCurrBal < requiredMargin) {
      throw new Error("not enough balance to place order");
    }
    let orderId = randomUUID();
    while (this.perpsOrders.has(orderId)) {
      orderId = randomUUID();
    }
    const order: PerpsOrder = {
      orderId,
      filledQuantity: 0,
      fills: [],
      status: "OPEN",
      timestamp: Date.now(),
      avgPrice: 0,
      ...input,
    };
    this.balanceStore.lock(
      input.userId,
      input.market.split("_")[1]!,
      requiredMargin,
    );
    this.perpsOrders.set(orderId, order);
    const oppositeSide = input.side === "buy" ? "asks" : "bids";
    const ob = this.perpsOrderBooks.get(input.market) || { bids: [], asks: [] };
    const toIterate = ob[oppositeSide];
    let matched = true;
    while (toIterate.length > 0 && order.filledQuantity < order.quantity && matched) {
      const bestOppositeOrder = toIterate[0]!;
      matched =
        input.side === "buy"
          ? order.price >= bestOppositeOrder.price
          : order.price <= bestOppositeOrder.price;
      // Matching condition: buy price >= ask price (or sell price <= bid price)
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
        // {open/update the position , called per fill for each user}
        //update avg price
        order.avgPrice =
          (order.avgPrice * (order.filledQuantity - fillQty) +
            fillPrice * fillQty) /
          order.filledQuantity;
        bestOppositeOrder.avgPrice =
          (bestOppositeOrder.avgPrice *
            (bestOppositeOrder.filledQuantity - fillQty) +
            fillPrice * fillQty) /
          bestOppositeOrder.filledQuantity;
        if(input.orderType==="limit" && input.side==="buy"){
          const deltaUnlock = ((input.price - fillPrice) * fillQty) / input.leverage;
          this.balanceStore.unlock(order.userId, quote, deltaUnlock);
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
        const amountToUnlock =
          ((order.quantity - order.filledQuantity) * order.price) /
          order.leverage;
        this.balanceStore.unlock(order.userId, quote, amountToUnlock);
      } else {
        order.status = "PARTIALLY_FILLED";
        ob[input.side === "buy" ? "bids" : "asks"].push(order);
        ob[input.side === "buy" ? "bids" : "asks"].sort((a, b) => {
          if (a.price === b.price) {
            // check based on timestamp for same price orders (FIFO)
            return a.timestamp - b.timestamp;
          }
          return input.side === "buy" ? b.price - a.price : a.price - b.price;
        });
      }
    } else {
      //order.filledQuantity === 0
      if (order.orderType === "limit") {
        ob[input.side === "buy" ? "bids" : "asks"].push(order);
        ob[input.side === "buy" ? "bids" : "asks"].sort((a, b) => {
          if (a.price === b.price) {
            // check based on timestamp for same price orders (FIFO)
            return a.timestamp - b.timestamp;
          }
          return input.side === "buy" ? b.price - a.price : a.price - b.price;
        });
      } else {
        // market order with 0 fills means it didn't match with any order in the book, so we cancel it and unlock the margin
        order.status = "CANCELLED";
        this.balanceStore.unlock(order.userId, quote, requiredMargin);
      }
    }
    return order;
  }
  

  cancelPerpsOrder(_market: string, orderId: string): PerpsOrder {
    //5
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
    // unlock the margin locked for order
    
    // const pp = this.perpsPosition.get(order.market)?.get(order.userId);
    // if (!pp && order.filledQuantity > 0) {
    //   throw new Error("position not found for order");
    // } {full_close or flip case then pp will be null, pp never used afterward}
    
    //compute the unfilled margin back and unlock it
    const unfilledQty = order.quantity - order.filledQuantity;
    const unfilledMargin = (order.price * unfilledQty) / order.leverage;
    this.balanceStore.unlock(
      order.userId,
      order.market.split("_")[1]!,
      unfilledMargin,
    );
    return order;
  }

  getPerpsOrder(orderId: string): PerpsOrder {
    const order = this.perpsOrders.get(orderId);
    if (!order) {
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
      // atleast bids=[]
      const remainingQty = order.quantity - order.filledQuantity;

      bidLevels.set(
        order.price,
        (bidLevels.get(order.price) || 0) + remainingQty,
      );
    }
    const askLevels = new Map<number, number>();
    for (const order of m?.asks!) {
      // atleast bids=[]
      const remainingQty = order.quantity - order.filledQuantity;

      askLevels.set(
        order.price,
        (askLevels.get(order.price) || 0) + remainingQty,
      );
    }
    const finalBids = Array.from(bidLevels.entries()).map(([price, count]) => ({
      price,
      count,
    }));
    const finalAsks = Array.from(askLevels.entries()).map(([price, count]) => ({
      price,
      count,
    }));
    const ans = { bids: finalBids, asks: finalAsks };
    return ans;
  }
  //   getPosition(userId, market) — a user's open position in a specific market
  getPosition(userId: string, market: string) {
    if (!PerpsExchangeStore.PERPS_MARKETS.includes(market)) {
      throw new Error("invalid perps market");
    }
    const m = this.perpsPosition.get(market);
    const position = m?.get(userId);
    if (!position || position.status !== "OPEN") {
      throw new Error(
        `no position found in market ${market} for user ${userId}`,
      );
    }
    return position;
  }
  // getUserPositions(userId) — all positions across all perps markets for a user
  getUserPosition(userId: string) {
    let positions: PerpsPosition[] = [];
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
    
    const m= this.balanceStore.getUserBalance(userId);
    return m;
  
  }
}

export const perpsExchangeStore = new PerpsExchangeStore(balanceStore);
