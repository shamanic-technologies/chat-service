import { describe, it, expect } from "vitest";
import { PlatformConfigRequestSchema } from "../../src/schemas.js";

describe("PlatformConfigRequestSchema", () => {
  it("accepts valid config with systemPrompt only", () => {
    const result = PlatformConfigRequestSchema.safeParse({
      systemPrompt: "You are a helpful assistant.",
    });
    expect(result.success).toBe(true);
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

  it("rejects unknown fields (e.g. deprecated mcpServerUrl)", () => {
    const result = PlatformConfigRequestSchema.safeParse({
      systemPrompt: "You are a helpful assistant.",
      mcpServerUrl: "https://mcp.example.com",
    });
    expect(result.success).toBe(false);
  });
});
