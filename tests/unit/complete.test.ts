import { describe, it, expect } from "vitest";
import { CompleteRequestSchema } from "../../src/schemas.js";

describe("CompleteRequestSchema", () => {
  it("accepts valid request with message and systemPrompt", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Generate 10 search queries",
      systemPrompt: "You are a PR research assistant.",
    });
    expect(result.success).toBe(true);
  });

  it("accepts all optional fields", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Generate queries",
      systemPrompt: "You are helpful.",
      responseFormat: "json",
      temperature: 0.3,
      maxTokens: 2000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.responseFormat).toBe("json");
      expect(result.data.temperature).toBe(0.3);
      expect(result.data.maxTokens).toBe(2000);
    }
  });

  it("rejects missing message", () => {
    const result = CompleteRequestSchema.safeParse({
      systemPrompt: "You are helpful.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty message", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "",
      systemPrompt: "You are helpful.",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing systemPrompt", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Hello",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty systemPrompt", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid responseFormat", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      responseFormat: "xml",
    });
    expect(result.success).toBe(false);
  });

  it("rejects temperature out of range", () => {
    const below = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      temperature: -0.1,
    });
    expect(below.success).toBe(false);

    const above = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      temperature: 2.1,
    });
    expect(above.success).toBe(false);
  });

  it("rejects maxTokens out of range", () => {
    const zero = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      maxTokens: 0,
    });
    expect(zero.success).toBe(false);

    const tooHigh = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      maxTokens: 65000,
    });
    expect(tooHigh.success).toBe(false);
  });

  it("rejects non-integer maxTokens", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      maxTokens: 1000.5,
    });
    expect(result.success).toBe(false);
  });

  it("accepts temperature at boundaries (0 and 2)", () => {
    const atZero = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      temperature: 0,
    });
    expect(atZero.success).toBe(true);

    const atTwo = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      temperature: 2,
    });
    expect(atTwo.success).toBe(true);
  });
});
