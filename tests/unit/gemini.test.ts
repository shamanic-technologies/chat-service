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
  UPDATE_WORKFLOW_TOOL,
  VALIDATE_WORKFLOW_TOOL,
  BUILTIN_TOOLS,
} from "../../src/lib/gemini.js";

const TEST_PROMPT = "You are a test assistant.";

describe("createGeminiClient", () => {
  beforeEach(() => {
    mockGenerateContentStream.mockResolvedValue(
      (async function* () {})(),
    );
  });

  it("defaults to gemini-3.1-pro-preview model", async () => {
    const client = createGeminiClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });
    const gen = client.streamChat([], "hello");
    for await (const _ of gen) {
      /* drain */
    }

    expect(mockGenerateContentStream).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-3.1-pro-preview" }),
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

describe("thinking events", () => {
  it("yields thinking_start, thinking_delta, thinking_stop for thought parts", async () => {
    mockGenerateContentStream.mockResolvedValue(
      (async function* () {
        yield {
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: "Let me think about this..." },
                ],
              },
            },
          ],
        };
        yield {
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: "I should check the data." },
                ],
              },
            },
          ],
        };
        yield {
          candidates: [
            {
              content: {
                parts: [{ text: "Here is my response." }],
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

    expect(events).toEqual([
      { type: "thinking_start" },
      { type: "thinking_delta", thinking: "Let me think about this..." },
      { type: "thinking_delta", thinking: "I should check the data." },
      { type: "thinking_stop" },
      { type: "token", content: "Here is my response." },
      { type: "done", usage: undefined },
    ]);
  });

  it("closes thinking block at end of stream if still open", async () => {
    mockGenerateContentStream.mockResolvedValue(
      (async function* () {
        yield {
          candidates: [
            {
              content: {
                parts: [{ thought: true, text: "Thinking..." }],
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

    expect(events).toEqual([
      { type: "thinking_start" },
      { type: "thinking_delta", thinking: "Thinking..." },
      { type: "thinking_stop" },
      { type: "done", usage: undefined },
    ]);
  });

  it("emits no thinking events when no thought parts present", async () => {
    mockGenerateContentStream.mockResolvedValue(
      (async function* () {
        yield {
          candidates: [
            {
              content: {
                parts: [{ text: "Direct response." }],
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

    expect(events).toEqual([
      { type: "token", content: "Direct response." },
      { type: "done", usage: undefined },
    ]);
  });

  it("yields thinking events in sendFunctionResult too", async () => {
    mockGenerateContentStream.mockResolvedValue(
      (async function* () {
        yield {
          candidates: [
            {
              content: {
                parts: [
                  { thought: true, text: "Processing the result..." },
                ],
              },
            },
          ],
        };
        yield {
          candidates: [
            {
              content: {
                parts: [{ text: "Based on the tool result..." }],
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
    for await (const event of client.sendFunctionResult(
      [],
      "tool",
      { data: "ok" },
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "thinking_start" },
      { type: "thinking_delta", thinking: "Processing the result..." },
      { type: "thinking_stop" },
      { type: "token", content: "Based on the tool result..." },
      { type: "done", usage: undefined },
    ]);
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

describe("chained function calls", () => {
  it("sendFunctionResult yields function_call events (enables chaining)", async () => {
    mockGenerateContentStream.mockResolvedValue(
      (async function* () {
        yield {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { name: "validate_workflow", args: { workflowId: "wf-1" } },
                    thoughtSignature: "sig_chain_123",
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
    const events = [];
    for await (const event of client.sendFunctionResult(
      [
        { role: "user", parts: [{ text: "update and validate" }] },
        {
          role: "model",
          parts: [
            {
              functionCall: { name: "update_workflow", args: { workflowId: "wf-1" } },
              thoughtSignature: "sig_first_abc",
            },
          ],
        },
      ],
      "update_workflow",
      { success: true },
    )) {
      events.push(event);
    }

    const fcEvent = events.find((e) => e.type === "function_call");
    expect(fcEvent).toBeDefined();
    expect(fcEvent!.type === "function_call" && fcEvent!.call.name).toBe("validate_workflow");
    expect(fcEvent!.type === "function_call" && fcEvent!.call.thoughtSignature).toBe("sig_chain_123");
  });

  it("passes incremental history including prior function calls to continuation", async () => {
    // Simulate: first call for streamChat returns update_workflow,
    // then sendFunctionResult should receive history with the prior call + response
    let capturedContents: unknown[] = [];

    mockGenerateContentStream.mockImplementation((opts: { contents: unknown[] }) => {
      capturedContents = opts.contents;
      return Promise.resolve(
        (async function* () {
          yield {
            candidates: [
              { content: { parts: [{ text: "All done!" }] } },
            ],
          };
        })(),
      );
    });

    const client = createGeminiClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });

    // Build history that mimics what processStream builds incrementally:
    // [userMessage, model(update_workflow+sig), user(functionResponse(update_workflow)),
    //  model(validate_workflow+sig)]
    const history = [
      { role: "user", parts: [{ text: "update and validate my workflow" }] },
      {
        role: "model",
        parts: [
          {
            functionCall: { name: "update_workflow", args: { workflowId: "wf-1" } },
            thoughtSignature: "sig_update_abc",
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "update_workflow",
              response: { result: { success: true } },
            },
          },
        ],
      },
      {
        role: "model",
        parts: [
          {
            functionCall: { name: "validate_workflow", args: { workflowId: "wf-1" } },
            thoughtSignature: "sig_validate_def",
          },
        ],
      },
    ];

    const gen = client.sendFunctionResult(
      history,
      "validate_workflow",
      { valid: true },
    );
    for await (const _ of gen) {
      /* drain */
    }

    // Verify the full history was passed to the API, including:
    // - The prior update_workflow call with thoughtSignature
    // - The prior update_workflow response
    // - The validate_workflow call with thoughtSignature
    // - The validate_workflow response (added by sendFunctionResult)
    expect(capturedContents).toHaveLength(5); // 4 history + 1 functionResponse

    // First model turn has update_workflow with thoughtSignature
    const modelTurn1 = capturedContents[1] as { role: string; parts: { functionCall?: unknown; thoughtSignature?: string }[] };
    expect(modelTurn1.role).toBe("model");
    expect(modelTurn1.parts[0]).toHaveProperty("thoughtSignature", "sig_update_abc");

    // Second model turn has validate_workflow with thoughtSignature
    const modelTurn2 = capturedContents[3] as { role: string; parts: { functionCall?: unknown; thoughtSignature?: string }[] };
    expect(modelTurn2.role).toBe("model");
    expect(modelTurn2.parts[0]).toHaveProperty("thoughtSignature", "sig_validate_def");

    // Last element is the functionResponse added by sendFunctionResult
    const lastContent = capturedContents[4] as { role: string; parts: { functionResponse?: unknown }[] };
    expect(lastContent.role).toBe("user");
    expect(lastContent.parts[0]).toHaveProperty("functionResponse");
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
      usage: { promptTokens: 10, outputTokens: 20, totalTokens: 30, searchQueryCount: 0 },
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
      usage: { promptTokens: 50, outputTokens: 100, totalTokens: 150, searchQueryCount: 0 },
    });
  });

  it("exposes model property", () => {
    const client = createGeminiClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });
    expect(client.model).toBe("gemini-3.1-pro-preview");
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

  it("includes context usage rules that reference the context keys", () => {
    const result = buildSystemPrompt("Base prompt.", {
      workflowId: "wf-123",
      brandUrl: "https://example.com",
    });
    expect(result).toContain("## IMPORTANT: Context Usage Rules");
    expect(result).toContain("workflowId, brandUrl");
    expect(result).toContain("Do NOT call request_user_input");
  });

  it("instructs LLM to use workflowId directly from context", () => {
    const result = buildSystemPrompt("Base prompt.", {
      workflowId: "wf-abc-123",
    });
    expect(result).toContain("wf-abc-123");
    expect(result).toContain("workflowId");
    expect(result).toContain("use them directly when calling tools");
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
    expect(props).toHaveProperty("value");
    expect(params.required).toEqual(["input_type", "label", "field"]);
  });

  it("description warns against using for confirmations", () => {
    expect(REQUEST_USER_INPUT_TOOL.description).toContain(
      "NEVER use this for confirmations",
    );
    expect(REQUEST_USER_INPUT_TOOL.description).toContain(
      "genuinely need information",
    );
  });
});

describe("UPDATE_WORKFLOW_TOOL", () => {
  it("has correct name and required workflowId parameter", () => {
    expect(UPDATE_WORKFLOW_TOOL.name).toBe("update_workflow");
    expect(UPDATE_WORKFLOW_TOOL.parameters).toBeDefined();

    const params = UPDATE_WORKFLOW_TOOL.parameters as Record<string, unknown>;
    const props = params.properties as Record<string, unknown>;
    expect(props).toHaveProperty("workflowId");
    expect(props).toHaveProperty("name");
    expect(props).toHaveProperty("description");
    expect(props).toHaveProperty("tags");
    expect(params.required).toEqual(["workflowId"]);
  });

  it("description instructs to use context workflowId directly", () => {
    expect(UPDATE_WORKFLOW_TOOL.description).toContain(
      "do not use input_request",
    );
  });
});

describe("VALIDATE_WORKFLOW_TOOL", () => {
  it("has correct name and required workflowId parameter", () => {
    expect(VALIDATE_WORKFLOW_TOOL.name).toBe("validate_workflow");
    const params = VALIDATE_WORKFLOW_TOOL.parameters as Record<string, unknown>;
    const props = params.properties as Record<string, unknown>;
    expect(props).toHaveProperty("workflowId");
    expect(params.required).toEqual(["workflowId"]);
  });
});

describe("BUILTIN_TOOLS", () => {
  it("includes all three built-in tools", () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    expect(names).toContain("request_user_input");
    expect(names).toContain("update_workflow");
    expect(names).toContain("validate_workflow");
    expect(BUILTIN_TOOLS).toHaveLength(3);
  });
});

describe("native Gemini tools (googleSearch + urlContext)", () => {
  beforeEach(() => {
    mockGenerateContentStream.mockResolvedValue(
      (async function* () {})(),
    );
  });

  it("uses googleSearch + urlContext when NO function tools are provided", async () => {
    const client = createGeminiClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });
    const gen = client.streamChat([], "hello");
    for await (const _ of gen) {
      /* drain */
    }

    const callArgs = mockGenerateContentStream.mock.calls.at(-1)?.[0];
    const tools = callArgs?.config?.tools;
    expect(tools).toEqual([
      { googleSearch: {} },
      { urlContext: {} },
    ]);
    expect(callArgs?.config?.toolConfig).toBeUndefined();
  });

  it("uses googleSearch + urlContext in sendFunctionResult when no tools", async () => {
    const client = createGeminiClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });
    const gen = client.sendFunctionResult([], "tool", { data: "ok" });
    for await (const _ of gen) {
      /* drain */
    }

    const callArgs = mockGenerateContentStream.mock.calls.at(-1)?.[0];
    const tools = callArgs?.config?.tools;
    expect(tools).toEqual([
      { googleSearch: {} },
      { urlContext: {} },
    ]);
  });

  it("uses ONLY functionDeclarations when function tools are provided (no googleSearch)", async () => {
    const client = createGeminiClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });
    const customTools = [
      { name: "my_tool", description: "test", parameters: {} },
    ];
    const gen = client.streamChat([], "hello", customTools);
    for await (const _ of gen) {
      /* drain */
    }

    const callArgs = mockGenerateContentStream.mock.calls.at(-1)?.[0];
    const tools = callArgs?.config?.tools;
    expect(tools).toEqual([{ functionDeclarations: customTools }]);
    // Must NOT contain googleSearch — Gemini rejects this combination
    expect(tools).not.toEqual(
      expect.arrayContaining([{ googleSearch: {} }]),
    );
  });

  it("uses ONLY functionDeclarations in sendFunctionResult when tools provided", async () => {
    const client = createGeminiClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });
    const customTools = [
      { name: "my_tool", description: "test", parameters: {} },
    ];
    const gen = client.sendFunctionResult([], "tool", { data: "ok" }, customTools);
    for await (const _ of gen) {
      /* drain */
    }

    const callArgs = mockGenerateContentStream.mock.calls.at(-1)?.[0];
    const tools = callArgs?.config?.tools;
    expect(tools).toEqual([{ functionDeclarations: customTools }]);
    expect(tools).not.toEqual(
      expect.arrayContaining([{ googleSearch: {} }]),
    );
  });
});

describe("grounding metadata — searchQueryCount", () => {
  it("reports searchQueryCount from groundingMetadata.webSearchQueries", async () => {
    mockGenerateContentStream.mockResolvedValue(
      (async function* () {
        yield {
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 20,
            totalTokenCount: 30,
          },
          candidates: [
            {
              content: { parts: [{ text: "Search results show..." }] },
              groundingMetadata: {
                webSearchQueries: [
                  "latest AI news",
                  "AI developments 2026",
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
    const events = [];
    for await (const event of client.streamChat([], "search for AI news")) {
      events.push(event);
    }

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toEqual({
      type: "done",
      usage: {
        promptTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        searchQueryCount: 2,
      },
    });
  });

  it("reports searchQueryCount 0 when no grounding metadata", async () => {
    mockGenerateContentStream.mockResolvedValue(
      (async function* () {
        yield {
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 10,
            totalTokenCount: 15,
          },
          candidates: [
            {
              content: { parts: [{ text: "Just a normal response." }] },
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

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toEqual({
      type: "done",
      usage: {
        promptTokens: 5,
        outputTokens: 10,
        totalTokens: 15,
        searchQueryCount: 0,
      },
    });
  });

  it("reports searchQueryCount from sendFunctionResult too", async () => {
    mockGenerateContentStream.mockResolvedValue(
      (async function* () {
        yield {
          usageMetadata: {
            promptTokenCount: 50,
            candidatesTokenCount: 100,
            totalTokenCount: 150,
          },
          candidates: [
            {
              content: { parts: [{ text: "Based on search..." }] },
              groundingMetadata: {
                webSearchQueries: ["company info"],
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
      usage: {
        promptTokens: 50,
        outputTokens: 100,
        totalTokens: 150,
        searchQueryCount: 1,
      },
    });
  });
});
