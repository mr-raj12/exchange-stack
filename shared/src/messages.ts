export type EngineRequestTypes =
  | "create_order"
  | "cancel_order"
  | "get_order"
  | "get_depth"
  | "get_position"
  | "get_user_position"
  | "deposit"
  | "get_user_balance";

// ── Base request shapes ─────────────────────────────────────────────────────

export type baseCreateOrderRequest<TExtra = unknown> = {
  userId: string;
  market: string;
  side: "buy" | "sell";
  price: number;
  quantity: number;
  orderType: "limit" | "market";
  reduceOnly?: boolean;
} & TExtra;

export type baseCancelOrderRequest<TExtra = unknown> = {
  market: string;
  orderId: string;
} & TExtra;

export type baseGetOrderRequest<TExtra = unknown> = {
  orderId: string;
  userId: string;
} & TExtra;

export type baseGetDepthRequest<TExtra = unknown> = {
  market: string;
} & TExtra;

// ── Spot-specific request data ──────────────────────────────────────────────

export type spotCreateOrderRequest  = baseCreateOrderRequest;
export type spotCancelOrderRequest  = baseCancelOrderRequest;
export type spotGetOrderRequest     = baseGetOrderRequest;
export type spotGetDepthRequest     = baseGetDepthRequest;
export type depositRequestSpotOnly  = {
  userId: string;
  asset: string;
  amount: number;
};

// ── Perps-specific request data ─────────────────────────────────────────────

export type perpsCreateOrderRequest         = baseCreateOrderRequest<{ leverage: number }>;
export type perpsCancelOrderRequest         = baseCancelOrderRequest;
export type perpsGetOrderRequest            = baseGetOrderRequest;
export type perpsGetDepthRequest            = baseGetDepthRequest;
export type getPositionRequestPerpsOnly     = { userId: string; market: string };
export type getUserPositionRequestPerpsOnly = { userId: string };

// ── Shared request data ─────────────────────────────────────────────────────

export type getUserBalanceRequest = { userId: string };

// ── Union data types ────────────────────────────────────────────────────────

export type SpotEngineRequestData =
  | spotCreateOrderRequest
  | spotCancelOrderRequest
  | spotGetOrderRequest
  | spotGetDepthRequest
  | getUserBalanceRequest
  | depositRequestSpotOnly;

export type PerpsEngineRequestData =
  | perpsCreateOrderRequest
  | perpsCancelOrderRequest
  | perpsGetOrderRequest
  | perpsGetDepthRequest
  | getPositionRequestPerpsOnly
  | getUserPositionRequestPerpsOnly
  | getUserBalanceRequest;

// ── Engine request envelopes ────────────────────────────────────────────────
// backendId replaces responseQueue — engine publishes response to
// backend:{backendId}:responses pub/sub channel

export type SpotEngineRequest<T = unknown> = {
  type: EngineRequestTypes;
  data: SpotEngineRequestData;
  correlationId: string;
  backendId: string;
} & T;

export type PerpsEngineRequest<T = unknown> = {
  type: EngineRequestTypes;
  data: PerpsEngineRequestData;
  correlationId: string;
  backendId: string;
} & T;

// ── Engine response envelope ────────────────────────────────────────────────

export interface EngineResponse<T = unknown> {
  payload: T;
  correlationId: string;
}
