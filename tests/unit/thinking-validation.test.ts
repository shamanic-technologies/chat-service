import { describe, it, expect } from "vitest";
import { CompleteRequestSchema } from "../../src/schemas.js";

describe("CompleteRequestSchema thinkingBudget validation", () => {
  const base = {
    message: "test",
    systemPrompt: "You are helpful.",
    provider: "anthropic" as const,
    model: "sonnet" as const,
  };

  it("accepts thinkingBudget: 0 for Anthropic (disabled)", () => {
    const result = CompleteRequestSchema.safeParse({ ...base, thinkingBudget: 0 });
    expect(result.success).toBe(true);
  });

  it("accepts thinkingBudget >= 1024 for Anthropic", () => {
    const result = CompleteRequestSchema.safeParse({ ...base, thinkingBudget: 1024, maxTokens: 16000 });
    expect(result.success).toBe(true);
  });

  it("rejects thinkingBudget < 1024 for Anthropic (when > 0)", () => {
    const result = CompleteRequestSchema.safeParse({ ...base, thinkingBudget: 500 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/thinkingBudget >= 1024/);
    }
  });

  it("rejects thinkingBudget >= maxTokens for Anthropic", () => {
    const result = CompleteRequestSchema.safeParse({ ...base, thinkingBudget: 2000, maxTokens: 2000 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/must be less than maxTokens/);
    }
  });

  it("rejects thinkingBudget >= default maxTokens (64000) for Anthropic", () => {
    const result = CompleteRequestSchema.safeParse({ ...base, thinkingBudget: 64000 });
    expect(result.success).toBe(false);
  });

  it("accepts any thinkingBudget > 0 for Google (no min constraint)", () => {
    const result = CompleteRequestSchema.safeParse({
      ...base,
      provider: "google",
      model: "flash",
      thinkingBudget: 100,
    });
    expect(result.success).toBe(true);
  });

  it("accepts omitted thinkingBudget", () => {
    const result = CompleteRequestSchema.safeParse(base);
    expect(result.success).toBe(true);
  });
});
