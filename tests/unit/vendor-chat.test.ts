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
