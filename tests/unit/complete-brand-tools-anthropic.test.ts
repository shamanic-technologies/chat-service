import { describe, it, expect, vi, beforeEach } from "vitest";

// brandTools on an Anthropic model (BRAND-MCP-1109 follow-up): Anthropic's own
// tool-use loop. The SDK's messages.stream is scripted: each call returns the
// next assistant message; every request body is captured.
const sdk = vi.hoisted(() => ({
  replies: [] as Array<Record<string, unknown> | Error>,
  requests: [] as Array<Record<string, unknown>>,
}));

vi.mock("@anthropic-ai/sdk", async (importActual) => {
  const actual = await importActual<typeof import("@anthropic-ai/sdk")>();
  class MockAnthropic {
    messages = {
      stream: vi.fn((params: Record<string, unknown>) => {
        sdk.requests.push(JSON.parse(JSON.stringify(params)));
        const next = sdk.replies.shift();
        return {
          finalMessage: async () => {
            if (!next) throw new Error("no scripted reply");
            if (next instanceof Error) throw next;
            return next;
          },
        };
      }),
    };
    static APIError = actual.default.APIError;
  }
  return { ...actual, default: MockAnthropic };
});

const { completeWithBrandTools, newBrandToolsSpend, NoOutputError, OUTPUT_TOOL_NAME } = await import("../../src/lib/complete-brand-tools.js");
import type { BrandToolset } from "../../src/lib/brand-mcp.js";

function reply(content: Array<Record<string, unknown>>, usage: Record<string, unknown> = { input_tokens: 100, output_tokens: 20 }, stop = "tool_use") {
  return { content, usage, stop_reason: stop };
}

const toolset: BrandToolset = {
  tools: [{ name: "crm__get_lead", description: "Read a lead in the brand's CRM.", input_schema: { type: "object", properties: { email: { type: "string" } } } }],
  servers: [{ id: "s", name: "crm", tools: 1 }],
  has: (n) => n === "crm__get_lead",
  call: vi.fn(async () => ({ ok: true, content: "Ava: 2 open deals" })),
};

const schema = { type: "object", properties: { decision: { type: "string" }, body: { type: "string" } }, required: ["decision"] };
const base = {
  provider: "anthropic" as const,
  apiKey: "k",
  model: "claude-opus-5-5",
  costPrefix: "anthropic-opus-5.5",
  systemPrompt: "Write to the lead.",
  message: "Lead Ava replied.",
  responseSchema: schema,
  toolset,
};

beforeEach(() => {
  sdk.replies.splice(0);
  sdk.requests.splice(0);
});

describe("brandTools on anthropic: its own tool-use loop", () => {
  it("runs ≥1 brand tool round, then returns the structured output; every round billed and passed to the cost hook", async () => {
    const thinking = { type: "thinking", thinking: "check the CRM first", signature: "sig-1" };
    sdk.replies.push(
      reply([thinking, { type: "tool_use", id: "tu_1", name: "crm__get_lead", input: { email: "ava@x.com" } }]),
      reply([{ type: "tool_use", id: "tu_2", name: OUTPUT_TOOL_NAME, input: { decision: "write", body: "Hi Ava" } }], { input_tokens: 300, output_tokens: 40 }),
    );
    const spend = newBrandToolsSpend();
    const beforeProviderCall = vi.fn(async () => undefined);
    const r = await completeWithBrandTools({ ...base, spend, beforeProviderCall });

    expect(JSON.parse(r.content)).toEqual({ decision: "write", body: "Hi Ava" });
    expect(r.toolCalls).toBe(1);
    expect(toolset.call).toHaveBeenCalledWith("crm__get_lead", { email: "ava@x.com" });
    expect(beforeProviderCall.mock.calls.map((c) => (c[0] as { depth: number }).depth)).toEqual([0, 1]);
    expect(r.tokensInput).toBe(400);
    expect(r.tokensOutput).toBe(60);
    // One catalog line per dimension, summed over the two rounds.
    expect(spend.lines).toEqual([
      { costName: "anthropic-opus-5.5-tokens-input", quantity: 400 },
      { costName: "anthropic-opus-5.5-tokens-output", quantity: 60 },
    ]);
    expect(r.costLines).toEqual(spend.lines);

    // Round 2 sends round 1's assistant message back verbatim (thinking + tool_use), then the tool result.
    const second = sdk.requests[1] as { messages: Array<{ role: string; content: unknown }>; tools: Array<{ name: string }> };
    expect(second.messages[1]).toEqual({ role: "assistant", content: [thinking, { type: "tool_use", id: "tu_1", name: "crm__get_lead", input: { email: "ava@x.com" } }] });
    const results = second.messages[2].content as Array<Record<string, unknown>>;
    expect(results[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_1" });
    expect(String(results[0].content)).toContain("2 open deals");
    expect(second.tools.map((t) => t.name)).toEqual(["crm__get_lead", OUTPUT_TOOL_NAME]);
    // The caller's schema IS the output tool's input.
    expect((second.tools[1] as unknown as { input_schema: unknown }).input_schema).toEqual(schema);
  });

  it("reasoning-first model: no sampling param is ever sent; effort turns on adaptive thinking; disableThinking lowers effort", async () => {
    sdk.replies.push(reply([{ type: "tool_use", id: "t", name: OUTPUT_TOOL_NAME, input: { decision: "skip" } }]));
    await completeWithBrandTools({ ...base, spend: newBrandToolsSpend(), effort: "medium", beforeProviderCall: async () => undefined });
    const req = sdk.requests[0];
    expect(req).not.toHaveProperty("temperature");
    expect(req).not.toHaveProperty("top_p");
    expect(req).not.toHaveProperty("top_k");
    expect(req.thinking).toEqual({ type: "adaptive" });
    expect(req.output_config).toEqual({ effort: "medium" });
    expect(req).not.toHaveProperty("tool_choice");

    sdk.replies.push(reply([{ type: "tool_use", id: "t", name: OUTPUT_TOOL_NAME, input: { decision: "skip" } }]));
    await completeWithBrandTools({ ...base, spend: newBrandToolsSpend(), disableThinking: true, beforeProviderCall: async () => undefined });
    expect(sdk.requests[1]).not.toHaveProperty("thinking");
    expect(sdk.requests[1].output_config).toEqual({ effort: "low" });
  });

  it("a temperature on a model that removed sampling is refused before any request", async () => {
    const spend = newBrandToolsSpend();
    const err = await completeWithBrandTools({ ...base, spend, temperature: 0.3, beforeProviderCall: async () => undefined }).catch((e) => e);
    expect(String(err)).toMatch(/sampling parameters/);
    expect(sdk.requests).toHaveLength(0);
    expect(spend.lines).toEqual([]);
  });

  it("webSearch rides beside the brand's tools (server tool, searches counted); imageUrl joins the message", async () => {
    sdk.replies.push(
      reply(
        [
          { type: "server_tool_use", id: "srv", name: "web_search", input: { query: "ava co" } },
          { type: "web_search_tool_result", tool_use_id: "srv", content: [{ type: "web_search_result", url: "https://ava.example", title: "Ava" }] },
          { type: "tool_use", id: "t", name: OUTPUT_TOOL_NAME, input: { decision: "write" } },
        ],
        { input_tokens: 100, output_tokens: 20, server_tool_use: { web_search_requests: 1 } },
      ),
    );
    const spend = newBrandToolsSpend();
    const r = await completeWithBrandTools({ ...base, spend, webSearch: true, imageUrl: "https://img.example/a.png", beforeProviderCall: async () => undefined });
    const req = sdk.requests[0] as { tools: Array<Record<string, unknown>>; messages: Array<{ content: unknown }> };
    expect(req.tools.at(-1)).toEqual({ type: "web_search_20250305", name: "web_search", max_uses: 1 });
    expect((req.messages[0].content as Array<Record<string, unknown>>)[0]).toEqual({ type: "image", source: { type: "url", url: "https://img.example/a.png" } });
    expect(r.searchCount).toBe(1);
    expect(spend.searchCount).toBe(1);
    expect(r.sources).toEqual([{ url: "https://ava.example", title: "Ava" }]);
  });

  it("stops without the output tool: re-asked once, then NoOutputError; both rounds stay in the ledger", async () => {
    sdk.replies.push(reply([{ type: "text", text: "Done." }], undefined, "end_turn"), reply([{ type: "text", text: "Still done." }], undefined, "end_turn"));
    const spend = newBrandToolsSpend();
    const err = await completeWithBrandTools({ ...base, spend, beforeProviderCall: async () => undefined }).catch((e) => e);
    expect(err).toBeInstanceOf(NoOutputError);
    expect(sdk.requests).toHaveLength(2);
    expect(JSON.stringify(sdk.requests[1].messages)).toContain(`call ${OUTPUT_TOOL_NAME} now`);
    expect(spend.lines).toEqual([
      { costName: "anthropic-opus-5.5-tokens-input", quantity: 200 },
      { costName: "anthropic-opus-5.5-tokens-output", quantity: 40 },
    ]);
  });

  it("a provider failure at round 2 keeps round 1 in the ledger (never undeclared)", async () => {
    sdk.replies.push(reply([{ type: "tool_use", id: "tu_1", name: "crm__get_lead", input: {} }]), new Error("invalid_request_error"));
    const spend = newBrandToolsSpend();
    const err = await completeWithBrandTools({ ...base, spend, beforeProviderCall: async () => undefined }).catch((e) => e);
    expect(String(err)).toContain("invalid_request_error");
    expect(spend.lines).toEqual([
      { costName: "anthropic-opus-5.5-tokens-input", quantity: 100 },
      { costName: "anthropic-opus-5.5-tokens-output", quantity: 20 },
    ]);
  });
});
