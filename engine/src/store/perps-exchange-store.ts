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

  public checkAndLiquidate(market: string, markPrice: number) {
    // in all positions of that market liquidate them
    throw new Error("check and liquidate not implmented");
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
    throw new Error("not implmented createOrder");
  }

  cancelPerpsOrder(_market: string, orderId: string): PerpsOrder {
    //5
    const order = this.perpsOrders.get(orderId);
    if(!order){
      throw new Error("order not found!");
    }
    if (order.status === "FILLED" ||order.status === "CANCELLED" ||order.status === "PARTIALLY_CANCELLED"){
      throw new Error(`order cannot be cancelled (status: ${order.status})`);
    }
    const side = order.side;
    const ob = this.perpsOrderBooks.get(order.market);
    const inOrderBookSideArray = side==="buy"? ob?.bids : ob?.asks;
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
    const pp=this.perpsPosition.get(order.market)?.get(order.userId);
    if(!pp && order.filledQuantity>0){
      throw new Error("position not found for order");
    }
    //compute the unfilled margin back and unlock it
    const unfilledQty = order.quantity - order.filledQuantity;
    const unfilledMargin = (order.price * unfilledQty)/order.leverage;
    this.balanceStore.unlock(order.userId, order.market.split("_")[1]!, unfilledMargin);
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
  getUserBalance(userId: string): unknown {
    const m = this.balanceStore.getBalance(userId);
    // return m;  as map is not serializable(bcoz => ) we need to convert it to object
    return Object.fromEntries(m);
  }
}

export const perpsExchangeStore = new PerpsExchangeStore(balanceStore);
