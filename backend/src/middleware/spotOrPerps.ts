import type { NextFunction, Request, Response } from "express";

export function addQueueProps(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
    if (req.path.startsWith("/spot")) {
        req.queue = "SPOT";
    } else if (req.path.startsWith("/perps")) {
        req.queue = "PERPS";
    }
    next();
}
