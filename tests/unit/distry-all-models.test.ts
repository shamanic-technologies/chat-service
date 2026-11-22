// DISTRY-ALL-MODELS-1122 (owner 2026-11-22 « tous ceux qu'on a dans chat-service »): every model
// chat-service can call is a /chat config option and a Distry choice, and a tool turn runs on each
// through the ONE direct-vendor loop (vendor-chat.ts): same request shape, tool round, billed lines.
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamVendorChat } from "../../src/lib/vendor-chat.js";
import { resolveModel, PROVIDER_MODELS, type Provider } from "../../src/lib/anthropic.js";
import { CHAT_CONFIG_MODELS_BY_PROVIDER, CHAT_CONFIG_PROVIDERS, PlatformConfigRequestSchema } from "../../src/schemas.js";
import { DYNASTY_PROVIDERS } from "../../src/lib/llm-dynasties.js";
import { defaultModelAliasFor } from "../../src/lib/config-defaults.js";
import { distryModelChoices } from "../../src/lib/intelligence-index.js";
import type { VendorId } from "../../src/lib/openai-compatible.js";

afterEach(() => vi.unstubAllGlobals());

describe("a /chat config may run on every provider chat-service calls", () => {
  it("lists every provider, and every name each one accepts", () => {
    expect([...CHAT_CONFIG_PROVIDERS].sort()).toEqual([...DYNASTY_PROVIDERS].sort());
    for (const p of CHAT_CONFIG_PROVIDERS) expect([...CHAT_CONFIG_MODELS_BY_PROVIDER[p]]).toEqual([...PROVIDER_MODELS[p]]);
  });

  it("accepts GLM, Kimi and GPT configs and refuses a name under the wrong provider", () => {
    const base = { key: "k", systemPrompt: "s", allowedTools: ["read_skill"] };
    for (const [provider, model] of [["zai", "glm"], ["moonshot", "kimi-pro"], ["openai", "gpt-terra"]] as const) {
      expect(PlatformConfigRequestSchema.safeParse({ ...base, provider, model }).success).toBe(true);
    }
    expect(PlatformConfigRequestSchema.safeParse({ ...base, provider: "zai", model: "gpt-terra" }).success).toBe(false);
  });

  it("gives every provider a default model it serves", () => {
    for (const p of CHAT_CONFIG_PROVIDERS) expect(() => resolveModel(p, defaultModelAliasFor(p))).not.toThrow();
    expect(defaultModelAliasFor("deepseek")).toBe("deepseek-flash");
  });

  it("puts GLM, Kimi and GPT in Distry's model panel", () => {
    const ids = distryModelChoices(CHAT_CONFIG_PROVIDERS).map((c) => c.modelId);
    for (const id of ["glm-5.3", "glm-5.3-flash", "kimi-k3.1-pro", "gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra"]) expect(ids).toContain(id);
  });
});

// One vendor answer per round: a tool call, then the answer. OpenAI Astra/Sol answer on the Responses API.
function vendorFetch(model: string, calls: Array<{ url: string; body: Record<string, unknown> }>) {
  return vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, body });
    const first = calls.length === 1;
    const responses = url.endsWith("/responses");
    const json = responses
      ? {
          model,
          status: "completed",
          output: first
            ? [{ type: "function_call", call_id: "c1", name: "get_order_status", arguments: '{"orderId":"B-7"}' }]
            : [{ type: "message", content: [{ type: "output_text", text: "Order B-7 is delayed." }] }],
          usage: { input_tokens: 400, output_tokens: 20, input_tokens_details: { cached_tokens: 0 } },
        }
      : {
          model,
          choices: [
            first
              ? { message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "get_order_status", arguments: '{"orderId":"B-7"}' } }] }, finish_reason: "tool_calls" }
              : { message: { content: "Order B-7 is delayed." }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 400, completion_tokens: 20 },
        };
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  });
}

const NEW_VENDOR_MODELS: Array<[VendorId, string]> = (["zai", "moonshot", "openai"] as const).flatMap((p) =>
  [...new Set(PROVIDER_MODELS[p].map((n) => resolveModel(p as Provider, n).apiModelId))].map((id) => [p, id] as [VendorId, string]),
);

describe("a tool turn on every newly enabled vendor model (mocked vendor)", () => {
  it.each(NEW_VENDOR_MODELS)("%s %s: calls the tool, answers, bills its own cost names", async (vendor, modelId) => {
    const m = resolveModel(vendor, modelId);
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vendorFetch(m.apiModelId, calls));
    const ran: string[] = [];
    const events: string[] = [];
    const result = await streamVendorChat({
      vendor,
      apiKey: "k",
      model: m.apiModelId,
      costPrefix: m.costPrefix,
      systemPrompt: "SYS",
      turnContext: "Today is 2026-11-22.",
      history: [{ role: "user", content: "A-1?" }, { role: "assistant", content: "Shipped.", toolCalls: [{ name: "get_order_status", args: { orderId: "A-1" }, result: { status: "shipped" } }] }],
      userMessage: "And B-7?",
      tools: [{ name: "get_order_status", description: "Order status", input_schema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] } }],
      res: {} as never,
      sendSSE: (_r, d) => events.push((d as { type: string }).type),
      executeTool: async ({ name, args }) => {
        ran.push(`${name}:${JSON.stringify(args)}`);
        return { name, result: { status: "delayed" } };
      },
      signal: new AbortController().signal,
      beforeProviderCall: async () => {},
    });
    expect(ran).toEqual(['get_order_status:{"orderId":"B-7"}']);
    expect(result.fullResponse).toBe("Order B-7 is delayed.");
    expect(events).toEqual(expect.arrayContaining(["tool_call", "tool_result", "token"]));
    expect(calls).toHaveLength(2);
    // Tools are declared on every round, tool_choice never sent.
    for (const c of calls) {
      expect(c.body.tool_choice).toBeUndefined();
      expect(Array.isArray(c.body.tools)).toBe(true);
    }
    // Every round billed under this model's own catalog names.
    expect(result.costLines.length).toBeGreaterThan(0);
    for (const l of result.costLines) expect(l.costName.startsWith(`${m.costPrefix}-`)).toBe(true);
  });
});
