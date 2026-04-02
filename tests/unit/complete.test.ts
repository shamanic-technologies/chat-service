import { describe, it, expect } from "vitest";
import { CompleteRequestSchema } from "../../src/schemas.js";
import { isGeminiModel, geminiCostPrefix, GEMINI_MODELS } from "../../src/lib/gemini.js";
import { costPrefixForModel, SUPPORTED_MODELS, resolveModel } from "../../src/lib/anthropic.js";

describe("CompleteRequestSchema", () => {
  it("accepts valid request with provider and model", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Generate 10 search queries",
      systemPrompt: "You are a PR research assistant.",
      provider: "anthropic",
      model: "sonnet",
    });
    expect(result.success).toBe(true);
  });

  it("accepts all optional fields", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Generate queries",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "sonnet",
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
      provider: "anthropic",
      model: "sonnet",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty message", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "sonnet",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing systemPrompt", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Hello",
      provider: "anthropic",
      model: "sonnet",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty systemPrompt", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "",
      provider: "anthropic",
      model: "sonnet",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing provider", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      model: "sonnet",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing model", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid responseFormat", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "sonnet",
      responseFormat: "xml",
    });
    expect(result.success).toBe(false);
  });

  it("rejects temperature out of range", () => {
    const below = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "sonnet",
      temperature: -0.1,
    });
    expect(below.success).toBe(false);

    const above = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "sonnet",
      temperature: 2.1,
    });
    expect(above.success).toBe(false);
  });

  it("rejects maxTokens out of range", () => {
    const zero = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "sonnet",
      maxTokens: 0,
    });
    expect(zero.success).toBe(false);

    const tooHigh = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "sonnet",
      maxTokens: 65000,
    });
    expect(tooHigh.success).toBe(false);
  });

  it("rejects non-integer maxTokens", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "sonnet",
      maxTokens: 1000.5,
    });
    expect(result.success).toBe(false);
  });

  // --- Provider + model validation ---

  it("accepts anthropic + haiku", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Extract metadata",
      systemPrompt: "You are a metadata extractor.",
      provider: "anthropic",
      model: "haiku",
    });
    expect(result.success).toBe(true);
  });

  it("accepts anthropic + sonnet", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "sonnet",
    });
    expect(result.success).toBe(true);
  });

  it("accepts anthropic + opus", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Complex reasoning task",
      systemPrompt: "You are a reasoning expert.",
      provider: "anthropic",
      model: "opus",
    });
    expect(result.success).toBe(true);
  });

  it("accepts google + flash-lite", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Analyze this image",
      systemPrompt: "You are an image classifier.",
      provider: "google",
      model: "flash-lite",
    });
    expect(result.success).toBe(true);
  });

  it("accepts google + flash", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Reason about this",
      systemPrompt: "You are helpful.",
      provider: "google",
      model: "flash",
    });
    expect(result.success).toBe(true);
  });

  it("accepts google + pro", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Complex analysis",
      systemPrompt: "You are an expert analyst.",
      provider: "google",
      model: "pro",
    });
    expect(result.success).toBe(true);
  });

  it("rejects anthropic + flash (wrong provider)", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "flash",
    });
    expect(result.success).toBe(false);
  });

  it("rejects anthropic + pro (wrong provider)", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "pro",
    });
    expect(result.success).toBe(false);
  });

  it("rejects anthropic + flash-lite (wrong provider)", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "flash-lite",
    });
    expect(result.success).toBe(false);
  });

  it("rejects google + sonnet (wrong provider)", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      provider: "google",
      model: "sonnet",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unsupported provider", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      provider: "openai",
      model: "gpt-4o",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unsupported model alias", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "gpt-4o",
    });
    expect(result.success).toBe(false);
  });

  it("accepts temperature at boundaries (0 and 2)", () => {
    const atZero = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "sonnet",
      temperature: 0,
    });
    expect(atZero.success).toBe(true);

    const atTwo = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "sonnet",
      temperature: 2,
    });
    expect(atTwo.success).toBe(true);
  });

  // --- Vision / imageUrl tests ---

  it("accepts google + flash-lite with imageUrl", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Score this image",
      systemPrompt: "You are an image scoring assistant.",
      provider: "google",
      model: "flash-lite",
      imageUrl: "https://example.com/images/hero.jpg",
      responseFormat: "json",
      temperature: 0,
      maxTokens: 1024,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.imageUrl).toBe("https://example.com/images/hero.jpg");
    }
  });

  it("accepts imageUrl with anthropic models", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Describe this image",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "sonnet",
      imageUrl: "https://example.com/photo.png",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.imageUrl).toBe("https://example.com/photo.png");
    }
  });

  it("rejects invalid imageUrl", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Analyze",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "sonnet",
      imageUrl: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("accepts request without imageUrl (vision is optional)", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Just text",
      systemPrompt: "You are helpful.",
      provider: "google",
      model: "flash-lite",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.imageUrl).toBeUndefined();
    }
  });

  // --- imageContext tests ---

  it("accepts imageContext with all fields", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Score this image",
      systemPrompt: "You are an image classifier.",
      provider: "google",
      model: "flash-lite",
      imageUrl: "https://example.com/hero.jpg",
      imageContext: {
        alt: "Company logo",
        title: "Our Brand Logo",
        sourceUrl: "https://example.com/about",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.imageContext).toEqual({
        alt: "Company logo",
        title: "Our Brand Logo",
        sourceUrl: "https://example.com/about",
      });
    }
  });

  it("accepts imageContext with partial fields", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Analyze",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "sonnet",
      imageUrl: "https://example.com/img.jpg",
      imageContext: { alt: "Team photo" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.imageContext?.alt).toBe("Team photo");
      expect(result.data.imageContext?.title).toBeUndefined();
      expect(result.data.imageContext?.sourceUrl).toBeUndefined();
    }
  });

  it("accepts empty imageContext object", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Analyze",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "sonnet",
      imageUrl: "https://example.com/img.jpg",
      imageContext: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.imageContext).toEqual({});
    }
  });

  it("accepts request without imageContext (optional)", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Analyze",
      systemPrompt: "You are helpful.",
      provider: "anthropic",
      model: "sonnet",
      imageUrl: "https://example.com/img.jpg",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.imageContext).toBeUndefined();
    }
  });
});

// --- resolveModel tests ---

describe("resolveModel", () => {
  it("resolves anthropic + haiku to claude-haiku-4-5", () => {
    const resolved = resolveModel("anthropic", "haiku");
    expect(resolved.apiModelId).toBe("claude-haiku-4-5");
    expect(resolved.costPrefix).toBe("anthropic-haiku-4.5");
    expect(resolved.provider).toBe("anthropic");
  });

  it("resolves anthropic + sonnet to claude-sonnet-4-6", () => {
    const resolved = resolveModel("anthropic", "sonnet");
    expect(resolved.apiModelId).toBe("claude-sonnet-4-6");
    expect(resolved.costPrefix).toBe("anthropic-sonnet-4.6");
    expect(resolved.provider).toBe("anthropic");
  });

  it("resolves anthropic + opus to claude-opus-4-6", () => {
    const resolved = resolveModel("anthropic", "opus");
    expect(resolved.apiModelId).toBe("claude-opus-4-6");
    expect(resolved.costPrefix).toBe("anthropic-opus-4.6");
    expect(resolved.provider).toBe("anthropic");
  });

  it("resolves google + flash-lite to gemini-3.1-flash-lite-preview", () => {
    const resolved = resolveModel("google", "flash-lite");
    expect(resolved.apiModelId).toBe("gemini-3.1-flash-lite-preview");
    expect(resolved.costPrefix).toBe("google-flash-lite-3.1");
    expect(resolved.provider).toBe("google");
  });

  it("resolves google + flash to gemini-3-flash-preview", () => {
    const resolved = resolveModel("google", "flash");
    expect(resolved.apiModelId).toBe("gemini-3-flash-preview");
    expect(resolved.costPrefix).toBe("google-flash-3");
    expect(resolved.provider).toBe("google");
  });

  it("resolves google + pro to gemini-3.1-pro-preview", () => {
    const resolved = resolveModel("google", "pro");
    expect(resolved.apiModelId).toBe("gemini-3.1-pro-preview");
    expect(resolved.costPrefix).toBe("google-pro-3.1");
    expect(resolved.provider).toBe("google");
  });

  it("throws for invalid provider", () => {
    expect(() => resolveModel("openai" as any, "sonnet")).toThrow();
  });

  it("throws for invalid model alias", () => {
    expect(() => resolveModel("anthropic", "flash-lite")).toThrow();
  });
});

// --- Gemini model helpers ---

describe("isGeminiModel", () => {
  it("returns true for gemini-3.1-flash-lite-preview", () => {
    expect(isGeminiModel("gemini-3.1-flash-lite-preview")).toBe(true);
  });

  it("returns true for gemini-3-flash-preview", () => {
    expect(isGeminiModel("gemini-3-flash-preview")).toBe(true);
  });

  it("returns true for gemini-3.1-pro-preview", () => {
    expect(isGeminiModel("gemini-3.1-pro-preview")).toBe(true);
  });

  it("returns false for anthropic models", () => {
    expect(isGeminiModel("claude-sonnet-4-6")).toBe(false);
    expect(isGeminiModel("claude-haiku-4-5")).toBe(false);
  });

  it("returns false for unknown models", () => {
    expect(isGeminiModel("gpt-4o")).toBe(false);
  });
});

describe("geminiCostPrefix", () => {
  it("returns correct prefix for gemini-3.1-flash-lite-preview", () => {
    expect(geminiCostPrefix("gemini-3.1-flash-lite-preview")).toBe("google-flash-lite-3.1");
  });

  it("returns correct prefix for gemini-3-flash-preview", () => {
    expect(geminiCostPrefix("gemini-3-flash-preview")).toBe("google-flash-3");
  });

  it("returns correct prefix for gemini-3.1-pro-preview", () => {
    expect(geminiCostPrefix("gemini-3.1-pro-preview")).toBe("google-pro-3.1");
  });
});

describe("costPrefixForModel", () => {
  it("returns correct prefix for gemini-3.1-flash-lite-preview", () => {
    expect(costPrefixForModel("gemini-3.1-flash-lite-preview")).toBe("google-flash-lite-3.1");
  });

  it("returns correct prefix for anthropic models", () => {
    expect(costPrefixForModel("claude-sonnet-4-6")).toBe("anthropic-sonnet-4.6");
    expect(costPrefixForModel("claude-haiku-4-5")).toBe("anthropic-haiku-4.5");
    expect(costPrefixForModel("claude-opus-4-6")).toBe("anthropic-opus-4.6");
  });

  it("returns correct prefix for all gemini models", () => {
    expect(costPrefixForModel("gemini-3-flash-preview")).toBe("google-flash-3");
    expect(costPrefixForModel("gemini-3.1-pro-preview")).toBe("google-pro-3.1");
  });
});
