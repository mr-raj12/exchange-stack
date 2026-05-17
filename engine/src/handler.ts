import type { EngineRequest } from "./types/messages";
import { exchangeStore } from "./store/exchange-store";



export function handleEngineRequest(request: EngineRequest): unknown {
  const data = request.data as any; // todo(student): improve typing here
  switch (request.type) {
    case "create_order":
      //placeholder - real matching is the assignment.
        // userId: string;
        // market: string;
        // side: Side;
        // price: number;
        // orderType: OrderType;
      return exchangeStore.createOrder(data);
    case "cancel_order":
      return exchangeStore.cancelOrder(data.market, data.orderId);
    case "get_order":
      return exchangeStore.getOrder(data.orderId);
    case "get_depth":
      return exchangeStore.getDepth(data.market);
    case "get_user_balance":
      return exchangeStore.getUserBalance(data.userId);
    case "deposit":
      return exchangeStore.deposit(data.userId, data.asset, data.amount);
    default: {
      const exhaustive: never = request.type;
      throw new Error(`unknown request type: ${exhaustive}`);
    }
  }
}
