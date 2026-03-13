const RUNS_SERVICE_URL =
  process.env.RUNS_SERVICE_URL || "https://runs.mcpfactory.org";
const RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY;

export interface RunsRun {
  id: string;
  organizationId: string;
  serviceName: string;
  taskName: string;
  status: string;
  startedAt: string;
  createdAt: string;
}

export interface CreateRunParams {
  orgId: string;
  userId?: string;
  serviceName: string;
  taskName: string;
  parentRunId?: string;
}

export interface CostItem {
  costName: string;
  quantity: number;
  costSource: "platform" | "org";
}

export interface TrackingHeaders {
  "x-campaign-id"?: string;
  "x-brand-id"?: string;
  "x-workflow-name"?: string;
}

async function runsRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  trackingHeaders?: TrackingHeaders,
): Promise<T | null> {
  if (!RUNS_SERVICE_API_KEY) {
    console.warn("[runs-client] RUNS_SERVICE_API_KEY not set, skipping");
    return null;
  }
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-API-Key": RUNS_SERVICE_API_KEY,
    };
    if (trackingHeaders) {
      for (const [k, v] of Object.entries(trackingHeaders)) {
        if (v) headers[k] = v;
      }
    }
    const res = await fetch(`${RUNS_SERVICE_URL}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(
        `[runs-client] ${method} ${path} returned ${res.status}: ${text}`,
      );
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[runs-client] ${method} ${path} failed:`, err);
    return null;
  }
}

export async function createRun(
  params: CreateRunParams,
  trackingHeaders?: TrackingHeaders,
): Promise<RunsRun | null> {
  return runsRequest<RunsRun>("POST", "/v1/runs", params, trackingHeaders);
}

export async function updateRunStatus(
  id: string,
  status: "completed" | "failed",
  trackingHeaders?: TrackingHeaders,
): Promise<RunsRun | null> {
  return runsRequest<RunsRun>("PATCH", `/v1/runs/${id}`, { status }, trackingHeaders);
}

export async function addRunCosts(
  id: string,
  items: CostItem[],
  trackingHeaders?: TrackingHeaders,
): Promise<void> {
  if (items.length === 0) return;
  await runsRequest("POST", `/v1/runs/${id}/costs`, { items }, trackingHeaders);
}
