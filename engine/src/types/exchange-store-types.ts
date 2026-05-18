export type Side = "buy" | "sell";
export type OrderType = "limit" | "market";

export interface DepthLevel {
  price: number;
  count: number;
}
export interface Depth {
  asks: DepthLevel[];
  bids: DepthLevel[];
}
export type OrderStatus = "OPEN" | "CANCELLED" | "FILLED" | "PARTIALLY_FILLED" | "PARTIALLY_CANCELLED";
export interface Order {
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
}
export type Fill = {
  price: number;
  quantity: number;
  timestamp: number;
  makerOrderId: string;
  takerOrderId: string;
};

export interface OrderBook {
  // bids sorted by price high -> low (best buyer first)
  bids: Order[];
  // bids sorted by price low ->  high (best seller first)
  asks: Order[];
}