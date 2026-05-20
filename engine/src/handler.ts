import type {
  SpotEngineRequest,
  PerpsEngineRequest,
  getUserBalanceRequest,
  spotCreateOrderRequest,
  spotCancelOrderRequest,
  spotGetOrderRequest,
  spotGetDepthRequest,
  depositRequestSpotOnly,
  perpsCreateOrderRequest,
  perpsCancelOrderRequest,
  perpsGetOrderRequest,
  perpsGetDepthRequest,
  getPositionRequestPerpsOnly,
  getUserPositionRequestPerpsOnly,
} from "./types/messages";
import { spotExchangeStore } from "./store/spot-exchange-store";
import { perpsExchangeStore } from "./store/perps-exchange-store";

export function handleEngineRequestForSpot(
  request: SpotEngineRequest,
): unknown {
  switch (request.type) {
    case "create_order": {
      const data = request.data as spotCreateOrderRequest; // type assertion for create order request
      return spotExchangeStore.createOrder(data);
    }
    case "cancel_order": {
      const data = request.data as spotCancelOrderRequest; // type assertion for cancel order request
      return spotExchangeStore.cancelOrder(data.market, data.orderId);
    }
    case "get_order": {
      const data = request.data as spotGetOrderRequest; // type assertion for get order request
      return spotExchangeStore.getOrder(data.orderId);
    }
    case "get_depth": {
      const data = request.data as spotGetDepthRequest; // type assertion for get depth request
      return spotExchangeStore.getDepth(data.market);
    }
    case "get_user_balance": {
      const data = request.data as getUserBalanceRequest; // type assertion for get user balance request
      return spotExchangeStore.getUserBalance(data.userId);
    }
    case "deposit": {
      const data = request.data as depositRequestSpotOnly; // type assertion for deposit request
      return spotExchangeStore.deposit(data.userId, data.asset, data.amount);
    }
    default: {
      const exhaustive: never | "get_position" | "get_user_position" = request.type;
      throw new Error(`unknown request type: ${exhaustive}`);
    }
  }
}
export function handleEngineRequestForPerps(
  request: PerpsEngineRequest,
): unknown {
  switch (request.type) {
    case "create_order": {
      const data = request.data as perpsCreateOrderRequest; // type assertion for create order request
      return perpsExchangeStore.createPerpsOrder(data);
    }
    case "cancel_order": {
      const data = request.data as perpsCancelOrderRequest; // type assertion for cancel order request
      return perpsExchangeStore.cancelPerpsOrder(data.market, data.orderId);
    }
    case "get_order": {
      const data = request.data as perpsGetOrderRequest; // type assertion for get order request
      return perpsExchangeStore.getPerpsOrder(data.orderId);
    }
    case "get_depth": {
      const data = request.data as perpsGetDepthRequest; // type assertion for get depth request
      return perpsExchangeStore.getDepth(data.market);
    }
    case "get_user_balance": {
      const data = request.data as getUserBalanceRequest; // type assertion for get user balance request
      return perpsExchangeStore.getUserBalance(data.userId);
    }
    case "get_position":{
      const data = request.data as getPositionRequestPerpsOnly
      return perpsExchangeStore.getPosition(data.userId, data.market)
    }
    case "get_user_position":{
      const data = request.data as getUserPositionRequestPerpsOnly
      return perpsExchangeStore.getUserPosition(data.userId)
    }
    default: {
      const exhaustive: never | "deposit" = request.type;
      throw new Error(`unknown request type: ${exhaustive}`);
    }
  }
}
