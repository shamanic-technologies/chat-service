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
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) {
    res
      .status(401)
      .json({ error: "Authorization: Bearer <key> header required" });
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
