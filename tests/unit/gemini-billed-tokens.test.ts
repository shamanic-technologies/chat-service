import { afterEach, describe, expect, it, vi } from "vitest";
import { readGeminiBilledTokens } from "../../src/lib/gemini-usage.js";
import { completeWithGemini, generateImageWithGemini } from "../../src/lib/gemini.js";
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
    expect(readGeminiBilledTokens(LIVE_PRO_THINKING, "gemini-3.1-pro-preview")).toEqual({
      tokensInput: 39,
      tokensOutput: 354,
    });
  });

  it("keeps cachedContentTokenCount inside the prompt count, never adds it", () => {
    expect(readGeminiBilledTokens(LIVE_FLASH_CACHED, "gemini-3.8-flash")).toEqual({
      tokensInput: 9009,
      tokensOutput: 277,
    });
  });

  it("is unchanged for a model that does not think", () => {
    expect(readGeminiBilledTokens(LIVE_FLASH_LITE_NO_THINKING, "gemini-3.5-flash-lite")).toEqual({
      tokensInput: 12,
      tokensOutput: 45,
    });
  });

  it("bills toolUsePromptTokenCount as input", () => {
    expect(
      readGeminiBilledTokens(
        { promptTokenCount: 100, toolUsePromptTokenCount: 50, candidatesTokenCount: 10, thoughtsTokenCount: 20, totalTokenCount: 180 },
        "gemini-3.1-pro-preview",
      ),
    ).toEqual({ tokensInput: 150, tokensOutput: 30 });
  });

  it("fails loud when the total holds tokens no known class accounts for", () => {
    expect(() =>
      readGeminiBilledTokens({ promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 99 }, "gemini-x"),
    ).toThrow(/no known class accounts for.*totalTokenCount=99/);
  });

  it("logs the raw usageMetadata beside the declared tokens", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    readGeminiBilledTokens(LIVE_PRO_THINKING, "gemini-3.1-pro-preview");
    expect(log).toHaveBeenCalledWith(
      `[gemini] billed usage | model=gemini-3.1-pro-preview | in=39 | out=354 | usageMetadata=${JSON.stringify(LIVE_PRO_THINKING)}`,
    );
  });

  it("returns zero when the response carries no usageMetadata", () => {
    expect(readGeminiBilledTokens(undefined, "gemini-x")).toEqual({ tokensInput: 0, tokensOutput: 0 });
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
