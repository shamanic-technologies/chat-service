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
  creationType: "scratch" | "upgrade" | "fork";
  createdFromWorkflow: string | null;
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

export interface ForkWorkflowResult {
  workflow: WorkflowMutationResponse;
  /** "updated" = signature unchanged (no-op), "forked" = new workflow created */
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

export interface ForkWorkflowBody {
  dag: DAG;
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

/**
 * Fork a workflow by submitting a new DAG to PUT /v1/workflows/:id.
 * Workflow-service creates a new dynasty when the DAG signature differs from
 * the source. Same-signature submissions return _action: "updated" (no-op).
 */
export async function forkWorkflow(
  workflowId: string,
  body: ForkWorkflowBody,
  params: WorkflowCallParams,
): Promise<ForkWorkflowResult> {
  const sanitized = { dag: sanitizeDag(body.dag) };
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

export interface CreateWorkflowBody {
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

/**
 * Create a new workflow dynasty from a natural-language description.
 * Returns the generated workflow with its DAG. workflow-service deploys it.
 */
export async function createWorkflow(
  body: CreateWorkflowBody,
  params: WorkflowCallParams,
): Promise<unknown> {
  const res = await apiServiceFetch("/v1/workflows/create", "POST", params, body);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[workflow-client] POST /v1/workflows/create returned ${res.status}: ${text}`,
    );
  }

  return await res.json();
}

export interface UpgradeWorkflowBody {
  workflowSlug: string;
  description?: string;
  hints?: string[];
  dag?: DAG;
}

/**
 * Upgrade an existing workflow within its dynasty. At least one of `dag` or
 * `description` must be supplied. When `dag` is provided, workflow-service
 * skips LLM regeneration and applies the patch verbatim — use this for
 * surgical fixes. When only `description` is provided, the LLM regenerates
 * the DAG from natural language.
 *
 * Upgrade is reserved for bug fixes, metadata clarifications, or repairing a
 * technically broken/non-functional workflow. Substantive changes must use
 * forkWorkflow.
 */
export async function upgradeWorkflow(
  body: UpgradeWorkflowBody,
  params: WorkflowCallParams,
): Promise<unknown> {
  if (!body.dag && !body.description) {
    throw new Error(
      `[workflow-client] upgradeWorkflow requires at least one of 'dag' or 'description'`,
    );
  }

  const payload: UpgradeWorkflowBody = { ...body };
  if (body.dag) payload.dag = sanitizeDag(body.dag);

  const res = await apiServiceFetch("/v1/workflows/upgrade", "POST", params, payload);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[workflow-client] POST /v1/workflows/upgrade returned ${res.status}: ${text}`,
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
