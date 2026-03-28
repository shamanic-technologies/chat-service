import { apiServiceFetch, type ApiCallParams } from "./api-client.js";

export type WorkflowCallParams = ApiCallParams;

export interface DAGNode {
  id: string;
  type: string;
  config?: Record<string, unknown>;
  inputMapping?: Record<string, string>;
  retries?: number;
}

export interface DAGEdge {
  from: string;
  to: string;
  condition?: string;
}

export interface DAG {
  nodes: DAGNode[];
  edges: DAGEdge[];
  onError?: string;
}

export interface WorkflowResponse {
  id: string;
  orgId: string;
  featureSlug: string;
  name: string;
  displayName?: string | null;
  description?: string | null;
  signatureName: string;
  signature: string;
  category?: string;
  channel?: string;
  audienceType?: string;
  tags?: string[];
  status?: "active" | "deprecated";
  upgradedTo?: string | null;
  forkedFrom?: string | null;
  createdForBrandId?: string | null;
  humanId?: string | null;
  campaignId?: string | null;
  subrequestId?: string | null;
  styleName?: string | null;
  createdByUserId?: string | null;
  createdByRunId?: string | null;
  dag: DAG;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface WorkflowMutationResponse extends WorkflowResponse {
  /** What happened: 'updated' = in-place, 'forked' = new workflow created */
  _action: "updated" | "forked";
  /** Only present when _action is 'forked'. Name of the original workflow. */
  _forkedFromName?: string;
}

export interface UpdateWorkflowResult {
  workflow: WorkflowMutationResponse;
  /** "updated" = in-place 200, "forked" = new workflow 201 */
  outcome: "updated" | "forked";
}

export interface WorkflowConflictError {
  error: string;
  existingWorkflowId: string;
  existingWorkflowSlug: string;
}

export async function getWorkflow(
  workflowId: string,
  params: WorkflowCallParams,
): Promise<WorkflowResponse> {
  const res = await apiServiceFetch(
    `/v1/workflows/${encodeURIComponent(workflowId)}`,
    "GET",
    params,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[workflow-client] GET /v1/workflows/${workflowId} returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as WorkflowResponse;
}

export interface UpdateWorkflowBody {
  name?: string;
  description?: string;
  tags?: string[];
  dag?: DAG;
}

/**
 * Strip null values from DAG nodes before sending.
 * Gemini sometimes sends `config: null` or `inputMapping: null` instead
 * of omitting the field — workflow-service Zod schema rejects nulls.
 */
function sanitizeDag(dag: DAG): DAG {
  return {
    ...dag,
    nodes: dag.nodes.map((node) => {
      const clean: DAGNode = { id: node.id, type: node.type };
      if (node.config != null) clean.config = node.config;
      if (node.inputMapping != null) clean.inputMapping = node.inputMapping;
      if (node.retries != null) clean.retries = node.retries;
      return clean;
    }),
  };
}

export async function updateWorkflow(
  workflowId: string,
  body: UpdateWorkflowBody,
  params: WorkflowCallParams,
): Promise<UpdateWorkflowResult> {
  const sanitized = body.dag ? { ...body, dag: sanitizeDag(body.dag) } : body;
  const res = await apiServiceFetch(
    `/v1/workflows/${encodeURIComponent(workflowId)}`,
    "PUT",
    params,
    sanitized,
  );

  if (res.status === 409) {
    const conflict = (await res.json()) as WorkflowConflictError;
    throw new Error(
      `[workflow-client] A workflow with this DAG signature already exists: "${conflict.existingWorkflowSlug}" (${conflict.existingWorkflowId}). Use the existing workflow instead of creating a duplicate.`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[workflow-client] PUT /v1/workflows/${workflowId} returned ${res.status}: ${text}`,
    );
  }

  const workflow = (await res.json()) as WorkflowMutationResponse;
  const outcome = workflow._action ?? (res.status === 201 ? "forked" : "updated");
  return { workflow, outcome };
}

export async function updateWorkflowNodeConfig(
  workflowId: string,
  nodeId: string,
  configUpdates: Record<string, unknown>,
  params: WorkflowCallParams,
): Promise<UpdateWorkflowResult> {
  const workflow = await getWorkflow(workflowId, params);

  if (!workflow.dag) {
    throw new Error(`[workflow-client] Workflow ${workflowId} has no DAG`);
  }

  const nodeIndex = workflow.dag.nodes.findIndex((n) => n.id === nodeId);
  if (nodeIndex === -1) {
    throw new Error(
      `[workflow-client] Node "${nodeId}" not found in workflow ${workflowId}. Available nodes: ${workflow.dag.nodes.map((n) => n.id).join(", ")}`,
    );
  }

  const node = workflow.dag.nodes[nodeIndex];
  node.config = { ...node.config, ...configUpdates };

  return updateWorkflow(workflowId, { dag: workflow.dag }, params);
}

export interface GenerateWorkflowBody {
  description: string;
  featureSlug: string;
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
  const res = await apiServiceFetch("/v1/workflows/generate", "POST", params, body);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[workflow-client] POST /v1/workflows/generate returned ${res.status}: ${text}`,
    );
  }

  return await res.json();
}

export async function getWorkflowRequiredProviders(
  workflowId: string,
  params: WorkflowCallParams,
): Promise<unknown> {
  const res = await apiServiceFetch(
    `/v1/workflows/${encodeURIComponent(workflowId)}/key-status`,
    "GET",
    params,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[workflow-client] GET /v1/workflows/${workflowId}/key-status returned ${res.status}: ${text}`,
    );
  }

  return await res.json();
}

export interface ListWorkflowsParams {
  featureSlug?: string;
  category?: string;
  channel?: string;
  audienceType?: string;
  tag?: string;
  status?: string;
  brandId?: string;
  humanId?: string;
  campaignId?: string;
}

export async function listWorkflows(
  filters: ListWorkflowsParams,
  params: WorkflowCallParams,
): Promise<unknown> {
  const query = new URLSearchParams();
  if (filters.featureSlug) query.set("featureSlug", filters.featureSlug);
  if (filters.category) query.set("category", filters.category);
  if (filters.channel) query.set("channel", filters.channel);
  if (filters.audienceType) query.set("audienceType", filters.audienceType);
  if (filters.tag) query.set("tag", filters.tag);
  if (filters.status) query.set("status", filters.status);
  if (filters.brandId) query.set("brandId", filters.brandId);
  if (filters.humanId) query.set("humanId", filters.humanId);
  if (filters.campaignId) query.set("campaignId", filters.campaignId);

  const qs = query.toString();
  const res = await apiServiceFetch(
    `/v1/workflows${qs ? `?${qs}` : ""}`,
    "GET",
    params,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[workflow-client] GET /v1/workflows returned ${res.status}: ${text}`,
    );
  }

  return await res.json();
}

export async function validateWorkflow(
  workflowId: string,
  params: WorkflowCallParams,
): Promise<unknown> {
  const res = await apiServiceFetch(
    `/v1/workflows/${encodeURIComponent(workflowId)}/validate`,
    "POST",
    params,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[workflow-client] POST /v1/workflows/${workflowId}/validate returned ${res.status}: ${text}`,
    );
  }

  return await res.json();
}
