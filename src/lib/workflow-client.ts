const WORKFLOW_SERVICE_URL =
  process.env.WORKFLOW_SERVICE_URL || "https://workflow.mcpfactory.org";
const WORKFLOW_SERVICE_API_KEY = process.env.WORKFLOW_SERVICE_API_KEY;

export interface WorkflowCallParams {
  orgId: string;
  userId: string;
  runId: string;
  trackingHeaders?: Record<string, string>;
}

function buildHeaders(params: WorkflowCallParams): Record<string, string> {
  if (!WORKFLOW_SERVICE_API_KEY) {
    throw new Error(
      "[workflow-client] WORKFLOW_SERVICE_API_KEY is required",
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": WORKFLOW_SERVICE_API_KEY,
    "x-org-id": params.orgId,
    "x-user-id": params.userId,
    "x-run-id": params.runId,
  };
  if (params.trackingHeaders) {
    for (const [k, v] of Object.entries(params.trackingHeaders)) {
      if (v) headers[k] = v;
    }
  }
  return headers;
}

export interface UpdateWorkflowBody {
  name?: string;
  description?: string;
  tags?: string[];
}

export async function updateWorkflow(
  workflowId: string,
  body: UpdateWorkflowBody,
  params: WorkflowCallParams,
): Promise<unknown> {
  const url = `${WORKFLOW_SERVICE_URL}/workflows/${encodeURIComponent(workflowId)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: buildHeaders(params),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[workflow-client] PUT /workflows/${workflowId} returned ${res.status}: ${text}`,
    );
  }

  return await res.json();
}

export async function validateWorkflow(
  workflowId: string,
  params: WorkflowCallParams,
): Promise<unknown> {
  const url = `${WORKFLOW_SERVICE_URL}/workflows/${encodeURIComponent(workflowId)}/validate`;
  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(params),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[workflow-client] POST /workflows/${workflowId}/validate returned ${res.status}: ${text}`,
    );
  }

  return await res.json();
}
