export type WalEventType =
  | "order_created"
  | "order_fill"
  | "order_cancelled"
  | "position_state"
  | "balance_snapshot"
  | "liquidation_triggered"
  | "funding_settled";

export interface WalEntry {
  type: WalEventType;
  exchange?: "SPOT" | "PERPS";
  market?: string;
  userId?: string;
  data: unknown;
  timestamp: number;
}
