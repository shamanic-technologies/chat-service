import type { Request, Response, NextFunction } from "express";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The caller's `x-api-key` MUST equal this service's own `CHAT_SERVICE_API_KEY`
 * (SEC-CHAT-IDENTITY-1120). chat-service trusts `x-org-id` / `x-user-id` as the
 * caller's identity, so ONLY a holder of the service key may state them. Until
 * 2026-11-20 both middlewares checked the header was PRESENT, never its value,
 * while chat.distribute.you is publicly routed: anyone could send any key and
 * any org/user, read every org's conversations, run Sophie as another client's
 * user and call `/internal/transfer-brand` to move a client's sessions into
 * their own org. Never relax this to a presence check, and never add a default
 * or test bypass: an unset key refuses every request (503), fail closed.
 */
export type ServiceKeyVerdict = "ok" | "missing" | "wrong" | "unconfigured";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function checkServiceKey(header: unknown): ServiceKeyVerdict {
  if (typeof header !== "string" || header.length === 0) return "missing";
  const expected = process.env.CHAT_SERVICE_API_KEY;
  if (!expected) return "unconfigured";
  return timingSafeEqual(digest(header), digest(expected)) ? "ok" : "wrong";
}

/** Answers the refusal and returns false, or returns true for a caller holding the key. */
function refuseUnlessServiceKey(req: Request, res: Response): boolean {
  const verdict = checkServiceKey(req.headers["x-api-key"]);
  if (verdict === "ok") return true;
  if (verdict === "missing") {
    res.status(401).json({ error: "x-api-key header is required" });
  } else if (verdict === "unconfigured") {
    console.error("[chat-service] CHAT_SERVICE_API_KEY is not set: refusing every authenticated request");
    res.status(503).json({ error: "Service key not configured" });
  } else {
    res.status(401).json({ error: "Invalid API key" });
  }
  return false;
}

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
  if (!refuseUnlessServiceKey(req, res)) return;

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

export function extractWorkflowTracking(req: Request): WorkflowTrackingHeaders {
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
  if (!refuseUnlessServiceKey(req, res)) return;
  next();
}
