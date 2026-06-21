import type { WorkflowTrackingHeaders } from "../middleware/auth.js";

const RUNS_SERVICE_URL =
  process.env.RUNS_SERVICE_URL || "https://runs.mcpfactory.org";
const RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY;

const SERVICE_NAME = "chat-service";

export interface TraceIdentity {
  orgId: string;
  userId: string;
}

export interface TraceEventOptions {
  detail?: string;
  level?: "info" | "warn" | "error";
  data?: Record<string, unknown>;
}

interface TraceEventBody {
  service: string;
  event: string;
  detail?: string;
  level?: "info" | "warn" | "error";
  data?: Record<string, unknown>;
}

function buildTraceHeaders(
  runId: string,
  identity: TraceIdentity,
  tracking: WorkflowTrackingHeaders,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": RUNS_SERVICE_API_KEY as string,
    "x-org-id": identity.orgId,
    "x-user-id": identity.userId,
    "x-run-id": runId,
  };
  if (tracking.brandId) headers["x-brand-id"] = tracking.brandId;
  if (tracking.campaignId) headers["x-campaign-id"] = tracking.campaignId;
  if (tracking.workflowSlug) headers["x-workflow-slug"] = tracking.workflowSlug;
  if (tracking.featureSlug) headers["x-feature-slug"] = tracking.featureSlug;
  if (tracking.audienceId) headers["x-audience-id"] = tracking.audienceId;
  return headers;
}

export function traceEvent(
  runId: string,
  event: string,
  identity: TraceIdentity,
  tracking: WorkflowTrackingHeaders,
  options?: TraceEventOptions,
): void {
  if (!RUNS_SERVICE_API_KEY) return;

  const body: TraceEventBody = { service: SERVICE_NAME, event };
  if (options?.detail !== undefined) body.detail = options.detail;
  if (options?.level !== undefined) body.level = options.level;
  if (options?.data !== undefined) body.data = options.data;

  const url = `${RUNS_SERVICE_URL}/v1/runs/${runId}/events`;
  const headers = buildTraceHeaders(runId, identity, tracking);

  fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
    .then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn(
          `[chat-service] traceEvent failed event="${event}" runId="${runId}" status=${res.status}: ${text}`,
        );
      }
    })
    .catch((err) => {
      console.warn(
        `[chat-service] traceEvent fetch error event="${event}" runId="${runId}":`,
        err,
      );
    });
}
