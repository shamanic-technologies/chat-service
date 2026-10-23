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

export interface RunIdentityHeaders {
  orgId: string;
  userId: string;
  runId: string;
}

export interface CreateRunParams {
  serviceName: string;
  taskName: string;
}

export interface CreatePlatformRunParams extends CreateRunParams {
  /**
   * The CALLER's run this platform call is made on behalf of. The platform run
   * becomes its child, so the spend rolls into the caller's subtree (runs-service:
   * a child that declares no outcome rolls into its nearest declaring ancestor).
   * Who pays does not change: the run stays platform-billed. Omitted = a root
   * platform run, exactly as before.
   */
  parentRunId?: string;
}

export interface CostItem {
  costName: string;
  quantity: number;
  costSource: "platform" | "org";
  /** Defaults to "actual" server-side. Use "provisioned" to reserve before a costly op. */
  status?: "actual" | "provisioned" | "cancelled";
}

export interface RunCost {
  id: string;
  runId: string;
  costName: string;
  costSource: "platform" | "org";
  quantity: string;
  unitCostInUsdCents: string;
  totalCostInUsdCents: string;
  status: "actual" | "provisioned" | "cancelled";
  idempotencyKey: string | null;
  createdAt: string;
}

export interface TrackingHeaders {
  "x-campaign-id"?: string;
  "x-brand-id"?: string;
  "x-workflow-slug"?: string;
  "x-feature-slug"?: string;
  "x-audience-id"?: string;
}

function buildHeaders(
  identity: RunIdentityHeaders,
  trackingHeaders?: TrackingHeaders,
): Record<string, string> {
  if (!RUNS_SERVICE_API_KEY) {
    throw new Error("[runs-client] RUNS_SERVICE_API_KEY is required");
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": RUNS_SERVICE_API_KEY,
    "x-org-id": identity.orgId,
    "x-user-id": identity.userId,
    "x-run-id": identity.runId,
  };
  if (trackingHeaders) {
    for (const [k, v] of Object.entries(trackingHeaders)) {
      if (v) headers[k] = v;
    }
  }
  return headers;
}

async function runsRequest<T>(
  method: string,
  path: string,
  identity: RunIdentityHeaders,
  body?: unknown,
  trackingHeaders?: TrackingHeaders,
): Promise<T> {
  const res = await fetch(`${RUNS_SERVICE_URL}${path}`, {
    method,
    headers: buildHeaders(identity, trackingHeaders),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[runs-client] ${method} ${path} returned ${res.status}: ${text}`,
    );
  }
  return (await res.json()) as T;
}

export async function createRun(
  params: CreateRunParams,
  identity: RunIdentityHeaders,
  trackingHeaders?: TrackingHeaders,
): Promise<RunsRun> {
  return runsRequest<RunsRun>("POST", "/v1/runs", identity, params, trackingHeaders);
}

export async function updateRunStatus(
  id: string,
  status: "completed" | "failed",
  identity: RunIdentityHeaders,
  trackingHeaders?: TrackingHeaders,
): Promise<RunsRun> {
  return runsRequest<RunsRun>("PATCH", `/v1/runs/${id}`, identity, { status }, trackingHeaders);
}

export async function addRunCosts(
  id: string,
  items: CostItem[],
  identity: RunIdentityHeaders,
  trackingHeaders?: TrackingHeaders,
): Promise<RunCost[]> {
  if (items.length === 0) return [];
  const res = await runsRequest<{ costs: RunCost[] }>(
    "POST",
    `/v1/runs/${id}/costs`,
    identity,
    { items },
    trackingHeaders,
  );
  return res.costs;
}

/**
 * Realize ("actual") or release ("cancelled") a previously provisioned cost.
 * Throws on non-2xx (fail loud — a stuck provisioned cost under-reports spend).
 */
export async function updateRunCostStatus(
  runId: string,
  costId: string,
  status: "actual" | "cancelled",
  identity: RunIdentityHeaders,
  trackingHeaders?: TrackingHeaders,
): Promise<RunCost> {
  return runsRequest<RunCost>(
    "PATCH",
    `/v1/runs/${runId}/costs/${costId}`,
    identity,
    { status },
    trackingHeaders,
  );
}

// --- Platform runs (no org/user identity — system-level callers) -------------
//
// Platform runs let internal, org-less calls (e.g. /internal/platform-complete
// used for startup workflow upgrades) declare their LLM spend. Auth is
// x-api-key + x-service-name only — no x-org-id/x-user-id/x-run-id. There is no
// cost-status PATCH on platform runs, so callers declare costs as `actual`
// after the call rather than provision→cancel.

function buildPlatformHeaders(serviceName: string): Record<string, string> {
  if (!RUNS_SERVICE_API_KEY) {
    throw new Error("[runs-client] RUNS_SERVICE_API_KEY is required");
  }
  return {
    "Content-Type": "application/json",
    "x-api-key": RUNS_SERVICE_API_KEY,
    "x-service-name": serviceName,
  };
}

async function platformRunsRequest<T>(
  method: string,
  path: string,
  serviceName: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${RUNS_SERVICE_URL}${path}`, {
    method,
    headers: buildPlatformHeaders(serviceName),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new RunsServiceError(method, path, res.status, text);
  }
  return (await res.json()) as T;
}

/** A platform-run call runs-service answered with a non-2xx status. */
export class RunsServiceError extends Error {
  constructor(
    method: string,
    path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`[runs-client] ${method} ${path} returned ${status}: ${body}`);
    this.name = "RunsServiceError";
  }
}

export async function createPlatformRun(
  params: CreatePlatformRunParams,
): Promise<RunsRun> {
  return platformRunsRequest<RunsRun>(
    "POST",
    "/v1/platform-runs",
    params.serviceName,
    {
      serviceName: params.serviceName,
      taskName: params.taskName,
      // runs-service reads the parent from the BODY on this route; it ignores
      // x-run-id there on purpose (other services forward a stale one).
      ...(params.parentRunId ? { parentRunId: params.parentRunId } : {}),
    },
  );
}

export async function addPlatformRunCosts(
  id: string,
  serviceName: string,
  items: CostItem[],
): Promise<RunCost[]> {
  if (items.length === 0) return [];
  const res = await platformRunsRequest<{ costs: RunCost[] }>(
    "POST",
    `/v1/platform-runs/${id}/costs`,
    serviceName,
    { items },
  );
  return res.costs;
}

export async function updatePlatformRunStatus(
  id: string,
  serviceName: string,
  status: "completed" | "failed",
): Promise<RunsRun> {
  return platformRunsRequest<RunsRun>(
    "PATCH",
    `/v1/platform-runs/${id}`,
    serviceName,
    { status },
  );
}
