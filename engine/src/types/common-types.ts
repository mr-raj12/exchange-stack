export type Side = "buy"| "sell";
export type OrderType = "limit" | "market"
export type OrderStatus = "OPEN" | "CANCELLED" | "FILLED" | "PARTIALLY_FILLED" | "PARTIALLY_CANCELLED";

export type Fill = {
    makerOrderId: string;
    takerOrderId: string;
    price: number;
    quantity: number;
    timestamp: number;
}

export type DepthLevel = {
    price: number;
    count: number;
}
export type Depth = {
    asks: DepthLevel[]
    bids: DepthLevel[]
}