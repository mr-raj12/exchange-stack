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
}

export interface OrderBook {
  // bids sorted by price high -> low (best buyer first)
  bids: Order[];
  // bids sorted by price low ->  high (best seller first)
  asks: Order[];
}

class ExchangeStore {
  private orderBooks = new Map<string, OrderBook>();
  private orders = new Map<string, Order>();
  // userId->asset->amount
  private balance = new Map<string, Map<string, number>>();
//   Omit<Order, "orderId" | "filledQuantity"> means Order se ye do field hta do 
  createOrder(_input: Omit<Order, "orderId" | "filledQuantity">): unknown {
    // TODO: assign orderId, match against the book using price-time
    // priority, record fills, handle partial fills, support limit
    // vs market orders, update balances. (Student exercise.)
    throw new Error("createOrder not implemented");
  }

  cancelOrder(_market: string, _orderId: string): unknown {
    // TODO: remove the resting order from the book, refund locked balance.
    throw new Error("cancelOrder not implemented");
  }

  getOrder(_orderId: string): unknown {
    // TODO: return the order's current state (open/filled/cancelled).
    throw new Error("getOrder not implemented");
  }

  getDepth(_market: string): OrderBook {
    // TODO: return aggregated bids (high→low) and asks (low→high).
    throw new Error("getDepth not implemented");
  }

  getUserBalance(_userId: string): unknown {
    // TODO: return the user's balances across assets.
    throw new Error("getUserBalance not implemented");
  }
  deposit(_userId: string, _asset: string, _amount: number): unknown {  
    // TODO: increase the user's balance for the given asset by the given amount.
    throw new Error("deposit not implemented");
  }
}

// type aur interface dono basically “types” hi represent krta h
//  aur kisi andar ksii ko bhi declare kiya hua h usko use kr skte h
// aur :lga k type inteface union array funciton type , primitive type , custom type lga skte h

export const exchangeStore = new ExchangeStore();