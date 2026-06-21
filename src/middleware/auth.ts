import type { Request, Response, NextFunction } from "express";

export interface WorkflowTrackingHeaders {
  campaignId?: string;
  brandId?: string;
  workflowSlug?: string;
  featureSlug?: string;
  /**
   * Priority audience chosen by campaign-service at the start of a campaign run.
   * Propagated through the whole service chain for per-audience cost attribution.
   * Optional — absent outside the campaign flow; omit, never throw.
   */
  audienceId?: string;
}

/**
 * Build the downstream tracking-header map from the inbound tracking block —
 * allowlist-driven, NOT field-by-field at each call site. Adding a new tracking
 * header here propagates it to every internal call (runs-service, key-service,
 * trace events) at once. Only forward this to INTERNAL services — never to a
 * third-party vendor (Anthropic/Gemini/etc.); the provider clients build their
 * own vendor headers and must stay free of these keys.
 */
export function buildTrackingHeaders(
  tracking: WorkflowTrackingHeaders,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (tracking.campaignId) headers["x-campaign-id"] = tracking.campaignId;
  if (tracking.brandId) headers["x-brand-id"] = tracking.brandId;
  if (tracking.workflowSlug) headers["x-workflow-slug"] = tracking.workflowSlug;
  if (tracking.featureSlug) headers["x-feature-slug"] = tracking.featureSlug;
  if (tracking.audienceId) headers["x-audience-id"] = tracking.audienceId;
  return headers;
}

export interface AuthLocals {
  orgId: string;
  userId: string;
  parentRunId: string;
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

  const parentRunId = req.headers["x-run-id"];
  if (!parentRunId || typeof parentRunId !== "string") {
    res.status(400).json({ error: "x-run-id header is required" });
    return;
  }

  res.locals.orgId = orgId;
  res.locals.userId = userId;
  res.locals.parentRunId = parentRunId;
  res.locals.workflowTracking = extractWorkflowTracking(req);
  next();
}

function extractWorkflowTracking(req: Request): WorkflowTrackingHeaders {
  const tracking: WorkflowTrackingHeaders = {};
  const campaignId = req.headers["x-campaign-id"];
  if (typeof campaignId === "string") tracking.campaignId = campaignId;
  const brandId = req.headers["x-brand-id"];
  if (typeof brandId === "string") tracking.brandId = brandId;
  const workflowSlug = req.headers["x-workflow-slug"];
  if (typeof workflowSlug === "string") tracking.workflowSlug = workflowSlug;
  const featureSlug = req.headers["x-feature-slug"];
  if (typeof featureSlug === "string") tracking.featureSlug = featureSlug;
  const audienceId = req.headers["x-audience-id"];
  if (typeof audienceId === "string") tracking.audienceId = audienceId;
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
