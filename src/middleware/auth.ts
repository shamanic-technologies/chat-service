import type { Request, Response, NextFunction } from "express";

export interface WorkflowTrackingHeaders {
  campaignId?: string;
  brandId?: string;
  workflowName?: string;
  featureSlug?: string;
}

export interface AuthLocals {
  orgId: string;
  userId: string;
  runId: string;
  workflowTracking: WorkflowTrackingHeaders;
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

  const runId = req.headers["x-run-id"];
  if (!runId || typeof runId !== "string") {
    res.status(400).json({ error: "x-run-id header is required" });
    return;
  }

  res.locals.orgId = orgId;
  res.locals.userId = userId;
  res.locals.runId = runId;
  res.locals.workflowTracking = extractWorkflowTracking(req);
  next();
}

function extractWorkflowTracking(req: Request): WorkflowTrackingHeaders {
  const tracking: WorkflowTrackingHeaders = {};
  const campaignId = req.headers["x-campaign-id"];
  if (typeof campaignId === "string") tracking.campaignId = campaignId;
  const brandId = req.headers["x-brand-id"];
  if (typeof brandId === "string") tracking.brandId = brandId;
  const workflowName = req.headers["x-workflow-name"];
  if (typeof workflowName === "string") tracking.workflowName = workflowName;
  const featureSlug = req.headers["x-feature-slug"];
  if (typeof featureSlug === "string") tracking.featureSlug = featureSlug;
  return tracking;
}

export function requireInternalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || typeof apiKey !== "string") {
    res.status(401).json({ error: "x-api-key header is required" });
    return;
  }
  next();
}
