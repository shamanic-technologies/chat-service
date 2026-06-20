import { describe, it, expect, vi, afterEach } from "vitest";
import {
  toGeminiFunctionDeclarations,
  streamGeminiChat,
  type ToolDefinition,
} from "../../src/lib/gemini-chat.js";

describe("toGeminiFunctionDeclarations", () => {
  it("converts Anthropic-style tool definitions to Gemini format", () => {
    const tools: ToolDefinition[] = [
      {
        name: "get_weather",
        description: "Get the weather for a city",
        input_schema: {
          type: "object",
          properties: {
            city: { type: "string", description: "City name" },
            units: { type: "string", enum: ["celsius", "fahrenheit"] },
          },
          required: ["city"],
        },
      },
    ];

    const result = toGeminiFunctionDeclarations(tools);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("get_weather");
    expect(result[0].description).toBe("Get the weather for a city");
    expect(result[0].parameters.type).toBe("object");
    expect(result[0].parameters.properties).toEqual({
      city: { type: "string", description: "City name" },
      units: { type: "string", enum: ["celsius", "fahrenheit"] },
    });
    expect(result[0].parameters.required).toEqual(["city"]);
  });

  it("omits required when empty", () => {
    const tools: ToolDefinition[] = [
      {
        name: "list_items",
        description: "List all items",
        input_schema: {
          type: "object",
          properties: {},
        },
      },
    ];

    const result = toGeminiFunctionDeclarations(tools);
    expect(result[0].parameters.required).toBeUndefined();
  });

  it("converts multiple tools", () => {
    const tools: ToolDefinition[] = [
      {
        name: "tool_a",
        description: "Tool A",
        input_schema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
      },
      {
        name: "tool_b",
        description: "Tool B",
        input_schema: { type: "object", properties: { y: { type: "number" } } },
      },
    ];

    const result = toGeminiFunctionDeclarations(tools);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("tool_a");
    expect(result[1].name).toBe("tool_b");
  });

  it("handles empty tools array", () => {
    expect(toGeminiFunctionDeclarations([])).toEqual([]);
  });

  // Regression: Gemini's function-declaration `parameters` is the restricted
  // OpenAPI-3.0 Schema type and 400s on `additionalProperties` (and `$ref`,
  // `$schema`, etc.) carried by MCP tool input schemas. They must be stripped
  // recursively before sending. Reproduces the prod error:
  // `Unknown name "additionalProperties" at
  //  'tools[0].function_declarations[1].parameters.properties[0].value'`.
  it("strips additionalProperties nested in a property value", () => {
    const tools: ToolDefinition[] = [
      {
        name: "search_endpoints",
        description: "Search endpoints",
        input_schema: {
          type: "object",
          properties: {
            filters: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
          required: ["filters"],
        },
      },
    ];

    const result = toGeminiFunctionDeclarations(tools);
    const filters = result[0].parameters.properties.filters as Record<string, unknown>;

    expect(filters).not.toHaveProperty("additionalProperties");
    expect(filters.type).toBe("object");
    // Whole declaration must be free of the rejected keyword.
    expect(JSON.stringify(result)).not.toContain("additionalProperties");
    // required is preserved.
    expect(result[0].parameters.required).toEqual(["filters"]);
  });

  it("strips $ref / $schema recursively from tool param schemas", () => {
    const tools: ToolDefinition[] = [
      {
        name: "call_api",
        description: "Call an API",
        input_schema: {
          type: "object",
          properties: {
            body: { $ref: "#/components/schemas/OrgId", type: "object" },
          },
        },
        // @ts-expect-error — JSON-Schema 7 keyword not on the typed shape but present at runtime
        $schema: "http://json-schema.org/draft-07/schema#",
      } as ToolDefinition,
    ];

    const result = toGeminiFunctionDeclarations(tools);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("$ref");
    expect(serialized).not.toContain("$schema");
    const body = result[0].parameters.properties.body as Record<string, unknown>;
    expect(body.type).toBe("object");
  });

  it("preserves Gemini-supported keys (enum, description, nullable, items)", () => {
    const tools: ToolDefinition[] = [
      {
        name: "filter_list",
        description: "Filter a list",
        input_schema: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["open", "closed"], description: "Status" },
            tags: { type: "array", items: { type: "string" } },
            note: { type: "string", nullable: true },
          },
          required: ["status"],
        },
      },
    ];

    const result = toGeminiFunctionDeclarations(tools);
    expect(result[0].parameters.properties).toEqual({
      status: { type: "string", enum: ["open", "closed"], description: "Status" },
      tags: { type: "array", items: { type: "string" } },
      note: { type: "string", nullable: true },
    });
    expect(result[0].parameters.required).toEqual(["status"]);
  });
});

// ---------------------------------------------------------------------------
// streamGeminiChat — tool-then-empty must never surface as silence
// ---------------------------------------------------------------------------

/** Build a 200 SSE Response from a single JSON chunk (one `data:` event). */
function sseResponse(chunk: unknown): Response {
  const payload = `data: ${JSON.stringify(chunk)}\r\n\r\n`;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function baseOptions(overrides: Partial<Parameters<typeof streamGeminiChat>[0]> = {}) {
  const events: unknown[] = [];
  const opts = {
    apiKey: "test-key",
    model: "gemini-3-flash-preview",
    systemPrompt: "You are a helpful assistant.",
    history: [],
    userMessage: "Créer des audiences pour mon business",
    tools: [
      {
        name: "list_audiences",
        description: "List audiences for the current brand",
        input_schema: { type: "object" as const, properties: {} },
      },
    ] as ToolDefinition[],
    res: {} as never,
    sendSSE: (_res: unknown, data: unknown) => {
      events.push(data);
    },
    executeTool: async () => ({
      name: "list_audiences",
      result: { audiences: [{ id: "a1", name: "Founders" }] },
    }),
    signal: new AbortController().signal,
    ...overrides,
  };
  return { opts, events };
}

describe("streamGeminiChat tool-then-empty guard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("emits a fallback summary when the post-tool turn returns no text", async () => {
    // Turn 0: the model calls list_audiences. Turn 1: empty (MAX_TOKENS during
    // thinking) — no text parts. Without the guard this returns fullResponse:""
    // and the dashboard freezes on the tool card.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse({
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { name: "list_audiences", args: {} }, thoughtSignature: "sig-1" },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        }),
      )
      .mockResolvedValueOnce(
        sseResponse({
          candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 0 },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { opts, events } = baseOptions();
    const result = await streamGeminiChat(opts);

    // Tool ran...
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("list_audiences");
    // ...and the response is NOT silently empty — it summarizes the tool result.
    expect(result.fullResponse).not.toBe("");
    expect(result.fullResponse).toContain("list_audiences");
    expect(result.fullResponse).toContain("Founders");
    // The fallback text was streamed to the client as a token event.
    const tokenText = events
      .filter((e): e is { type: string; content: string } =>
        typeof e === "object" && e !== null && (e as { type?: string }).type === "token",
      )
      .map((e) => e.content)
      .join("");
    expect(tokenText).toContain("Founders");
  });

  it("still fails loud on a wholly-empty stream (no tools, no usage)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      sseResponse({ candidates: [{ content: { parts: [] } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { opts } = baseOptions({ tools: [] });
    await expect(streamGeminiChat(opts)).rejects.toThrow(/empty response/);
  });
});
