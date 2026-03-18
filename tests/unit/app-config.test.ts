import { describe, it, expect } from "vitest";
import { AppConfigRequestSchema } from "../../src/schemas.js";

describe("AppConfigRequestSchema", () => {
  it("accepts valid config with systemPrompt only", () => {
    const result = AppConfigRequestSchema.safeParse({
      systemPrompt: "You are a helpful assistant.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty systemPrompt", () => {
    const result = AppConfigRequestSchema.safeParse({
      systemPrompt: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing systemPrompt", () => {
    const result = AppConfigRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
