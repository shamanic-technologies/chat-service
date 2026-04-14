import { describe, it, expect } from "vitest";
import { TOOL_REGISTRY, AVAILABLE_TOOL_NAMES, resolveToolSet } from "../../src/lib/anthropic.js";

describe("TOOL_REGISTRY", () => {
  it("contains all expected tools", () => {
    expect(AVAILABLE_TOOL_NAMES).toContain("request_user_input");
    expect(AVAILABLE_TOOL_NAMES).toContain("update_workflow");
    expect(AVAILABLE_TOOL_NAMES).toContain("create_feature");
    expect(AVAILABLE_TOOL_NAMES).toContain("list_services");
    expect(AVAILABLE_TOOL_NAMES).toContain("update_campaign_fields");
    expect(AVAILABLE_TOOL_NAMES).toContain("extract_brand_fields");
    expect(AVAILABLE_TOOL_NAMES).toContain("browse_url");
    expect(AVAILABLE_TOOL_NAMES).not.toContain("extract_brand_text");
  });

  it("does NOT contain call_api (removed for security)", () => {
    expect(AVAILABLE_TOOL_NAMES).not.toContain("call_api");
    expect(TOOL_REGISTRY["call_api"]).toBeUndefined();
  });

  it("has matching names in registry keys and tool definitions", () => {
    for (const [key, tool] of Object.entries(TOOL_REGISTRY)) {
      expect(tool.name).toBe(key);
    }
  });
});

describe("resolveToolSet", () => {
  it("resolves known tools to their definitions", () => {
    const tools = resolveToolSet(["request_user_input", "update_workflow"]);
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("request_user_input");
    expect(tools[1].name).toBe("update_workflow");
  });

  it("skips unknown tool names", () => {
    const tools = resolveToolSet(["request_user_input", "nonexistent_tool"]);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("request_user_input");
  });

  it("returns empty array for empty input", () => {
    const tools = resolveToolSet([]);
    expect(tools).toHaveLength(0);
  });

  it("returns all tools when given all names", () => {
    const tools = resolveToolSet(AVAILABLE_TOOL_NAMES);
    expect(tools).toHaveLength(AVAILABLE_TOOL_NAMES.length);
  });
});
