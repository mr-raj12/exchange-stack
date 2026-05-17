export type EngineRequestType =
  | "create_order"
  | "cancel_order"
  | "get_order"
  | "get_depth"
  | "deposit"
  | "get_user_balance";

export type EngineRequestData = createOrderRequest | cancelOrderRequest | getOrderRequest | getDepthRequest | getUserBalanceRequest | depositRequest;

export interface EngineRequest<T = unknown> {
  type: EngineRequestType;
  data: EngineRequestData;
  correlationId: string;
  responseQueue: string;
}

export interface EngineResponse<T = unknown> {
  payload: T;
  correlationId: string;
}

export type createOrderRequest = {
  userId: string;
  market: string;
  side: "buy" | "sell";
  price: number;
  quantity: number;
  orderType: "limit" | "market";
}
export type cancelOrderRequest = {
  market: string;
  orderId: string;
}
export type getOrderRequest = {
  orderId: string;
}
export type getDepthRequest = {
  market: string;
}
export type getUserBalanceRequest = {
  userId: string;
}
export type depositRequest = {
  userId: string;
  asset: string;
  amount: number;
}


// ordering doesnt matter of fields in interface or types 
