import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGenerateContentStream = vi.fn().mockResolvedValue(
  (async function* () {})()
);

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: {
      generateContentStream: mockGenerateContentStream,
    },
  })),
  Type: { OBJECT: "OBJECT", STRING: "STRING" },
  FunctionCallingConfigMode: { AUTO: "AUTO" },
  ThinkingLevel: { HIGH: "HIGH", LOW: "LOW", MEDIUM: "MEDIUM", MINIMAL: "MINIMAL" },
}));

import { createGeminiClient, REQUEST_USER_INPUT_TOOL } from "../../src/lib/gemini.js";

describe("createGeminiClient", () => {
  it("defaults to gemini-3-flash-preview model", async () => {
    const client = createGeminiClient({ apiKey: "test-key" });
    const gen = client.streamChat([], "hello");
    for await (const _ of gen) {
      /* drain */
    }

    expect(mockGenerateContentStream).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-3-flash-preview" })
    );
  });

  it("allows overriding the model", async () => {
    const client = createGeminiClient({
      apiKey: "test-key",
      model: "gemini-3-pro-preview",
    });
    const gen = client.streamChat([], "hello");
    for await (const _ of gen) {
      /* drain */
    }

    expect(mockGenerateContentStream).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-3-pro-preview" })
    );
  });

  it("enables thinking level HIGH", async () => {
    const client = createGeminiClient({ apiKey: "test-key" });
    const gen = client.streamChat([], "hello");
    for await (const _ of gen) {
      /* drain */
    }

    expect(mockGenerateContentStream).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          thinkingConfig: { thinkingLevel: "HIGH" },
        }),
      })
    );
  });
});

describe("sendFunctionResult", () => {
  beforeEach(() => {
    mockGenerateContentStream.mockResolvedValue(
      (async function* () {})()
    );
  });

  it("includes toolConfig when tools are provided", async () => {
    const client = createGeminiClient({ apiKey: "test-key" });
    const tools = [{ name: "test_tool", description: "test", parameters: {} }];
    const gen = client.sendFunctionResult([], "test_tool", { data: "ok" }, tools);
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
      })
    );
  });
});

describe("thoughtSignature preservation", () => {
  it("yields thoughtSignature from function call parts", async () => {
    mockGenerateContentStream.mockResolvedValue(
      (async function* () {
        yield {
          candidates: [{
            content: {
              parts: [{
                functionCall: { name: "test_fn", args: { x: 1 } },
                thoughtSignature: "sig_abc123",
              }],
            },
          }],
        };
      })()
    );

    const client = createGeminiClient({ apiKey: "test-key" });
    const tools = [{ name: "test_fn", description: "test", parameters: {} }];
    const events = [];
    for await (const event of client.streamChat([], "hello", tools)) {
      events.push(event);
    }

    const fcEvent = events.find((e) => e.type === "function_call");
    expect(fcEvent).toBeDefined();
    expect(fcEvent!.type === "function_call" && fcEvent!.call.thoughtSignature).toBe("sig_abc123");
  });

  it("omits thoughtSignature when not present", async () => {
    mockGenerateContentStream.mockResolvedValue(
      (async function* () {
        yield {
          candidates: [{
            content: {
              parts: [{
                functionCall: { name: "test_fn", args: {} },
              }],
            },
          }],
        };
      })()
    );

    const client = createGeminiClient({ apiKey: "test-key" });
    const events = [];
    for await (const event of client.streamChat([], "hello")) {
      events.push(event);
    }

    const fcEvent = events.find((e) => e.type === "function_call");
    expect(fcEvent).toBeDefined();
    expect(fcEvent!.type === "function_call" && fcEvent!.call.thoughtSignature).toBeUndefined();
  });
});

describe("REQUEST_USER_INPUT_TOOL", () => {
  it("has correct name and required parameters", () => {
    expect(REQUEST_USER_INPUT_TOOL.name).toBe("request_user_input");
    expect(REQUEST_USER_INPUT_TOOL.parameters).toBeDefined();

    const params = REQUEST_USER_INPUT_TOOL.parameters as Record<string, unknown>;
    const props = params.properties as Record<string, unknown>;
    expect(props).toHaveProperty("input_type");
    expect(props).toHaveProperty("label");
    expect(props).toHaveProperty("field");
    expect(props).toHaveProperty("placeholder");
    expect(params.required).toEqual(["input_type", "label", "field"]);
  });
});
