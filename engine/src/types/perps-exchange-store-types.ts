import type { Side, OrderType, OrderStatus, Depth, Fill } from "./common-types";

export interface PerpsOrder {
  orderId: string;
  userId: string;
  market: string;
  side: Side;
  price: number;
  filledQuantity: number;
  quantity: number;
  orderType: OrderType;
  status: OrderStatus;
  fills: Fill[];
  timestamp: number;
  avgPrice: number;
  leverage: number;
}

export interface PerpsOrderBook {
  // bids sorted by price high -> low (best buyer first)
  bids: PerpsOrder[];
  // bids sorted by price low ->  high (best seller first)
  asks: PerpsOrder[];
}

// userId → market → Position

export interface PerpsPosition {
  positionId: string;
  userId: string;
  market: string;
  side: PositionSide;
  size: number; // remaining unit (>=0)
  leverage: number;
  entryPrice: number;
  margin: number; // how much collateral is locked for this position
  liquidationPrice: number;
  status: "OPEN" | "CLOSED" | "LIQUIDATED"; // ADL also in future
  timestamp: number;
}
export type PositionSide = "LONG" | "SHORT";
// financial state of the posiition, not orderbook actions
// LONG = you benefit if price rises,
//  SHORT = you benefit if price falls.
//  Buy/sell is how you enter, long/short is what you hold.
