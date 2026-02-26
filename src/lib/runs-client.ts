const RUNS_SERVICE_URL =
  process.env.RUNS_SERVICE_URL || "https://runs.mcpfactory.org";
const RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY;

export interface RunsRun {
  id: string;
  organizationId: string;
  appId: string;
  serviceName: string;
  taskName: string;
  status: string;
  startedAt: string;
  createdAt: string;
}

export interface CreateRunParams {
  orgId: string;
  userId?: string;
  appId: string;
  serviceName: string;
  taskName: string;
  brandId?: string;
  campaignId?: string;
  parentRunId?: string;
}

export interface CostItem {
  costName: string;
  quantity: number;
}

async function runsRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T | null> {
  if (!RUNS_SERVICE_API_KEY) {
    console.warn("[runs-client] RUNS_SERVICE_API_KEY not set, skipping");
    return null;
  }
  try {
    const res = await fetch(`${RUNS_SERVICE_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": RUNS_SERVICE_API_KEY,
      },
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
): Promise<RunsRun | null> {
  return runsRequest<RunsRun>("POST", "/v1/runs", params);
}

export async function updateRunStatus(
  id: string,
  status: "completed" | "failed",
): Promise<RunsRun | null> {
  return runsRequest<RunsRun>("PATCH", `/v1/runs/${id}`, { status });
}

export async function addRunCosts(
  id: string,
  items: CostItem[],
): Promise<void> {
  if (items.length === 0) return;
  await runsRequest("POST", `/v1/runs/${id}/costs`, { items });
}
