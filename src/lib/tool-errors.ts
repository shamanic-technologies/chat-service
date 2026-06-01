/**
 * Transform raw tool call errors into structured, LLM-friendly messages
 * that help the model understand what went wrong and how to fix it.
 */

interface ToolErrorResult {
  error: string;
  tool: string;
  suggestion: string;
}

/**
 * Parse a Zod validation error from a downstream service response.
 * Returns a list of human-readable field errors.
 */
function parseZodErrors(raw: string): string[] | null {
  try {
    const match = raw.match(/\{.*"issues":\[.*\].*\}/s);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const issues = parsed.details?.issues ?? parsed.issues;
    if (!Array.isArray(issues)) return null;
    return issues.map((i: { path?: string[]; message?: string }) =>
      `${(i.path ?? []).join(".")}: ${i.message ?? "invalid"}`,
    );
  } catch {
    return null;
  }
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
  const zodErrors = parseZodErrors(rawError);

  let error: string;
  let suggestion: string;

  if (zodErrors && zodErrors.length > 0) {
    const fieldList = zodErrors.slice(0, 5).join("; ");
    error = `Validation failed: ${fieldList}${zodErrors.length > 5 ? ` (and ${zodErrors.length - 5} more)` : ""}`;
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
