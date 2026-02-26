import type { Request, Response, NextFunction } from "express";

export interface AuthLocals {
  orgId: string;
  userId: string;
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || typeof apiKey !== "string") {
    res.status(401).json({ error: "x-api-key header is required" });
    return;
  }

  const orgId = req.headers["x-org-id"];
  const userId = req.headers["x-user-id"];

  if (!orgId || typeof orgId !== "string") {
    res.status(400).json({ error: "x-org-id header is required" });
    return;
  }
  if (!userId || typeof userId !== "string") {
    res.status(400).json({ error: "x-user-id header is required" });
    return;
  }

  res.locals.orgId = orgId;
  res.locals.userId = userId;
  next();
}
