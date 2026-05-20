import type { Depth, Fill } from "../types/common-types";
import type {
  SpotOrder,
  SpotOrderBook,
} from "../types/spot-exchange-store-types";
import { randomUUID } from "crypto";
import { balanceStore, BalanceStore } from "./balance-store";

class SpotExchangeStore {
  // private balanceStore:BalanceStore
  constructor(private balanceStore: BalanceStore) {
    // this.balanceStore=balanceStore
    this.initializeSpotOrderBooks();
  }
  private static readonly SPOT_MARKETS = [
    "BTC_USD",
    "ETH_USD",
    // "ETH_BTC",
    // "BTC_SOL",
  ];
  private static readonly SPOT_ASSETS = new Set<string>(
    this.SPOT_MARKETS.flatMap((m) => m.split("_")),
  );

  private spotOrderBooks = new Map<string, SpotOrderBook>();
  private spotOrders = new Map<string, SpotOrder>();
  // userId->asset->amount
  private initializeSpotOrderBooks() {
    // a in arraay => a = index value in array
    // a of array => a = value in array
    for (const market of SpotExchangeStore.SPOT_MARKETS) {
      const key = market.split("_")[0]!;
      this.spotOrderBooks.set(key, { bids: [], asks: [] });
    }
  }

  //   Omit<Order, "orderId" | "filledQuantity"> means Order se ye do field hta do
  private checksForCreateOrder(
    input: Omit<
      SpotOrder,
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
    if (!SpotExchangeStore.SPOT_MARKETS.includes(input.market)) {
      throw new Error("invalid market");
    }
    // check if side is valid
    if (input.side !== "buy" && input.side !== "sell") {
      throw new Error("invalid side");
    }
    if (input.orderType !== "limit" && input.orderType !== "market") {
      throw new Error("invalid order type");
    }
    // check if quantity are positive
    if (input.quantity <= 0) {
      throw new Error("quantity must be positive");
    }
    // check if price is positive for limit order
    if (input.orderType === "limit" && input.price <= 0) {
      throw new Error("price must be positive for limit order");
    }
  }
  createOrder(
    input: Omit<
      SpotOrder,
      | "orderId"
      | "filledQuantity"
      | "fills"
      | "status"
      | "timestamp"
      | "avgPrice"
    >,
  ): unknown {
    this.checksForCreateOrder(input);
    // assign orderId, match against the book using price-time
    // enough balance
    const quote = input.market.split("_")[1]!;
    const base = input.market.split("_")[0]!;
    const asset = input.side === "buy" ? quote : base;
    let amountToLock: number;
    if (input.side === "buy") {
      if (input.orderType === "limit") {
        const totalCost = input.price * input.quantity;
        // this.lock(input.userId, quote, totalCost);
        amountToLock = totalCost;
      } else {
        // but abhi k liye pura balance lock kr dete h, market order k liye hm assume kr lete h ki price limit order k price se jyada nhi jayega
        const currentBalance =
          this.balanceStore.getBalance(input.userId)?.get(quote) || 0;
        // this.lock(input.userId, quote, currentBalance);
        amountToLock = currentBalance;
        if (amountToLock <= 0) {
          throw new Error("insufficient quote balance for market buy");
        }
      }
    } else {
      amountToLock = input.quantity;
      // for sell order we need to lock the base
      // if(input.orderType==="limit"){
      // this.lock(input.userId, base, input.quantity);
      // amountToLock = input.quantity;
      // } else {
      // market order m sell h
      // this.lock(input.userId, base, input.quantity);
      // amountToLock = input.quantity;
    }

    let orderId = randomUUID();
    while (this.spotOrderBooks.has(orderId)) {
      orderId = randomUUID();
    }
    const order: SpotOrder = {
      orderId,
      filledQuantity: 0,
      ...input,
      status: "OPEN",
      fills: [],
      timestamp: Date.now(),
      avgPrice: 0,
    };
    this.balanceStore.lock(input.userId, asset, amountToLock);
    this.spotOrders.set(orderId, order);
    const oppositeSide = input.side === "buy" ? "asks" : "bids";
    const ob = this.spotOrderBooks.get(input.market) || { bids: [], asks: [] };
    const toIterate = ob[oppositeSide];
    while (order.filledQuantity < order.quantity && toIterate.length > 0) {
      // priority, record fills, handle partial fills, support limit
      const bestOrder = toIterate[0] as SpotOrder;

      if (input.orderType === "limit") {
        if (input.side === "buy" && bestOrder!.price > input.price) {
          break;
        }
        if (input.side === "sell" && bestOrder!.price < input.price) {
          break;
        }
      }
      const remainingQtyBuyable = bestOrder.quantity - bestOrder.filledQuantity;

      const qtyToFill = Math.min(
        remainingQtyBuyable,
        input.quantity - order.filledQuantity,
      );
      const fillPrice = bestOrder.price;
      const fill: Fill = {
        price: fillPrice,
        quantity: qtyToFill,
        timestamp: Date.now(),
        makerOrderId: bestOrder.orderId,
        takerOrderId: order.orderId,
      };
      order.fills.push(fill);
      order.filledQuantity += qtyToFill;
      bestOrder.filledQuantity += qtyToFill;
      bestOrder.fills.push(fill);
      // dono user ka balance and locked update kro
      const makerUserId = bestOrder.userId;
      const takerUserId = order.userId;
      order.avgPrice =
        (order.avgPrice * (order.filledQuantity - fill.quantity) +
          fillPrice * fill.quantity) /
        order.filledQuantity;
      bestOrder.avgPrice =
        (bestOrder.avgPrice * (bestOrder.filledQuantity - fill.quantity) +
          fillPrice * fill.quantity) /
        bestOrder.filledQuantity;
      if (input.side === "buy") {
        // buyer is taker and seller is maker
        // buyer k liye quote ka amount ghatana h and base ka amount badhana h
        this.balanceStore.deductLocked(
          takerUserId,
          quote,
          fillPrice * fill.quantity,
        );
        this.balanceStore.credit(takerUserId, base, fill.quantity);
        this.balanceStore.deductLocked(makerUserId, base, fill.quantity);
        this.balanceStore.credit(makerUserId, quote, fillPrice * fill.quantity);
      } else {
        // seller is taker and buyer is maker
        this.balanceStore.deductLocked(takerUserId, base, fill.quantity);
        this.balanceStore.credit(takerUserId, quote, fillPrice * fill.quantity);
        this.balanceStore.deductLocked(
          makerUserId,
          quote,
          fillPrice * fill.quantity,
        );
        this.balanceStore.credit(makerUserId, base, fill.quantity);
      }
      if (input.orderType === "limit") {
        // unlock the delta of price-fill.price for filled quantity
        if (input.side === "buy") {
          const deltaToUnlock = (input.price - fillPrice) * fill.quantity;
          this.balanceStore.unlock(takerUserId, quote, deltaToUnlock);
        }
        // else m let say 10$ p 10qty bechna h to 10 ya 10 se upar m he bikega to kya delta isme
      }
      if (bestOrder.filledQuantity === bestOrder.quantity) {
        // >= defensive programming
        bestOrder.status = "FILLED";
        // ab delete kro isko orderbook se;
        toIterate.shift();
      } else {
        bestOrder.status = "PARTIALLY_FILLED";
      }
      if (order.filledQuantity === order.quantity) {
        order.status = "FILLED";
      } else if (order.filledQuantity > 0) {
        order.status = "PARTIALLY_FILLED";
      }
    }

    if (order.orderType === "market" && order.side === "buy") {
      const amountToUnlock =
        amountToLock -
        order.fills.reduce((acc, fill) => acc + fill.price * fill.quantity, 0);
      if (amountToUnlock > 0) {
        this.balanceStore.unlock(order.userId, quote, amountToUnlock);
      }
    }

    if (order.filledQuantity < order.quantity) {
      if (order.orderType === "market") {
        order.status = "PARTIALLY_CANCELLED";
        if (order.filledQuantity === 0) {
          order.status = "CANCELLED";
        }
        if (order.side === "sell") {
          this.balanceStore.unlock(
            order.userId,
            base,
            order.quantity - order.filledQuantity,
          );
        }
        return order;
      }
      // type to limit he hoga
      const sameSide = input.side === "buy" ? "bids" : "asks";
      ob[sameSide].push(order);
      // price time priority maintain krne k liye sort krna pdega
      // TODO: replace push+sort (O(n log n)) with an O(n) insertion walk to the correct price-time position
      ob[sameSide].sort((a, b) => {
        if (a.price === b.price) {
          return a.timestamp - b.timestamp; // earlier order gets priority
        }
        return input.side === "buy" ? b.price - a.price : a.price - b.price; // buy m higher price priority, sell m lower price priority
      });
    }
    return order;
  }

  cancelOrder(_market: string, orderId: string): SpotOrder {
    // HM AMOUNT , COUNT NHI STORE KR RHE H
    // userID, amount, price
    // 1213, 0.5, 30000

    // DO: remove the resting order from the book
    const order = this.spotOrders.get(orderId);
    if (!order) {
      throw new Error("order not found");
    }
    if (
      order.status === "FILLED" ||
      order.status === "CANCELLED" ||
      order.status === "PARTIALLY_CANCELLED"
    ) {
      throw new Error(`order cannot be cancelled (status: ${order.status})`);
    }
    // orderbook k bids m price and count hoga
    const side = order.side;
    const inOrderBookSide = side === "buy" ? "bids" : "asks";
    const ob = this.spotOrderBooks.get(order.market);
    if (!ob) {
      throw new Error("market not found");
    }
    const orders = ob[inOrderBookSide];
    const index = orders.findIndex((o) => o.orderId === orderId);
    if (index === -1) {
      throw new Error("order not found in order book");
    }
    orders.splice(index, 1);
    if (order.filledQuantity === 0) {
      order.status = "CANCELLED";
    } else {
      order.status = "PARTIALLY_CANCELLED";
    }
    // DO: refund locked balance.
    if (side === "buy") {
      const quote = order.market.split("_")[1]!;
      const amountToUnlock =
        (order.quantity - order.filledQuantity) * order.price;
      this.balanceStore.unlock(order.userId, quote, amountToUnlock);
    } else {
      // for sell order we have locked the asset which we need to refund
      const base = order.market.split("_")[0]!;
      const amountToUnlock = order.quantity - order.filledQuantity;
      this.balanceStore.unlock(order.userId, base, amountToUnlock);
    }
    return order;
  }

  getOrder(orderId: string): SpotOrder {
    const m = this.spotOrders.get(orderId);
    if (!m) {
      throw new Error("order not found");
    }
    return m;
  }

  getDepth(market: string): Depth {
    // ISME AGGREGATE KR RHE H AND THIS WILL BE accessed very more number of times compared to createOrder and cancelOrder(which will affect this)
    // so this can be optimized by storing aggregated order book and updating it on every createOrder and cancelOrder
    if (!SpotExchangeStore.SPOT_MARKETS.includes(market)) {
      throw new Error("invalid market");
    }
    const m = this.spotOrderBooks.get(market);
    if (!m) {
      throw new Error("market not found");
    }
    // bids are sorted based on price-time priority,
    // in bids we store order so we have in bids multipple same prices (sorted)
    // we needd to return price,count_remaining for each price level, so we need to convert order to price level

    const bidLevels = new Map<number, number>();
    for (const order of m.bids) {
      const remainingQty = order.quantity - order.filledQuantity;
      bidLevels.set(
        order.price,
        (bidLevels.get(order.price) || 0) + remainingQty,
      );
    }

    const askLevels = new Map<number, number>();
    for (const order of m.asks) {
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

  getUserBalance(userId: string): unknown {
    const m = this.balanceStore.getBalance(userId);
    // return m;  as map is not serializable(bcoz => ) we need to convert it to object
    return Object.fromEntries(m);
  }
  deposit(userId: string, asset: string, amount: number): unknown {
    if (!SpotExchangeStore.SPOT_ASSETS.has(asset)) {
      throw new Error("invalid asset");
    }
    // const currentBalance =this.balanceStore.getBalance(userId);
    // balanceStore.getBalance(userId) || new Map<string, number>();
    // currentBalance.set(asset, (currentBalance.get(asset) || 0) + amount);
    // this.balance.set(userId, currentBalance);
    this.balanceStore.credit(userId, asset, amount);
    return this.getUserBalance(userId);
  }
}

// type aur interface dono basically “types” hi represent krta h
//  aur kisi andar ksii ko bhi declare kiya hua h usko use kr skte h
// aur :lga k type inteface union array funciton type , primitive type , custom type lga skte h

export const spotExchangeStore = new SpotExchangeStore(balanceStore);
