import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGenerateContentStream = vi
  .fn()
  .mockResolvedValue((async function* () {})());

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: {
      generateContentStream: mockGenerateContentStream,
    },
  })),
  Type: { OBJECT: "OBJECT", STRING: "STRING" },
  FunctionCallingConfigMode: { AUTO: "AUTO" },
  ThinkingLevel: {
    HIGH: "HIGH",
    LOW: "LOW",
    MEDIUM: "MEDIUM",
    MINIMAL: "MINIMAL",
  },
}));

import {
  createGeminiClient,
  buildSystemPrompt,
  REQUEST_USER_INPUT_TOOL,
} from "../../src/lib/gemini.js";

const TEST_PROMPT = "You are a test assistant.";

describe("createGeminiClient", () => {
  beforeEach(() => {
    mockGenerateContentStream.mockResolvedValue(
      (async function* () {})(),
    );
  });

  it("defaults to gemini-3-flash-preview model", async () => {
    const client = createGeminiClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });
    const gen = client.streamChat([], "hello");
    for await (const _ of gen) {
      /* drain */
    }

    expect(mockGenerateContentStream).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-3-flash-preview" }),
    );
  });

  it("allows overriding the model", async () => {
    const client = createGeminiClient({
      apiKey: "test-key",
      model: "gemini-3-pro-preview",
      systemPrompt: TEST_PROMPT,
    });
    const gen = client.streamChat([], "hello");
    for await (const _ of gen) {
      /* drain */
    }

    expect(mockGenerateContentStream).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-3-pro-preview" }),
    );
  });

  it("enables thinking level HIGH", async () => {
    const client = createGeminiClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });
    const gen = client.streamChat([], "hello");
    for await (const _ of gen) {
      /* drain */
    }

    expect(mockGenerateContentStream).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          thinkingConfig: { thinkingLevel: "HIGH" },
        }),
      }),
    );
  });

  it("passes provided systemPrompt to Gemini", async () => {
    const client = createGeminiClient({
      apiKey: "test-key",
      systemPrompt: "You are a cold email assistant.",
    });
    const gen = client.streamChat([], "hello");
    for await (const _ of gen) {
      /* drain */
    }

    const callArgs = mockGenerateContentStream.mock.calls.at(-1)?.[0];
    expect(callArgs?.config?.systemInstruction).toBe(
      "You are a cold email assistant.",
    );
  });

  it("uses systemPrompt in sendFunctionResult too", async () => {
    const client = createGeminiClient({
      apiKey: "test-key",
      systemPrompt: "Custom prompt for function results.",
    });
    const gen = client.sendFunctionResult([], "tool", { data: "ok" });
    for await (const _ of gen) {
      /* drain */
    }

    const callArgs = mockGenerateContentStream.mock.calls.at(-1)?.[0];
    expect(callArgs?.config?.systemInstruction).toBe(
      "Custom prompt for function results.",
    );
  });
});

describe("sendFunctionResult", () => {
  beforeEach(() => {
    mockGenerateContentStream.mockResolvedValue(
      (async function* () {})(),
    );
  });

  it("includes toolConfig when tools are provided", async () => {
    const client = createGeminiClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });
    const tools = [
      { name: "test_tool", description: "test", parameters: {} },
    ];
    const gen = client.sendFunctionResult(
      [],
      "test_tool",
      { data: "ok" },
      tools,
    );
    for await (const _ of gen) {
      /* drain */
    }

    expect(mockGenerateContentStream).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          toolConfig: {
            functionCallingConfig: { mode: "AUTO" },
          },
        }),
      }),
    );
  });
});

describe("thoughtSignature preservation", () => {
  it("yields thoughtSignature from function call parts", async () => {
    mockGenerateContentStream.mockResolvedValue(
      (async function* () {
        yield {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { name: "test_fn", args: { x: 1 } },
                    thoughtSignature: "sig_abc123",
                  },
                ],
              },
            },
          ],
        };
      })(),
    );

    const client = createGeminiClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });
    const tools = [
      { name: "test_fn", description: "test", parameters: {} },
    ];
    const events = [];
    for await (const event of client.streamChat([], "hello", tools)) {
      events.push(event);
    }

    const fcEvent = events.find((e) => e.type === "function_call");
    expect(fcEvent).toBeDefined();
    expect(
      fcEvent!.type === "function_call" && fcEvent!.call.thoughtSignature,
    ).toBe("sig_abc123");
  });

  it("omits thoughtSignature when not present", async () => {
    mockGenerateContentStream.mockResolvedValue(
      (async function* () {
        yield {
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: "test_fn", args: {} } }],
              },
            },
          ],
        };
      })(),
    );

    const client = createGeminiClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });
    const events = [];
    for await (const event of client.streamChat([], "hello")) {
      events.push(event);
    }

    const fcEvent = events.find((e) => e.type === "function_call");
    expect(fcEvent).toBeDefined();
    expect(
      fcEvent!.type === "function_call" && fcEvent!.call.thoughtSignature,
    ).toBeUndefined();
  });
});

describe("usage metadata", () => {
  it("includes usage in done event from streamChat", async () => {
    mockGenerateContentStream.mockResolvedValue(
      (async function* () {
        yield {
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 20,
            totalTokenCount: 30,
          },
          candidates: [{ content: { parts: [{ text: "hi" }] } }],
        };
      })(),
    );

    const client = createGeminiClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });
    const events = [];
    for await (const event of client.streamChat([], "hello")) {
      events.push(event);
    }

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toEqual({
      type: "done",
      usage: { promptTokens: 10, outputTokens: 20, totalTokens: 30 },
    });
  });

  it("includes usage in done event from sendFunctionResult", async () => {
    mockGenerateContentStream.mockResolvedValue(
      (async function* () {
        yield {
          usageMetadata: {
            promptTokenCount: 50,
            candidatesTokenCount: 100,
            totalTokenCount: 150,
          },
          candidates: [{ content: { parts: [{ text: "result" }] } }],
        };
      })(),
    );

    const client = createGeminiClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });
    const events = [];
    for await (const event of client.sendFunctionResult(
      [],
      "tool",
      { data: "ok" },
    )) {
      events.push(event);
    }

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toEqual({
      type: "done",
      usage: { promptTokens: 50, outputTokens: 100, totalTokens: 150 },
    });
  });

  it("exposes model property", () => {
    const client = createGeminiClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });
    expect(client.model).toBe("gemini-3-flash-preview");
  });
});

describe("buildSystemPrompt", () => {
  it("returns base prompt when no context", () => {
    expect(buildSystemPrompt("You are helpful.")).toBe("You are helpful.");
  });

  it("returns base prompt when context is empty object", () => {
    expect(buildSystemPrompt("You are helpful.", {})).toBe(
      "You are helpful.",
    );
  });

  it("appends context section when context is provided", () => {
    const result = buildSystemPrompt("You are helpful.", {
      brandUrl: "https://example.com",
    });
    expect(result).toContain("You are helpful.");
    expect(result).toContain("## Additional Context (this request only)");
    expect(result).toContain("https://example.com");
  });
});

describe("REQUEST_USER_INPUT_TOOL", () => {
  it("has correct name and required parameters", () => {
    expect(REQUEST_USER_INPUT_TOOL.name).toBe("request_user_input");
    expect(REQUEST_USER_INPUT_TOOL.parameters).toBeDefined();

    const params = REQUEST_USER_INPUT_TOOL.parameters as Record<
      string,
      unknown
    >;
    const props = params.properties as Record<string, unknown>;
    expect(props).toHaveProperty("input_type");
    expect(props).toHaveProperty("label");
    expect(props).toHaveProperty("field");
    expect(props).toHaveProperty("placeholder");
    expect(params.required).toEqual(["input_type", "label", "field"]);
  });
});
