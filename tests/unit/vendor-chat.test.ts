import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CHAT-COST-1101 (probed live 2026-11-01 on deepseek-flash with the copilot's
 * 97 tools): `tool_choice: "none"` makes DeepSeek drop the tool definitions and
 * the model writes fake call markup (`<｜DSML｜ invoke name="read_skill">…`)
 * into the text the person receives. The final round and the silent-turn
 * re-ask must keep the tools declared and simply not run a call.
 */
const post = vi.fn();
vi.mock("../../src/lib/openai-compatible.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/openai-compatible.js")>();
  return { ...real, postVendorChatCompletion: (args: unknown) => post(args) };
});

const { streamVendorChat } = await import("../../src/lib/vendor-chat.js");
const { MAX_TOOL_CHAIN_DEPTH } = await import("../../src/lib/tool-budget.js");

const TOOLS = [{ name: "get_billing_account", description: "Balance", input_schema: { type: "object" as const, properties: {} } }];
const call = { id: "c", type: "function", function: { name: "get_billing_account", arguments: "{}" } };
const reply = (message: Record<string, unknown>) => ({
  model: "deepseek-flash",
  choices: [{ message, finish_reason: "stop" }],
  usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 900 },
});

function run(executeTool = vi.fn().mockResolvedValue({ name: "get_billing_account", result: {} })) {
  return {
    executeTool,
    out: streamVendorChat({
      vendor: "deepseek",
      apiKey: "k",
      model: "deepseek-flash",
      costPrefix: "deepseek-v4.1-flash",
      systemPrompt: "SYS",
      turnContext: "",
      history: [],
      userMessage: "How much is left?",
      tools: TOOLS,
      res: {} as never,
      sendSSE: () => {},
      executeTool,
      signal: new AbortController().signal,
      beforeProviderCall: async () => {},
    }),
  };
}

describe("streamVendorChat: never tool_choice none", () => {
  beforeEach(() => post.mockReset());

  it("keeps the tools declared on the final round and runs no call made there", async () => {
    post.mockResolvedValue(reply({ content: "", tool_calls: [call] }));
    const { out, executeTool } = run();
    const result = await out;
    for (const [args] of post.mock.calls) {
      expect(args.body.tool_choice).toBeUndefined();
      expect(args.body.tools).toHaveLength(1);
    }
    // MAX tool rounds run; the final round's call (and the re-ask's) does not.
    expect(executeTool).toHaveBeenCalledTimes(MAX_TOOL_CHAIN_DEPTH);
    expect(result.emittedInputRequest).toBe(false);
  });

  it("answers on the final round when the model writes text there", async () => {
    post.mockImplementation(async () => (post.mock.calls.length > MAX_TOOL_CHAIN_DEPTH ? reply({ content: "You have $4.12 left." }) : reply({ content: "", tool_calls: [call] })));
    const { out } = run();
    expect((await out).fullResponse).toBe("You have $4.12 left.");
  });
});

describe("streamVendorChat: the vendor's own request fields (SOPHIE-REFONTE-1102 model comparison)", () => {
  beforeEach(() => post.mockReset());

  it("caps output under the vendor's field name, and sends reasoning-off only when asked", async () => {
    post.mockResolvedValue(reply({ content: "Done." }));
    await run().out;
    expect(post.mock.calls[0][0].body.max_tokens).toBeGreaterThan(0);
    expect(post.mock.calls[0][0].reasoningDisabled).toBe(false);

    post.mockReset();
    post.mockResolvedValue({ ...reply({ content: "Done." }), model: "gpt-6.1-sol" });
    await streamVendorChat({
      vendor: "openai",
      apiKey: "k",
      model: "gpt-6.1-sol",
      costPrefix: "openai-gpt-6.1-sol",
      systemPrompt: "SYS",
      turnContext: "",
      history: [],
      userMessage: "Hi",
      tools: TOOLS,
      res: {} as never,
      sendSSE: () => {},
      executeTool: vi.fn(),
      signal: new AbortController().signal,
      beforeProviderCall: async () => {},
      reasoningDisabled: true,
    }).catch(() => undefined);
    const body = post.mock.calls[0][0].body;
    expect(body.max_completion_tokens).toBeGreaterThan(0);
    expect(body.max_tokens).toBeUndefined();
    expect(post.mock.calls[0][0].reasoningDisabled).toBe(true);
  });
});

describe("streamVendorChat: cache counts read where each vendor reports them (VENDOR-TOOLS-FOLLOWUP-1112)", () => {
  beforeEach(() => post.mockReset());

  function turn(vendor: "openai" | "moonshot", model: string, costPrefix: string) {
    return streamVendorChat({
      vendor, apiKey: "k", model, costPrefix, systemPrompt: "SYS", turnContext: "", history: [], userMessage: "Hi",
      tools: [], res: {} as never, sendSSE: () => {}, executeTool: vi.fn(), signal: new AbortController().signal,
      beforeProviderCall: async () => {},
    });
  }

  it("bills an OpenAI cache write under its own row", async () => {
    post.mockResolvedValue({ model: "gpt-6-astra", choices: [{ message: { content: "Hi." }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 } } });
    const r = await turn("openai", "gpt-6-astra", "openai-gpt-6-astra");
    const byName = Object.fromEntries(r.costLines.map((l) => [l.costName, l.quantity]));
    expect(byName["openai-gpt-6-astra-tokens-cached-input"]).toBe(600);
    expect(byName["openai-gpt-6-astra-tokens-cache-write"]).toBe(300);
    expect(byName["openai-gpt-6-astra-tokens-input"]).toBe(100);
  });

  it("reads Moonshot's flat cached count", async () => {
    post.mockResolvedValue({ model: "kimi-k3.1-pro", choices: [{ message: { content: "Hi." }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 5, cached_tokens: 800 } });
    const r = await turn("moonshot", "kimi-k3.1-pro", "moonshot-kimi-k3.1-pro");
    const byName = Object.fromEntries(r.costLines.map((l) => [l.costName, l.quantity]));
    expect(byName["moonshot-kimi-k3.1-pro-tokens-cached-input"]).toBe(800);
  });
});
