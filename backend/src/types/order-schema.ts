import {z} from "zod";

export const createOrderSchema = z.object({
    market: z.string().min(1),
    side: z.enum(["buy","sell"]),
    price: z.number().positive(),
    quantity: z.number().positive(),
    orderType: z.enum(["limit","market"]).default("limit"),
    leverage: z.number().positive().max(125).optional().default(1),
    reduceOnly: z.boolean().optional().default(false),
});

export const cancelOrderSchema = z.object({
    market: z.string().min(1),
    orderId: z.string().min(1),
});

export type createOrderSchema = z.infer<typeof createOrderSchema>
export type cancelOrderSchema = z.infer<typeof cancelOrderSchema>


// TS types dissapear at runtime but zod schemas exists at runtime and can validate data
// Ts helps editor and compiiler only
