export interface FillEvent {
  type: "fill";
  orderId: string;
  userId: string;
  market: string;
  side: "buy" | "sell";
  price: number;
  quantity: number;
  fee: number;
  timestamp: number;
}

export interface OrderUpdateEvent {
  type: "order_update";
  orderId: string;
  userId: string;
  market: string;
  status: "open" | "filled" | "cancelled" | "partially_filled";
  filledQuantity: number;
  remainingQuantity: number;
}

export interface PositionUpdateEvent {
  type: "position_update";
  userId: string;
  market: string;
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  liquidationPrice: number;
  unrealizedPnl: number;
  margin: number;
  leverage: number;
}

export interface LiquidationEvent {
  type: "liquidation";
  userId: string;
  market: string;
  side: "long" | "short";
  markPrice: number;
  liquidationPrice: number;
  marginLost: number;
}

export interface OrderbookSnapshotEvent {
  type: "orderbook_snapshot";
  market: string;
  bids: [string, string][];
  asks: [string, string][];
  timestamp: number;
}

export interface MarkPriceEvent {
  type: "mark_price";
  market: string;
  price: number;
  timestamp: number;
}

export interface FundingSettlementTrigger {
  type: "funding_settlement";
  market: string;
  timestamp: number;
}

export type UserEvent   = FillEvent | OrderUpdateEvent | PositionUpdateEvent | LiquidationEvent;
export type MarketEvent = OrderbookSnapshotEvent | MarkPriceEvent;
