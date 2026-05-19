import type {
  Depth,
  Order,
  OrderBook,
  Fill,
} from "../types/exchange-store-types";
import { randomUUID } from "crypto";
import { balanceStore, BalanceStore } from "./balance-store";

class PerpsExchangeStore {
  // private balanceStore: BalanceStore
  constructor(private balanceStore: BalanceStore) {
    // this.balanceStore=balanceStore;
    this.initializePerpsOrderBooks();
  }
  private initializePerpsOrderBooks(): void {
    // a in arraay => a = index value in array
    // a of array => a = value in array
    for (const market of PerpsExchangeStore.PERPS_MARKETS) {
      // const key = market.split("_")[0]!;
      this.perpsOrderBooks.set(market, { bids: [], asks: [] });
    }
  }
  private static readonly PERPS_MARKETS = [
    "BTC_USD",
    "ETH_USD",
    "ETH_BTC",
    "BTC_SOL",
  ];
  private static readonly PERPS_ASSETS = new Set<string>(
    this.PERPS_MARKETS.flatMap((m) => m.split("_")),
  );

  private perpsOrderBooks = new Map<string, OrderBook>();
  private perpsOrders = new Map<string, Order>();

  public checkAndLiquidate(market: string, markPrice: number) {
    // in all positions of that market liquidate them
    throw new Error("check and liquidate not implmented");
  }

  createPerpsOrder(
    input: Omit<
      Order,
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

  cancelPerpsOrder(_market: string, orderId: string): Order {
    throw new Error("not implmented cancelOrder");
  }

  getPerpsOrder(orderId: string): unknown {
    throw new Error("not implmented cancelOrder");
  }

  getDepth(market: string): Depth {
    throw new Error("not implmented getDepth");
  }
  //   getPosition(userId, market) — a user's open position in a specific market
  getPosition(userId: string, market: string) {
    throw new Error("not implmented getPositions");
  }
  // getUserPositions(userId) — all positions across all perps markets for a user
  getUserPosition(userId: string) {
    throw new Error("not implmented getPositions");
  }
}



export const perpsExchangeStore = new PerpsExchangeStore(balanceStore);
