export type EngineRequestType = // union of string literals, type m union hota h  intereface  m nhi
  | "create_order"
  | "cancel_order"
  | "get_order"
  | "get_depth"
  | "get_user_balance";

// interface supports merging, types cant 
// types support intersection
// < > is called generics, both type and interface can use this
export interface EngineRequest<T = unknown> {
  // T = generic
  type: EngineRequest;
  data: T;
  correlationId: string;
  responseQueue: string;
}

export interface EngineResponse<T = unknown> {
  correlationId: string;
  payload: T;
}
