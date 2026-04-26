import { describe, it, expect } from "vitest";
import { AppConfigRequestSchema, PlatformConfigRequestSchema } from "../../src/schemas.js";

const validBase = {
  key: "workflow",
  systemPrompt: "You are a helpful assistant.",
  allowedTools: ["request_user_input"],
};

describe("AppConfigRequestSchema provider/model", () => {
  it("accepts config without provider/model (backward compat)", () => {
    const result = AppConfigRequestSchema.safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBeUndefined();
      expect(result.data.model).toBeUndefined();
    }
  });

  it("accepts anthropic provider with sonnet model", () => {
    const result = AppConfigRequestSchema.safeParse({
      ...validBase,
      provider: "anthropic",
      model: "sonnet",
    });
    expect(result.success).toBe(true);
  });

  it("accepts google provider with pro model", () => {
    const result = AppConfigRequestSchema.safeParse({
      ...validBase,
      provider: "google",
      model: "pro",
    });
    expect(result.success).toBe(true);
  });

  it("accepts google provider with flash-lite model", () => {
    const result = AppConfigRequestSchema.safeParse({
      ...validBase,
      provider: "google",
      model: "flash-lite",
    });
    expect(result.success).toBe(true);
  });

  it("rejects anthropic provider with google model", () => {
    const result = AppConfigRequestSchema.safeParse({
      ...validBase,
      provider: "anthropic",
      model: "pro",
    });
    expect(result.success).toBe(false);
  });

  it("rejects google provider with anthropic model", () => {
    const result = AppConfigRequestSchema.safeParse({
      ...validBase,
      provider: "google",
      model: "sonnet",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown provider", () => {
    const result = AppConfigRequestSchema.safeParse({
      ...validBase,
      provider: "openai",
      model: "gpt-4",
    });
    expect(result.success).toBe(false);
  });

  it("accepts provider without model (uses default)", () => {
    const result = AppConfigRequestSchema.safeParse({
      ...validBase,
      provider: "google",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("google");
      expect(result.data.model).toBeUndefined();
    }
  });

  it("accepts model without provider (cross-validation skipped)", () => {
    const result = AppConfigRequestSchema.safeParse({
      ...validBase,
      model: "sonnet",
    });
    expect(result.success).toBe(true);
  });
});

describe("PlatformConfigRequestSchema provider/model", () => {
  it("accepts config without provider/model", () => {
    const result = PlatformConfigRequestSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it("accepts google/pro", () => {
    const result = PlatformConfigRequestSchema.safeParse({
      ...validBase,
      provider: "google",
      model: "pro",
    });
    expect(result.success).toBe(true);
  });

  it("rejects mismatched provider/model", () => {
    const result = PlatformConfigRequestSchema.safeParse({
      ...validBase,
      provider: "google",
      model: "opus",
    });
    expect(result.success).toBe(false);
  });
});
