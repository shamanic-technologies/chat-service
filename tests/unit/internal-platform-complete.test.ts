import { describe, it, expect } from "vitest";
import { InternalPlatformCompleteRequestSchema } from "../../src/schemas.js";

describe("InternalPlatformCompleteRequestSchema", () => {
  it("accepts valid request with provider and model", () => {
    const result = InternalPlatformCompleteRequestSchema.safeParse({
      message: "Analyze this workflow definition",
      systemPrompt: "You are a workflow analysis assistant.",
      provider: "anthropic",
      model: "sonnet",
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional responseFormat and temperature", () => {
    const result = InternalPlatformCompleteRequestSchema.safeParse({
      message: "Analyze this",
      systemPrompt: "You are helpful.",
      provider: "google",
      model: "flash",
      responseFormat: "json",
      temperature: 0.5,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.responseFormat).toBe("json");
      expect(result.data.temperature).toBe(0.5);
    }
  });

  it("rejects missing message", () => {
    const result = InternalPlatformCompleteRequestSchema.safeParse({
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "sonnet",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty message", () => {
    const result = InternalPlatformCompleteRequestSchema.safeParse({
      message: "",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "sonnet",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing systemPrompt", () => {
    const result = InternalPlatformCompleteRequestSchema.safeParse({
      message: "Hello",
      provider: "anthropic",
      model: "sonnet",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing provider", () => {
    const result = InternalPlatformCompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      model: "sonnet",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing model", () => {
    const result = InternalPlatformCompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid provider", () => {
    const result = InternalPlatformCompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      provider: "openai",
      model: "sonnet",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid model", () => {
    const result = InternalPlatformCompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "gpt-4",
    });
    expect(result.success).toBe(false);
  });

  it("does NOT accept imageUrl (not supported on internal endpoint)", () => {
    const result = InternalPlatformCompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "sonnet",
      imageUrl: "https://example.com/image.png",
    });
    // imageUrl should be stripped (not in schema) — parse still succeeds but field is absent
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).imageUrl).toBeUndefined();
    }
  });
});
