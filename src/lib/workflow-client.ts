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

export interface WorkflowResponse {
  id: string;
  dag: {
    nodes: Array<{
      id: string;
      type: string;
      config?: Record<string, unknown>;
      inputMapping?: Record<string, string>;
      retries?: number;
    }>;
    edges: Array<{ from: string; to: string; condition?: string }>;
    onError?: string;
  };
  [key: string]: unknown;
}

export async function getWorkflow(
  workflowId: string,
  params: WorkflowCallParams,
): Promise<WorkflowResponse> {
  const url = `${WORKFLOW_SERVICE_URL}/workflows/${encodeURIComponent(workflowId)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: buildHeaders(params),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[workflow-client] GET /workflows/${workflowId} returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as WorkflowResponse;
}

export interface UpdateWorkflowBody {
  name?: string;
  description?: string;
  tags?: string[];
  dag?: WorkflowResponse["dag"];
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

export async function updateWorkflowNodeConfig(
  workflowId: string,
  nodeId: string,
  configUpdates: Record<string, unknown>,
  params: WorkflowCallParams,
): Promise<unknown> {
  // 1. Fetch the current workflow to get the full DAG
  const workflow = await getWorkflow(workflowId, params);

  if (!workflow.dag) {
    throw new Error(`[workflow-client] Workflow ${workflowId} has no DAG`);
  }

  // 2. Find the target node
  const nodeIndex = workflow.dag.nodes.findIndex((n) => n.id === nodeId);
  if (nodeIndex === -1) {
    throw new Error(
      `[workflow-client] Node "${nodeId}" not found in workflow ${workflowId}. Available nodes: ${workflow.dag.nodes.map((n) => n.id).join(", ")}`,
    );
  }

  // 3. Merge config updates into the node's existing config
  const node = workflow.dag.nodes[nodeIndex];
  node.config = { ...node.config, ...configUpdates };

  // 4. PUT the updated DAG back
  return updateWorkflow(workflowId, { dag: workflow.dag }, params);
}

export interface GenerateWorkflowBody {
  description: string;
  hints?: {
    services?: string[];
    nodeTypes?: string[];
    expectedInputs?: string[];
  };
  style?: {
    type: "human" | "brand";
    humanId?: string;
    brandId?: string;
    name: string;
  };
}

export async function generateWorkflow(
  body: GenerateWorkflowBody,
  params: WorkflowCallParams,
): Promise<unknown> {
  const url = `${WORKFLOW_SERVICE_URL}/workflows/generate`;
  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(params),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[workflow-client] POST /workflows/generate returned ${res.status}: ${text}`,
    );
  }

  return await res.json();
}

export async function getWorkflowRequiredProviders(
  workflowId: string,
  params: WorkflowCallParams,
): Promise<unknown> {
  const url = `${WORKFLOW_SERVICE_URL}/workflows/${encodeURIComponent(workflowId)}/required-providers`;
  const res = await fetch(url, {
    method: "GET",
    headers: buildHeaders(params),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[workflow-client] GET /workflows/${workflowId}/required-providers returned ${res.status}: ${text}`,
    );
  }

  return await res.json();
}

export interface ListWorkflowsParams {
  category?: string;
  channel?: string;
  tags?: string[];
  search?: string;
}

export async function listWorkflows(
  filters: ListWorkflowsParams,
  params: WorkflowCallParams,
): Promise<unknown> {
  const query = new URLSearchParams();
  if (filters.category) query.set("category", filters.category);
  if (filters.channel) query.set("channel", filters.channel);
  if (filters.tags?.length) {
    for (const tag of filters.tags) query.append("tags", tag);
  }
  if (filters.search) query.set("search", filters.search);

  const qs = query.toString();
  const url = `${WORKFLOW_SERVICE_URL}/workflows${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    method: "GET",
    headers: buildHeaders(params),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[workflow-client] GET /workflows returned ${res.status}: ${text}`,
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
