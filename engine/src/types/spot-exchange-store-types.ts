import type {Side,OrderType,OrderStatus,Depth,Fill} from "./common-types"

export interface SpotOrder {
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


export interface SpotOrderBook {
  // bids sorted by price high -> low (best buyer first)
  bids: SpotOrder[];
  // bids sorted by price low ->  high (best seller first)
  asks: SpotOrder[];
}