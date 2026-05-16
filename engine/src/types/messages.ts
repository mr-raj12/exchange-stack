export type EngineRequestType =
  | "create_order"
  | "cancel_order"
  | "get_order"
  | "get_depth"
  | "get_user_balance";

export interface EngineRequest<T = unknown> {
  type: EngineRequestType;
  data: T;
  correlationId: string;
  responseQueue: string;
}

export interface EngineResponse<T = unknown> {
  payload: T;
  correlationId: string;
}

// ordering doesnt matter of fields in interface or types 
