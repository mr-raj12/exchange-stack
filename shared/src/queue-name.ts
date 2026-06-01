export const WAL_STREAM             = "wal_stream";
export const SPOT_INCOMING_STREAM   = "SPOT_incoming_stream";
export const PERPS_INCOMING_STREAM  = "PERPS_incoming_stream";
export const MARK_PRICE_STREAM      = "mark_price_stream";
export const FUNDING_RATE_STREAM    = "funding_rate_stream";
export const ENGINE_CONSUMER_GROUP  = "engine-group";
export const ENGINE_CONSUMER_NAME   = "engine-consumer-1";

// Per-backend response channel (pub/sub)
export const backendResponseChannel = (backendId: string) =>
  `backend:${backendId}:responses`;

// Per-user event channel (pub/sub)
export const userEventsChannel = (userId: string) =>
  `user:${userId}:events`;

// Per-market orderbook channel (pub/sub)
export const orderbookChannel = (market: string) =>
  `market:${market}:orderbook`;