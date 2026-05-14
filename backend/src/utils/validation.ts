import type { Response } from "express";
import type { ZodError } from "zod";

export function sendValidationError(res:Response, error:ZodError):void { // :void means this function only sends a response , doesn't return anything
    res.status(400).json({
        error: "validation error",
        issues: error.issues.map((issue)=>({
            path: issue.path,
            message: issue.message,
        })),
    });
}

// every 400 response has same shape
//  one place to change
// error shape concern live elsewhere, controller body stays focused on happy path 
