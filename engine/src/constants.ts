export const INSURANCE_FUND_USER_ID  = "SYSTEM_INSURANCE_FUND";
// Virtual userId for liquidation orders — placed on behalf of the liquidated user
// but tagged so downstream code (DB queries, logs) can identify them as system orders.
// NOTE: the current impl places orders under the actual userId (for position tracking)
// and sets isLiquidation=true on the order; this constant is retained for logging/reference.
export const LIQUIDATION_BOT_USER_ID = "SYSTEM_LIQUIDATION_BOT";
