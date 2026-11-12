import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fromResponsesBody,
  postVendorChatCompletion,
  toResponsesRequest,
  usesResponsesApi,
  VENDORS,
} from "../../src/lib/openai-compatible.js";

/**
 * VENDOR-TOOLS-FOLLOWUP-1112 (probed live 2026-11-12): gpt-6-astra and
 * gpt-6.1-sol refuse function tools on /v1/chat/completions at every reasoning
 * effort they accept; /v1/responses runs them at effort "low". A tool round on
 * those two goes to /responses, translated both ways; everything else stays put.
 */
const TOOLS = [{ type: "function", function: { name: "get_brand", description: "The brand", parameters: { type: "object", properties: { id: { type: "string" } } } } }];

function toolRound(model: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: "system", content: "SYS" },
      { role: "user", content: "Write it." },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "get_brand", arguments: "{\"id\":\"b\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "{\"name\":\"Reed\"}" },
    ],
    stream: false,
    max_completion_tokens: 32000,
    tools: TOOLS,
    ...extra,
  };
}

describe("which requests go to the Responses API", () => {
  it("a tool round on Astra and Sol, nothing else", () => {
    expect(usesResponsesApi("openai", "gpt-6-astra", toolRound("gpt-6-astra"))).toBe(true);
    expect(usesResponsesApi("openai", "gpt-6.1-sol", toolRound("gpt-6.1-sol"))).toBe(true);
    // Terra takes tools on chat/completions at reasoning_effort none.
    expect(usesResponsesApi("openai", "gpt-6.1-terra", toolRound("gpt-6.1-terra"))).toBe(false);
    // No tools: the plain call stays on chat/completions.
    const { tools: _t, ...plain } = toolRound("gpt-6-astra");
    expect(usesResponsesApi("openai", "gpt-6-astra", plain)).toBe(false);
    expect(usesResponsesApi("deepseek", "deepseek-flash", toolRound("deepseek-flash"))).toBe(false);
    expect(usesResponsesApi("zai", "glm-5.3", toolRound("glm-5.3"))).toBe(false);
    expect(usesResponsesApi("moonshot", "kimi-k3.1-pro", toolRound("kimi-k3.1-pro"))).toBe(false);
  });

  it("only OpenAI lists models", () => {
    expect(VENDORS.deepseek.toolRoundsOnResponsesApi).toBeUndefined();
    expect(VENDORS.zai.toolRoundsOnResponsesApi).toBeUndefined();
    expect(VENDORS.moonshot.toolRoundsOnResponsesApi).toBeUndefined();
  });
});

describe("toResponsesRequest: the request shape per model", () => {
  it.each(["gpt-6-astra", "gpt-6.1-sol"])("%s: tools flat, effort low under reasoning, calls without ids", (model) => {
    const out = toResponsesRequest(toolRound(model, { reasoning_effort: "low" }));
    expect(out).toEqual({
      store: false,
      model,
      input: [
        { role: "system", content: "SYS" },
        { role: "user", content: "Write it." },
        { type: "function_call", call_id: "call_1", name: "get_brand", arguments: "{\"id\":\"b\"}" },
        { type: "function_call_output", call_id: "call_1", output: "{\"name\":\"Reed\"}" },
      ],
      max_output_tokens: 32000,
      tools: [{ type: "function", name: "get_brand", description: "The brand", parameters: { type: "object", properties: { id: { type: "string" } } } }],
      reasoning: { effort: "low" },
    });
  });

  it("maps photos and structured output", () => {
    const out = toResponsesRequest({
      model: "gpt-6-astra",
      messages: [{ role: "user", content: [{ type: "text", text: "What is it?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }],
      response_format: { type: "json_schema", json_schema: { name: "response", schema: { type: "object" } } },
    });
    expect(out.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "What is it?" }, { type: "input_image", image_url: "data:image/png;base64,AA" }] }]);
    expect(out.text).toEqual({ format: { type: "json_schema", name: "response", schema: { type: "object" } } });
  });

  it("refuses a field it has no mapping for, rather than dropping it", () => {
    expect(() => toResponsesRequest({ model: "gpt-6-astra", messages: [], top_p: 0.9 })).toThrow(/top_p/);
  });
});

describe("fromResponsesBody: the answer in the chat-completions shape", () => {
  it("tool calls, text, usage with both cache counts", () => {
    const body = fromResponsesBody({
      model: "gpt-6-astra",
      status: "completed",
      output: [
        { type: "reasoning" },
        { type: "message", content: [{ type: "output_text", text: "Hello" }] },
        { type: "function_call", call_id: "call_9", name: "get_brand", arguments: "{}" },
      ],
      usage: { input_tokens: 100, output_tokens: 18, input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 } },
    });
    expect(body.model).toBe("gpt-6-astra");
    expect(body.choices?.[0]).toEqual({
      message: { content: "Hello", tool_calls: [{ id: "call_9", type: "function", function: { name: "get_brand", arguments: "{}" } }] },
      finish_reason: "tool_calls",
    });
    expect(VENDORS.openai.readCachedTokens(body.usage!)).toBe(40);
    expect(VENDORS.openai.readCacheWriteTokens?.(body.usage!)).toBe(10);
    expect(body.usage?.prompt_tokens).toBe(100);
    expect(body.usage?.completion_tokens).toBe(18);
  });

  it("a cut answer reads as finish_reason length", () => {
    const body = fromResponsesBody({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] });
    expect(body.choices?.[0].finish_reason).toBe("length");
  });
});

describe("postVendorChatCompletion: one transport, two endpoints", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts a tool round on Astra to /responses and reads its answer back", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ model: "gpt-6-astra", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }], usage: { input_tokens: 5, output_tokens: 2 } }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await postVendorChatCompletion({ vendor: "openai", apiKey: "k", model: "gpt-6-astra", body: toolRound("gpt-6-astra"), reasoningDisabled: false });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/responses");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).input).toBeDefined();
    expect(out.choices?.[0].message?.content).toBe("{}");
  });

  it("keeps Terra's tool round and every plain call on /chat/completions", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ model: "gpt-6.1-terra", choices: [] }) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await postVendorChatCompletion({ vendor: "openai", apiKey: "k", model: "gpt-6.1-terra", body: toolRound("gpt-6.1-terra"), reasoningDisabled: false });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/chat/completions");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages).toBeDefined();
  });
});
