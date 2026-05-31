export type EngineRequestTypes =
  | "create_order" // perps_n_spots
  | "cancel_order" // perps_n_spots
  | "get_order" // perps_n_spots
  | "get_depth" // perps_n_spots
  | "get_position" // perps_
  | "get_user_position" // perps_
  | "deposit" //spots_
  | "get_user_balance"; //spots_perps

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


export type SpotEngineRequest<T = unknown> = {
  type: EngineRequestTypes;
  data: SpotEngineRequestData;
  correlationId: string;
  responseQueue: string;
} & T
export type PerpsEngineRequest<T = unknown> = {
  type: EngineRequestTypes;
  data: PerpsEngineRequestData;
  correlationId: string;
  responseQueue: string;
} & T

// payload m queue rhta h (todo update)
export interface EngineResponse<T = unknown> {
  payload: T;
  correlationId: string;
}


//  BASES
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
export type baseGetDepthRequest<TExtra= unknown> = {
  market: string;
} & TExtra;

/// SPOTS
export type spotCreateOrderRequest = baseCreateOrderRequest;
export type spotCancelOrderRequest = baseCancelOrderRequest;
export type spotGetOrderRequest = baseGetOrderRequest;
export type spotGetDepthRequest = baseGetDepthRequest;
export type depositRequestSpotOnly = {
  userId: string;
  asset: string;
  amount: number;
};

// PERPS
export type perpsGetOrderRequest = baseGetOrderRequest;
export type perpsCreateOrderRequest = baseCreateOrderRequest<{
  leverage: number;
}>;
export type perpsCancelOrderRequest = baseCancelOrderRequest;
export type perpsGetDepthRequest = baseGetDepthRequest;
export type getPositionRequestPerpsOnly  = {
  userId: string
  market: string;
}
export type getUserPositionRequestPerpsOnly = {
  userId: string;
  // return all positinon across all markets 
}


export type getUserBalanceRequest = {
  userId: string;
};

// ordering doesnt matter of fields in interface or types
