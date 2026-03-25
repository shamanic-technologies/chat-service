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
  update_workflow:
    "For targeted node changes, prefer update_workflow_node_config instead. " +
    "If you need to send a full DAG, call get_workflow_details first to get the current DAG, " +
    "then modify only the parts you need and pass the complete result.",
  update_workflow_node_config:
    "Pass workflowId (UUID), nodeId (e.g. 'email-generate'), and configUpdates (object with keys to merge). " +
    "Only keys in configUpdates are changed; the rest is preserved.",
  get_workflow_details:
    "Pass workflowId as a UUID string. If it's in context, use it directly.",
  validate_workflow:
    "Pass workflowId as a UUID string.",
  get_workflow_required_providers:
    "Pass workflowId as a UUID string.",
  list_workflows:
    "All parameters are optional: category ('sales'|'pr'), channel ('email'), tags (string[]), search (free text).",
  get_prompt_template:
    "Pass type as a string (e.g. 'cold-email', 'follow-up').",
  update_prompt_template:
    "Pass sourceType (existing prompt type), prompt (template with {{variables}}), and variables (array of variable names).",
  list_available_services:
    "No parameters needed. Returns all services and their endpoints.",
  upsert_feature:
    "Pass slug (kebab-case), name, description, category, channel, audienceType, inputs (array of {key, label, description}), and outputs (array of {key, label, description}). All fields are required.",
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
