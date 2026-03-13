import { describe, it, expect } from "vitest";
import { PlatformConfigRequestSchema } from "../../src/schemas.js";

describe("PlatformConfigRequestSchema", () => {
  it("accepts valid config with systemPrompt only", () => {
    const result = PlatformConfigRequestSchema.safeParse({
      systemPrompt: "You are a helpful assistant.",
    });
    expect(result.success).toBe(true);
  });

  it("accepts config with all fields", () => {
    const result = PlatformConfigRequestSchema.safeParse({
      systemPrompt: "You are a helpful assistant.",
      mcpServerUrl: "https://mcp.example.com",
      mcpKeyName: "mcpfactory",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpServerUrl).toBe("https://mcp.example.com");
      expect(result.data.mcpKeyName).toBe("mcpfactory");
    }
  });

  it("rejects empty systemPrompt", () => {
    const result = PlatformConfigRequestSchema.safeParse({
      systemPrompt: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing systemPrompt", () => {
    const result = PlatformConfigRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects invalid URL for mcpServerUrl", () => {
    const result = PlatformConfigRequestSchema.safeParse({
      systemPrompt: "You are a helpful assistant.",
      mcpServerUrl: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty mcpKeyName", () => {
    const result = PlatformConfigRequestSchema.safeParse({
      systemPrompt: "You are a helpful assistant.",
      mcpKeyName: "",
    });
    expect(result.success).toBe(false);
  });
});
