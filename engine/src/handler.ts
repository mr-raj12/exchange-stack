import type { cancelOrderRequest, EngineRequest, createOrderRequest, getDepthRequest, getOrderRequest, getUserBalanceRequest, depositRequest } from "./types/messages";
import { exchangeStore } from "./store/exchange-store";


export function handleEngineRequest(request: EngineRequest): unknown {
    
  switch (request.type) {
    case "create_order": {
      const data = request.data as createOrderRequest; // type assertion for create order request
      return exchangeStore.createOrder(data);
    }
    case "cancel_order": {
      const data = request.data as cancelOrderRequest; // type assertion for cancel order request
      return exchangeStore.cancelOrder(data.market, data.orderId);
    }
    case "get_order": {
      const data = request.data as getOrderRequest; // type assertion for get order request
      return exchangeStore.getOrder(data.orderId);
    }
    case "get_depth": {
      const data = request.data as getDepthRequest; // type assertion for get depth request
      return exchangeStore.getDepth(data.market);
    }
    case "get_user_balance": {
      const data = request.data as getUserBalanceRequest; // type assertion for get user balance request
      return exchangeStore.getUserBalance(data.userId);
    }
    case "deposit": {
      const data = request.data as depositRequest; // type assertion for deposit request
      return exchangeStore.deposit(data.userId, data.asset, data.amount);
    }
    default: {
      const exhaustive: never = request.type;
      throw new Error(`unknown request type: ${exhaustive}`);
    }
  }
}
