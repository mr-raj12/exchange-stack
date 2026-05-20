import type {
  Depth,
  Fill,
} from "../types/common-types";
import type { PerpsOrder, PerpsOrderBook } from "../types/perps-exchange-store-types";
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

  private perpsOrderBooks = new Map<string, PerpsOrderBook>();
  private perpsOrders = new Map<string, PerpsOrder>();

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
    throw new Error("not implmented cancelOrder");
  }

  getPerpsOrder(orderId: string): PerpsOrder {
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
  getUserBalance(userId: string): unknown {
    const m = this.balanceStore.getBalance(userId);
    // return m;  as map is not serializable(bcoz => ) we need to convert it to object
    return Object.fromEntries(m);
  }
}



export const perpsExchangeStore = new PerpsExchangeStore(balanceStore);
