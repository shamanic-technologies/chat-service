import { afterEach, describe, expect, it, vi } from "vitest";
import { generateImageWithGemini } from "../../src/lib/gemini.js";
import { GenerateImageRequestSchema } from "../../src/schemas.js";

describe("generateImageWithGemini", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the Gemini image model with small imageConfig by default and no maxOutputTokens", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: typeof input === "string" ? input : input.toString(),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        inlineData: {
                          mimeType: "image/png",
                          data: "iVBORw0KGgo=",
                        },
                      },
                    ],
                  },
                  finishReason: "STOP",
                },
              ],
              usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1290 },
            }),
        } as Response;
      }),
    );

    const result = await generateImageWithGemini({
      apiKey: "fake-key",
      prompt: "Generate a square avatar, no text.",
    });

    expect(result).toMatchObject({
      imageBase64: "iVBORw0KGgo=",
      mimeType: "image/png",
      model: "gemini-3.1-flash-image",
      tokensInput: 12,
      tokensOutput: 1290,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/models/gemini-3.1-flash-image:generateContent");
    expect(calls[0].body).toEqual({
      contents: [{ parts: [{ text: "Generate a square avatar, no text." }] }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { imageSize: "512", aspectRatio: "1:1" },
      },
    });
    expect(JSON.stringify(calls[0].body)).not.toContain("maxOutputTokens");
  });

  it("honors caller-selected image size", async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        inlineData: {
                          mimeType: "image/png",
                          data: "iVBORw0KGgo=",
                        },
                      },
                    ],
                  },
                  finishReason: "STOP",
                },
              ],
              usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 2000 },
            }),
        } as Response;
      }),
    );

    await generateImageWithGemini({
      apiKey: "fake-key",
      prompt: "Generate a detailed landscape.",
      size: "xlarge",
    });

    expect(calls[0].body).toMatchObject({
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { imageSize: "4K" },
      },
    });
  });

  it("forwards a caller-selected aspect ratio instead of the square default", async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              candidates: [
                {
                  content: { parts: [{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }] },
                  finishReason: "STOP",
                },
              ],
              usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 747 },
            }),
        } as Response;
      }),
    );

    await generateImageWithGemini({
      apiKey: "fake-key",
      prompt: "Generate a banner.",
      aspectRatio: "16:9",
    });

    expect(calls[0].body).toMatchObject({
      generationConfig: { imageConfig: { imageSize: "512", aspectRatio: "16:9" } },
    });
  });

  it("request schema accepts known aspect ratios and rejects others", () => {
    expect(GenerateImageRequestSchema.safeParse({ prompt: "x", aspectRatio: "9:16" }).success).toBe(true);
    expect(GenerateImageRequestSchema.safeParse({ prompt: "x" }).success).toBe(true);
    expect(GenerateImageRequestSchema.safeParse({ prompt: "x", aspectRatio: "7:3" }).success).toBe(false);
  });

  it("surfaces provider 4xx details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            '{"error":{"status":"INVALID_ARGUMENT","message":"Unsupported generation_config field"}}',
          ),
      } as Response)),
    );

    await expect(
      generateImageWithGemini({
        apiKey: "fake-key",
        prompt: "Generate an avatar.",
      }),
    ).rejects.toThrow(/Unsupported generation_config field/);
  });
});
