import { describe, it, expect } from "vitest";
import { formatToolError } from "../../src/lib/tool-errors.js";

describe("formatToolError", () => {
  it("parses Zod validation errors into field-level messages", () => {
    const raw = `[workflow-client] PUT /workflows/wf-1 returned 400: {"error":"Validation error","details":{"issues":[{"code":"invalid_type","expected":"object","received":"null","path":["dag","nodes",0,"config"],"message":"Expected object, received null"},{"code":"invalid_type","expected":"object","received":"null","path":["dag","nodes",0,"inputMapping"],"message":"Expected object, received null"}],"name":"ZodError"}}`;

    const result = formatToolError("fork_workflow", raw);

    expect(result.error).toContain("dag.nodes.0.config: Expected object, received null");
    expect(result.error).toContain("dag.nodes.0.inputMapping: Expected object, received null");
    expect(result.suggestion).toContain("get_workflow_details");
    expect(result.tool).toBe("fork_workflow");
  });

  it("truncates when more than 5 Zod issues", () => {
    const issues = Array.from({ length: 8 }, (_, i) => ({
      code: "invalid_type",
      expected: "object",
      received: "null",
      path: ["dag", "nodes", i, "config"],
      message: "Expected object, received null",
    }));
    const raw = `returned 400: {"error":"Validation error","details":{"issues":${JSON.stringify(issues)},"name":"ZodError"}}`;

    const result = formatToolError("fork_workflow", raw);
    expect(result.error).toContain("and 3 more");
  });

  it("handles 404 errors with helpful message", () => {
    const raw = "[workflow-client] GET /workflows/bad-id returned 404: Not found";
    const result = formatToolError("get_workflow_details", raw);

    expect(result.error).toContain("not found");
    expect(result.suggestion).toContain("UUID");
  });

  it("handles 401 errors as server config issues", () => {
    const raw = "[api-registry-client] GET /llm-context returned 401: Unauthorized";
    const result = formatToolError("list_available_services", raw);

    expect(result.error).toContain("Authentication");
    expect(result.suggestion).toContain("server configuration");
  });

  it("handles missing API key errors", () => {
    const raw = "[workflow-client] WORKFLOW_SERVICE_API_KEY is required";
    const result = formatToolError("fork_workflow", raw);

    expect(result.error).toContain("is required");
    expect(result.suggestion).toContain("server configuration");
  });

  it("handles generic 400 errors without Zod details", () => {
    const raw = "[workflow-client] PUT /workflows/wf-1 returned 400: Bad request body";
    const result = formatToolError("fork_workflow", raw);

    expect(result.error).toContain("Bad request");
    expect(result.suggestion).toContain("get_workflow_details");
  });

  it("includes tool-specific hints for upgrade_workflow", () => {
    const raw = "returned 400: invalid description";
    const result = formatToolError("upgrade_workflow", raw);

    expect(result.suggestion).toMatch(/bug.?fix|metadata/i);
  });

  it("upgrade_workflow suggestion advertises workflowDynastySlug, dag-first for surgical fixes, and hints-as-object", () => {
    const raw = "returned 400: bad request";
    const result = formatToolError("upgrade_workflow", raw);

    expect(result.suggestion).toMatch(/workflowDynastySlug/);
    expect(result.suggestion).not.toMatch(/Pass workflowSlug\b/);
    expect(result.suggestion).toMatch(/dag/);
    expect(result.suggestion.toLowerCase()).toMatch(
      /\$ref|wiring|surgical|verbatim/,
    );
    expect(result.suggestion).toMatch(/hints/);
    expect(result.suggestion.toLowerCase()).toMatch(
      /object|services|nodeTypes|expectedInputs/,
    );
  });

  it("includes tool-specific hints for update_prompt_template", () => {
    const raw = "returned 400: invalid source type";
    const result = formatToolError("update_prompt_template", raw);

    expect(result.suggestion).toContain("sourceType");
  });

  it("includes tool-specific hints for list_workflows", () => {
    const raw = "returned 400: invalid params";
    const result = formatToolError("list_workflows", raw);

    expect(result.suggestion).toContain("category");
  });

  it("truncates very long error messages", () => {
    const raw = "x".repeat(500);
    const result = formatToolError("unknown_tool", raw);

    expect(result.error.length).toBeLessThanOrEqual(300);
  });

  it("returns structured result with tool field", () => {
    const result = formatToolError("get_prompt_template", "some error");

    expect(result).toHaveProperty("error");
    expect(result).toHaveProperty("tool", "get_prompt_template");
    expect(result).toHaveProperty("suggestion");
  });
});
