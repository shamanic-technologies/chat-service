import { afterEach, describe, expect, it, vi } from "vitest";
import { readGeminiBilledTokens } from "../../src/lib/gemini-usage.js";
import { completeWithGemini, generateImageWithGemini, geminiCostPrefix } from "../../src/lib/gemini.js";
import { streamGeminiChat, type ToolDefinition } from "../../src/lib/gemini-chat.js";

// Raw usageMetadata captured from live Gemini calls on 2026-10-01 (project
// behind the platform key). Google bills thoughtsTokenCount at the output rate;
// candidatesTokenCount alone is only the visible answer.
const LIVE_PRO_THINKING = {
  promptTokenCount: 39,
  candidatesTokenCount: 9,
  totalTokenCount: 393,
  thoughtsTokenCount: 345,
};
const LIVE_FLASH_CACHED = {
  promptTokenCount: 9009,
  candidatesTokenCount: 6,
  totalTokenCount: 9286,
  cachedContentTokenCount: 4081,
  thoughtsTokenCount: 271,
};
const LIVE_FLASH_LITE_NO_THINKING = { promptTokenCount: 12, candidatesTokenCount: 45, totalTokenCount: 57 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("readGeminiBilledTokens", () => {
  it("bills thinking tokens as output (gemini-3.1-pro live payload)", () => {
    expect(readGeminiBilledTokens(LIVE_PRO_THINKING, "gemini-3.1-pro-preview", "google-pro-3.1")).toEqual({
      tokensInput: 39,
      tokensOutput: 354,
      costLines: [
        { costName: "google-pro-3.1-tokens-input", quantity: 39 },
        { costName: "google-pro-3.1-tokens-output", quantity: 354 },
      ],
    });
  });

  it("declares an implicit cache hit under the cached-input name, the rest as fresh input", () => {
    expect(readGeminiBilledTokens(LIVE_FLASH_CACHED, "gemini-3.8-flash", "google-flash-3.8")).toEqual({
      tokensInput: 9009,
      tokensOutput: 277,
      costLines: [
        { costName: "google-flash-3.8-tokens-input", quantity: 9009 - 4081 },
        { costName: "google-flash-3.8-tokens-cached-input", quantity: 4081 },
        { costName: "google-flash-3.8-tokens-output", quantity: 277 },
      ],
    });
  });

  it("is unchanged for a model that does not think", () => {
    expect(readGeminiBilledTokens(LIVE_FLASH_LITE_NO_THINKING, "gemini-3.5-flash-lite", "google-flash-lite-3.5")).toEqual({
      tokensInput: 12,
      tokensOutput: 45,
      costLines: [
        { costName: "google-flash-lite-3.5-tokens-input", quantity: 12 },
        { costName: "google-flash-lite-3.5-tokens-output", quantity: 45 },
      ],
    });
  });

  it("bills toolUsePromptTokenCount as input", () => {
    expect(
      readGeminiBilledTokens(
        { promptTokenCount: 100, toolUsePromptTokenCount: 50, candidatesTokenCount: 10, thoughtsTokenCount: 20, totalTokenCount: 180 },
        "gemini-3.1-pro-preview",
        "google-pro-3.1",
      ).tokensInput,
    ).toBe(150);
  });

  it("bills EVERY token of a Pro request whose prompt exceeds 200k at the long-context names", () => {
    const usage = {
      promptTokenCount: 250_000,
      cachedContentTokenCount: 50_000,
      candidatesTokenCount: 100,
      thoughtsTokenCount: 900,
      totalTokenCount: 251_000,
    };
    expect(readGeminiBilledTokens(usage, "gemini-3.1-pro-preview", "google-pro-3.1").costLines).toEqual([
      { costName: "google-pro-3.1-long-context-tokens-input", quantity: 200_000 },
      { costName: "google-pro-3.1-long-context-tokens-cached-input", quantity: 50_000 },
      { costName: "google-pro-3.1-long-context-tokens-output", quantity: 1_000 },
    ]);
  });

  it("keeps a prompt of exactly 200k on the standard names", () => {
    const usage = { promptTokenCount: 200_000, candidatesTokenCount: 10, totalTokenCount: 200_010 };
    expect(readGeminiBilledTokens(usage, "gemini-3.1-pro-preview", "google-pro-3.1").costLines[0].costName).toBe(
      "google-pro-3.1-tokens-input",
    );
  });

  it("has no long-context tier on Flash (Google prices none)", () => {
    const usage = { promptTokenCount: 300_000, candidatesTokenCount: 10, totalTokenCount: 300_010 };
    expect(readGeminiBilledTokens(usage, "gemini-3.8-flash", "google-flash-3.8").costLines[0].costName).toBe(
      "google-flash-3.8-tokens-input",
    );
  });

  it("splits Flash Image output into image tokens and text/thinking tokens (live payload)", () => {
    const usage = {
      promptTokenCount: 5,
      candidatesTokenCount: 1441,
      totalTokenCount: 1446,
      candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }],
    };
    expect(readGeminiBilledTokens(usage, "gemini-3.1-flash-image", "google-flash-image-3.1").costLines).toEqual([
      { costName: "google-flash-image-3.1-tokens-input", quantity: 5 },
      { costName: "google-flash-image-3.1-tokens-output", quantity: 1120 },
      { costName: "google-flash-image-3.1-tokens-text-output", quantity: 321 },
    ]);
  });

  it("fails loud on a cache hit for an image model Google publishes no cache rate for", () => {
    expect(() =>
      readGeminiBilledTokens(
        { promptTokenCount: 5000, cachedContentTokenCount: 4096, candidatesTokenCount: 10, totalTokenCount: 5010 },
        "gemini-3.1-flash-image",
        "google-flash-image-3.1",
      ),
    ).toThrow(/no cache rate/);
  });

  it("fails loud when the total holds tokens no known class accounts for", () => {
    expect(() =>
      readGeminiBilledTokens({ promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 99 }, "gemini-x", "google-x"),
    ).toThrow(/no known class accounts for.*totalTokenCount=99/);
  });

  it("logs the raw usageMetadata beside the declared lines", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    readGeminiBilledTokens(LIVE_PRO_THINKING, "gemini-3.1-pro-preview", "google-pro-3.1");
    expect(log).toHaveBeenCalledWith(
      `[gemini] billed usage | model=gemini-3.1-pro-preview | in=39 | out=354` +
        ` | lines=google-pro-3.1-tokens-input:39,google-pro-3.1-tokens-output:354` +
        ` | usageMetadata=${JSON.stringify(LIVE_PRO_THINKING)}`,
    );
  });

  it("returns zero when the response carries no usageMetadata", () => {
    expect(readGeminiBilledTokens(undefined, "gemini-x", "google-x")).toEqual({ tokensInput: 0, tokensOutput: 0, costLines: [] });
  });
});

describe("geminiCostPrefix", () => {
  it("prices the model Google served", () => {
    expect(geminiCostPrefix("gemini-3.1-pro-preview")).toBe("google-pro-3.1");
    expect(geminiCostPrefix("gemini-3.5-flash")).toBe("google-flash-3.5");
  });

  it("throws on a model with no catalog prefix instead of pricing it as another model", () => {
    expect(() => geminiCostPrefix("gemini-99-turbo")).toThrow(/no cost-name prefix/);
  });
});

describe("completeWithGemini (POST /complete, /internal/platform-complete)", () => {
  it("declares visible + thinking output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "The ball costs 5 cents." }] }, finishReason: "STOP" }],
          usageMetadata: LIVE_PRO_THINKING,
        }),
      })),
    );
    const result = await completeWithGemini({
      apiKey: "k",
      model: "gemini-3.1-pro-preview",
      message: "bat and ball",
      systemPrompt: "Be brief.",
    });
    expect(result.tokensInput).toBe(39);
    expect(result.tokensOutput).toBe(354);
  });
});

describe("generateImageWithGemini (image generation)", () => {
  it("declares visible + thinking output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            { content: { parts: [{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }] }, finishReason: "STOP" },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1441, thoughtsTokenCount: 200, totalTokenCount: 1646 },
        }),
      })),
    );
    const result = await generateImageWithGemini({ apiKey: "k", prompt: "a red circle" });
    expect(result.tokensInput).toBe(5);
    expect(result.tokensOutput).toBe(1641);
  });
});

/** A 200 SSE Response emitting one `data:` event per chunk. */
function sseResponse(chunks: unknown[]): Response {
  const payload = chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join("");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chatOptions() {
  return {
    apiKey: "k",
    model: "gemini-3.1-pro-preview",
    systemPrompt: "You are helpful.",
    history: [],
    userMessage: "List my audiences",
    tools: [
      { name: "list_audiences", description: "List audiences", input_schema: { type: "object" as const, properties: {} } },
    ] as ToolDefinition[],
    res: {} as never,
    sendSSE: () => {},
    executeTool: async () => ({ name: "list_audiences", result: { audiences: [] } }),
    signal: new AbortController().signal,
  };
}

describe("streamGeminiChat (POST /chat, streaming + tool loop)", () => {
  it("sums visible + thinking output over every turn, reading each turn's LAST chunk", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        // Turn 0: the model thinks, then calls a tool. Usage grows across chunks;
        // only the last chunk's usage is the turn's total.
        .mockResolvedValueOnce(
          sseResponse([
            {
              candidates: [{ content: { parts: [{ text: "planning", thought: true }] } }],
              usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 0, thoughtsTokenCount: 400, totalTokenCount: 450 },
            },
            {
              candidates: [{ content: { parts: [{ functionCall: { name: "list_audiences", args: {} } }] } }],
              usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 16, thoughtsTokenCount: 1098, totalTokenCount: 1164 },
            },
          ]),
        )
        // Turn 1: final answer after the tool result.
        .mockResolvedValueOnce(
          sseResponse([
            {
              candidates: [{ content: { parts: [{ text: "You have no audiences yet." }] }, finishReason: "STOP" }],
              usageMetadata: LIVE_PRO_THINKING,
            },
          ]),
        ),
    );
    const result = await streamGeminiChat(chatOptions());
    expect(result.tokensInput).toBe(50 + 39);
    expect(result.tokensOutput).toBe(16 + 1098 + 9 + 345);
    // One request per turn, summed by catalog name.
    expect(result.costLines).toEqual([
      { costName: "google-pro-3.1-tokens-input", quantity: 50 + 39 },
      { costName: "google-pro-3.1-tokens-output", quantity: 16 + 1098 + 9 + 345 },
    ]);
  });

  it("fails loud on a usage total it cannot price", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        sseResponse([
          {
            candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 500 },
          },
        ]),
      ),
    );
    await expect(streamGeminiChat(chatOptions())).rejects.toThrow(/no known class accounts for/);
  });
});
