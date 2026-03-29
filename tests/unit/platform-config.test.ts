import { describe, it, expect } from "vitest";
import { PlatformConfigRequestSchema } from "../../src/schemas.js";

describe("PlatformConfigRequestSchema", () => {
  it("accepts valid config with key, systemPrompt, and allowedTools", () => {
    const result = PlatformConfigRequestSchema.safeParse({
      key: "workflow",
      systemPrompt: "You are a helpful assistant.",
      allowedTools: ["request_user_input", "update_workflow"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.key).toBe("workflow");
      expect(result.data.allowedTools).toEqual(["request_user_input", "update_workflow"]);
    }
  });

  it("rejects missing key", () => {
    const result = PlatformConfigRequestSchema.safeParse({
      systemPrompt: "You are a helpful assistant.",
      allowedTools: ["request_user_input"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty key", () => {
    const result = PlatformConfigRequestSchema.safeParse({
      key: "",
      systemPrompt: "You are a helpful assistant.",
      allowedTools: ["request_user_input"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty systemPrompt", () => {
    const result = PlatformConfigRequestSchema.safeParse({
      key: "workflow",
      systemPrompt: "",
      allowedTools: ["request_user_input"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing systemPrompt", () => {
    const result = PlatformConfigRequestSchema.safeParse({
      key: "workflow",
      allowedTools: ["request_user_input"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing allowedTools", () => {
    const result = PlatformConfigRequestSchema.safeParse({
      key: "workflow",
      systemPrompt: "You are a helpful assistant.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty allowedTools array", () => {
    const result = PlatformConfigRequestSchema.safeParse({
      key: "workflow",
      systemPrompt: "You are a helpful assistant.",
      allowedTools: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields (strict mode)", () => {
    const result = PlatformConfigRequestSchema.safeParse({
      key: "workflow",
      systemPrompt: "You are a helpful assistant.",
      allowedTools: ["request_user_input"],
      mcpServerUrl: "https://mcp.example.com",
    });
    expect(result.success).toBe(false);
  });
});
