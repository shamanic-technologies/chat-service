/**
 * Transform raw tool call errors into structured, LLM-friendly messages
 * that help the model understand what went wrong and how to fix it.
 */

interface ToolErrorResult {
  error: string;
  tool: string;
  suggestion: string;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Extract field-level validation errors from a single parsed error node, in
 * either dialect we receive:
 *   - Zod:              { issues: [{ path: string[], message }] }
 *                       (also nested as { details: { issues: [...] } })
 *   - workflow-service: { details: [{ field: string, message }] }  (DAG validation)
 */
function extractFieldErrors(node: unknown): string[] | null {
  if (!node || typeof node !== "object") return null;
  const obj = node as { issues?: unknown; details?: unknown };

  // Zod: top-level `issues`, or `details.issues`.
  const detailsIssues =
    obj.details && typeof obj.details === "object" && !Array.isArray(obj.details)
      ? (obj.details as { issues?: unknown }).issues
      : undefined;
  const issues = Array.isArray(obj.issues)
    ? obj.issues
    : Array.isArray(detailsIssues)
      ? detailsIssues
      : null;
  if (Array.isArray(issues)) {
    return (issues as Array<{ path?: string[]; message?: string }>).map(
      (i) => `${(i.path ?? []).join(".")}: ${i.message ?? "invalid"}`,
    );
  }

  // workflow-service DAG validation: `details` is an array of {field, message}.
  if (Array.isArray(obj.details)) {
    return (obj.details as Array<{ field?: string; message?: string }>).map((d) =>
      d.field ? `${d.field}: ${d.message ?? "invalid"}` : d.message ?? "invalid",
    );
  }
  return null;
}

/**
 * Parse field-level validation errors from a downstream service response.
 *
 * Handles two complications beyond a plain Zod parse:
 *   1. The message is prefixed by the client wrapper
 *      (`[workflow-client] POST /... returned NNN: <body>`) — we strip to the body.
 *   2. api-service wraps a downstream service's error as
 *      `{ "error": "<stringified downstream JSON>" }`, sometimes turning a
 *      workflow-service 400 into a 500 in the process. We peel nested `.error`
 *      string wrappers until we find the `issues`/`details` payload.
 */
function parseValidationErrors(raw: string): string[] | null {
  const bodyMatch = raw.match(/returned \d{3}: ?([\s\S]*)$/);
  const candidate = bodyMatch ? bodyMatch[1] : raw;

  let node = tryParse(candidate);
  if (node == null) return null;

  for (let depth = 0; depth < 5; depth++) {
    const found = extractFieldErrors(node);
    if (found) return found;
    // Unwrap `{ error: "<json string>" }` (api-service double-encode).
    if (
      node &&
      typeof node === "object" &&
      typeof (node as { error?: unknown }).error === "string"
    ) {
      const inner = tryParse((node as { error: string }).error);
      if (inner == null) return null;
      node = inner;
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Parse the HTTP status code from a workflow/content-generation client error.
 */
function parseStatusCode(msg: string): number | null {
  const match = msg.match(/returned (\d{3})/);
  return match ? parseInt(match[1], 10) : null;
}

const TOOL_HINTS: Record<string, string> = {
  create_workflow:
    "Pass description (natural language, min 10 chars), featureSlug (e.g. 'cold-email-outreach'), optional hints ({services, nodeTypes, expectedInputs}), optional style ({type, name, humanId?, brandId?}). Use only for NEW workflows from scratch.",
  upgrade_workflow:
    "Pass workflowDynastySlug (the stable dynasty slug from get_workflow_details — constant across versions, NOT the versioned workflowSlug like '...-v3', NOT the UUID). Then pass at least one of: dag (full corrected DAG — REQUIRED for surgical fixes like $ref/wiring/template-version repairs; workflow-service applies it verbatim with no LLM regen) OR description (NL describing the change, min 10 chars — only when you do not have the DAG; triggers full LLM regen which routinely drifts). hints is an OBJECT {services?, nodeTypes?, expectedInputs?}, not a string array. HARD RULE: upgrade is for bug fixes, metadata clarifications, or repairing technically broken workflows — for substantive changes on a working workflow, use fork_workflow instead.",
  fork_workflow:
    "Pass workflowId (UUID) and dag (complete DAG with nodes and edges). Call get_workflow_details first to read the current DAG, modify it, then pass the full result. Partial DAGs are not supported.",
  get_workflow_details:
    "Pass workflowId as a UUID string. If it's in context, use it directly.",
  validate_workflow:
    "Pass workflowId as a UUID string.",
  get_workflow_required_providers:
    "Pass workflowId as a UUID string.",
  list_workflows:
    "All parameters are optional: featureSlug, category ('sales'|'pr'|'outlets'|'journalists'), channel ('email'|'database'), audienceType ('cold-outreach'|'discovery'), tag (string), status (defaults to 'active', use 'all' to include deprecated), brandId, humanId, campaignId.",
  get_prompt_template:
    "Pass type as a string (e.g. 'cold-email', 'follow-up').",
  update_prompt_template:
    "Pass sourceType (existing prompt type), prompt (template with {{variables}}), and variables (array of objects, each { name, description } — NOT bare strings).",
  list_available_services:
    "No parameters needed. Returns all services and their endpoints.",
  create_feature:
    "Pass name, description, icon, category, channel, audienceType, inputs (array of {key, label, type, placeholder, description, extractKey}), outputs (array of {key, displayOrder}, keys from stats registry), charts (min 1), and entities (min 1). Optional: slug, implemented, displayOrder, status. Returns 409 if slug/name already exists.",
  update_feature:
    "Pass slug (required) and any fields to update: name, description, icon, category, channel, audienceType, implemented, displayOrder, status, inputs, outputs, charts, entities. Only provided fields are changed.",
  list_features:
    "All parameters are optional: category, channel, audienceType, status, implemented ('true'/'false').",
  get_feature:
    "Pass slug as a string. Returns the full feature definition.",
};

export function formatToolError(toolName: string, rawError: string): ToolErrorResult {
  const status = parseStatusCode(rawError);
  const fieldErrors = parseValidationErrors(rawError);

  let error: string;
  let suggestion: string;

  // Field-level validation errors are checked BEFORE status, because
  // api-service can surface a downstream 400 wrapped in a 500 — the actionable
  // detail is in the body regardless of the outer status code.
  if (fieldErrors && fieldErrors.length > 0) {
    const fieldList = fieldErrors.slice(0, 5).join("; ");
    error = `Validation failed: ${fieldList}${fieldErrors.length > 5 ? ` (and ${fieldErrors.length - 5} more)` : ""}`;
    suggestion = `Fix the invalid fields listed above. ${TOOL_HINTS[toolName] ?? ""}`;
  } else if (status === 404) {
    error = "Resource not found. Check that the ID exists and is correct.";
    suggestion = TOOL_HINTS[toolName] ?? "Verify the resource ID.";
  } else if (status === 400) {
    error = `Bad request: ${rawError.replace(/.*returned \d{3}: ?/, "").slice(0, 200)}`;
    suggestion = TOOL_HINTS[toolName] ?? "Check the parameters and try again.";
  } else if (status === 401 || status === 403) {
    error = "Authentication or authorization failed.";
    suggestion = "This is a server configuration issue, not something you can fix. Inform the user.";
  } else if (rawError.includes("is required")) {
    error = rawError;
    suggestion = "This is a server configuration issue (missing env var). Inform the user.";
  } else {
    error = rawError.slice(0, 300);
    suggestion = TOOL_HINTS[toolName] ?? "Check the parameters and try again.";
  }

  return { error, tool: toolName, suggestion };
}
