import type { EngineRequest } from "./types/messages";

export function handleEngineRequest(request: EngineRequest): unknown {
  switch (request.type) {
    case "create_order":
      //placeholder - real matching is the assignment.
      return {
        orderId: "stub-order-id",
        status: "accepted",
        fills: [],
      };
    case "cancel_order":
    case "get_order":
    case "get_depth":
    case "get_user_balance":
      throw new Error(`handler not implemented for type: ${request.type}`);

    default: {
      const exhaustive: never = request.type;
      throw new Error(`unknown request type: ${exhaustive}`);
    }
  }
}
