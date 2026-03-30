import { describe, it, expect } from "vitest";
import { CompleteRequestSchema } from "../../src/schemas.js";
import { isGeminiModel, geminiCostPrefix, GEMINI_MODELS } from "../../src/lib/gemini.js";
import { costPrefixForModel, SUPPORTED_MODELS } from "../../src/lib/anthropic.js";

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

  it("accepts valid model override", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Extract metadata",
      systemPrompt: "You are a metadata extractor.",
      model: "claude-haiku-4-5",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe("claude-haiku-4-5");
    }
  });

  it("accepts default model explicitly", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      model: "claude-sonnet-4-6",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe("claude-sonnet-4-6");
    }
  });

  it("rejects unsupported model", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
      model: "gpt-4o",
    });
    expect(result.success).toBe(false);
  });

  it("defaults model to undefined when omitted", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Hello",
      systemPrompt: "You are helpful.",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBeUndefined();
    }
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

  // --- Vision / imageUrl tests ---

  it("accepts gemini-2.5-flash model", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Analyze this image",
      systemPrompt: "You are an image classifier.",
      model: "gemini-2.5-flash",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe("gemini-2.5-flash");
    }
  });

  it("accepts imageUrl with gemini-2.5-flash", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Score this image",
      systemPrompt: "You are an image scoring assistant.",
      model: "gemini-2.5-flash",
      imageUrl: "https://example.com/images/hero.jpg",
      responseFormat: "json",
      temperature: 0,
      maxTokens: 1024,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.imageUrl).toBe("https://example.com/images/hero.jpg");
      expect(result.data.model).toBe("gemini-2.5-flash");
    }
  });

  it("accepts imageUrl with anthropic models", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Describe this image",
      systemPrompt: "You are helpful.",
      model: "claude-sonnet-4-6",
      imageUrl: "https://example.com/photo.png",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.imageUrl).toBe("https://example.com/photo.png");
    }
  });

  it("accepts imageUrl without explicit model (defaults to claude)", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "What do you see?",
      systemPrompt: "You are helpful.",
      imageUrl: "https://example.com/img.jpg",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.imageUrl).toBe("https://example.com/img.jpg");
      expect(result.data.model).toBeUndefined();
    }
  });

  it("rejects invalid imageUrl", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Analyze",
      systemPrompt: "You are helpful.",
      imageUrl: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("accepts request without imageUrl (vision is optional)", () => {
    const result = CompleteRequestSchema.safeParse({
      message: "Just text",
      systemPrompt: "You are helpful.",
      model: "gemini-2.5-flash",
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
      model: "gemini-2.5-flash",
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
      imageUrl: "https://example.com/img.jpg",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.imageContext).toBeUndefined();
    }
  });
});

// --- Gemini model helpers ---

describe("isGeminiModel", () => {
  it("returns true for gemini-2.5-flash", () => {
    expect(isGeminiModel("gemini-2.5-flash")).toBe(true);
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
  it("returns correct prefix for gemini-2.5-flash", () => {
    expect(geminiCostPrefix("gemini-2.5-flash")).toBe("google-flash-2.5");
  });
});

describe("costPrefixForModel", () => {
  it("returns correct prefix for gemini-2.5-flash", () => {
    expect(costPrefixForModel("gemini-2.5-flash")).toBe("google-flash-2.5");
  });

  it("returns correct prefix for anthropic models", () => {
    expect(costPrefixForModel("claude-sonnet-4-6")).toBe("anthropic-sonnet-4.6");
    expect(costPrefixForModel("claude-haiku-4-5")).toBe("anthropic-haiku-4.5");
  });
});
