import {z} from "zod";

export const createOrderSchema = z.object({
    symbol: z.string().min(1),
    side: z.enum(["buy","sell"]),
    price: z.number().positive(),
    qty: z.number().positive(),
    type: z.enum(["limit","market"]).default("limit")
});

export const cancelOrderSchema = z.object({
    market: z.string().min(1),
    orderId: z.string().min(1),
});

export type createOrderSchema = z.infer<typeof createOrderSchema>
export type cancelOrderSchema = z.infer<typeof cancelOrderSchema>


// TS types dissapear at runtime but zod schemas exists at runtime and can validate data
// Ts helps editor and compiiler only
