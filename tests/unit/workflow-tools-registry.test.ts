import { describe, it, expect } from "vitest";
import {
  TOOL_REGISTRY,
  AVAILABLE_TOOL_NAMES,
} from "../../src/lib/anthropic.js";

describe("workflow tool registry", () => {
  it("exposes create_workflow, upgrade_workflow, fork_workflow", () => {
    expect(TOOL_REGISTRY).toHaveProperty("create_workflow");
    expect(TOOL_REGISTRY).toHaveProperty("upgrade_workflow");
    expect(TOOL_REGISTRY).toHaveProperty("fork_workflow");
    expect(AVAILABLE_TOOL_NAMES).toContain("create_workflow");
    expect(AVAILABLE_TOOL_NAMES).toContain("upgrade_workflow");
    expect(AVAILABLE_TOOL_NAMES).toContain("fork_workflow");
  });

  it("does NOT expose the old update_workflow, update_workflow_node_config, generate_workflow tools", () => {
    expect(TOOL_REGISTRY).not.toHaveProperty("update_workflow");
    expect(TOOL_REGISTRY).not.toHaveProperty("update_workflow_node_config");
    expect(TOOL_REGISTRY).not.toHaveProperty("generate_workflow");
    expect(AVAILABLE_TOOL_NAMES).not.toContain("update_workflow");
    expect(AVAILABLE_TOOL_NAMES).not.toContain("update_workflow_node_config");
    expect(AVAILABLE_TOOL_NAMES).not.toContain("generate_workflow");
  });

  it("create_workflow requires description and featureSlug", () => {
    const tool = TOOL_REGISTRY.create_workflow;
    expect(tool.name).toBe("create_workflow");
    const schema = tool.input_schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required).toEqual(
      expect.arrayContaining(["description", "featureSlug"]),
    );
    expect(schema.properties).toHaveProperty("description");
    expect(schema.properties).toHaveProperty("featureSlug");
    expect(schema.properties).toHaveProperty("hints");
    expect(schema.properties).toHaveProperty("style");
  });

  it("upgrade_workflow requires workflowSlug and description, includes HARD RULE in description", () => {
    const tool = TOOL_REGISTRY.upgrade_workflow;
    expect(tool.name).toBe("upgrade_workflow");
    const schema = tool.input_schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required).toEqual(
      expect.arrayContaining(["workflowSlug", "description"]),
    );
    expect(tool.description).toMatch(/HARD RULE/);
    expect(tool.description?.toLowerCase()).toMatch(/bug.?fix/);
    expect(tool.description?.toLowerCase()).toMatch(/metadata/);
    expect(tool.description?.toLowerCase()).toMatch(/fork_workflow/);
  });

  it("fork_workflow requires workflowId and dag, mentions new lineage in description", () => {
    const tool = TOOL_REGISTRY.fork_workflow;
    expect(tool.name).toBe("fork_workflow");
    const schema = tool.input_schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required).toEqual(
      expect.arrayContaining(["workflowId", "dag"]),
    );
    expect(tool.description?.toLowerCase()).toMatch(/lineage|new.?dynasty|fork/);
  });
});
