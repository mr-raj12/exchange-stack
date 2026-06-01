import type { Request,Response } from "express";
import { sendToEngine } from "../utils/broker.js";
import { cancelOrderSchema, createOrderSchema } from "../types/order-schema.js";
import { sendValidationError } from "../utils/validation.js";

export async function createOrder(req:Request, res:Response):Promise<void> {
    const parsed = createOrderSchema.safeParse(req.body);
    if(!parsed.success){
        sendValidationError(res,parsed.error);
        return;
    }
    try{
        const result = await sendToEngine("create_order",{
            userId: req.userId,
            ...parsed.data // spread operator (Take all properties inside parsed.data and copy them here)
        }, req.queue);
        res.status(200).json(result);
    } catch (err) {
        res.status(502).json({error:(err as Error).message});
    }
}

export async function cancelOrder(req:Request,res:Response):Promise<void> {
    const parsed = cancelOrderSchema.safeParse(req.body);
    if(!parsed.success){
        sendValidationError(res,parsed.error);
        return;
    }
    try{
        const result = await sendToEngine("cancel_order",{
            userId: req.userId,
            ...parsed.data // spread operator (Take all properties inside parsed.data and copy them here)
        }, req.queue);
        res.status(200).json(result);
    } catch (err) {
        res.status(502).json({error:(err as Error).message});
    }
}

export async function getOrder(req:Request, res:Response):Promise<void> {
    const {id} = req.params;
    if(!id){
        res.status(400).json({error:"orderId required"});
        return;
    }
    try {
        const result= await sendToEngine("get_order",{
            userId: req.userId,
            orderId: id,
        }, req.queue)
        res.status(200).json(result);
    } catch (err) {
        res.status(502).json({error:(err as Error).message});
    }
}


// every controller follows
// VALIDATE->DISPATCH->RESPOND