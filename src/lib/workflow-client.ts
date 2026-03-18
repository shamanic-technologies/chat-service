const WORKFLOW_SERVICE_URL =
  process.env.WORKFLOW_SERVICE_URL || "https://windmill.distribute.org";
const WORKFLOW_SERVICE_API_KEY = process.env.WORKFLOW_SERVICE_API_KEY;

export interface UpdateWorkflowParams {
  name?: string;
  description?: string;
  tags?: string[];
}

export interface UpdateWorkflowContext {
  orgId: string;
  userId: string;
  runId: string;
  trackingHeaders?: Record<string, string>;
}

export async function updateWorkflow(
  workflowId: string,
  params: UpdateWorkflowParams,
  ctx: UpdateWorkflowContext,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  if (!WORKFLOW_SERVICE_API_KEY) {
    return { success: false, error: "WORKFLOW_SERVICE_API_KEY not configured" };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": WORKFLOW_SERVICE_API_KEY,
    "x-org-id": ctx.orgId,
    "x-user-id": ctx.userId,
    "x-run-id": ctx.runId,
  };
  if (ctx.trackingHeaders) {
    for (const [k, v] of Object.entries(ctx.trackingHeaders)) {
      if (v) headers[k] = v;
    }
  }

  try {
    const res = await fetch(
      `${WORKFLOW_SERVICE_URL}/workflows/${workflowId}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify(params),
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        success: false,
        error: `Workflow service returned ${res.status}: ${text}`,
      };
    }

    const data = await res.json();
    return { success: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Workflow service request failed: ${msg}` };
  }
}
