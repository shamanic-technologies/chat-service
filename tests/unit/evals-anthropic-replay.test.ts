// SOPHIE-MODEL-BAKEOFF-1113: a Claude model in the eval replay runs on the
// request /chat's Anthropic path sends (Sophie's Haiku backup), never on a
// thinking-less mini-loop. The 2026-11-11 bake-off compared DeepSeek on the real
// /chat loop with Claude on a different request: no thinking block, history as
// text, photos refused. These tests pin the request body the replay builds.
import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: Array<{ params: Record<string, unknown>; headers: Record<string, string> }> = [];
let replies: Array<Record<string, unknown>> = [];

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      stream: (params: Record<string, unknown>, opts?: { headers?: Record<string, string> }) => {
        sent.push({ params: structuredClone(params), headers: opts?.headers ?? {} });
        const reply = replies.shift();
        if (!reply) throw new Error("no scripted reply left");
        return { finalMessage: async () => reply };
      },
    };
  }
  return { default: FakeAnthropic };
});

const { replayAnthropicTurn } = await import("../../src/evals/anthropic-replay.js");
const { readWireSettings } = await import("../../src/evals/wire.js");

const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const textReply = (text: string) => ({ stop_reason: "end_turn", content: [{ type: "text", text }], usage });
const toolReply = (name: string, id = "toolu_x") => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input: {} }], usage });

const TOOL = { name: "find_operation", description: "Find an operation", input_schema: { type: "object", properties: {} } };

function base(overrides: Partial<Parameters<typeof replayAnthropicTurn>[0]> = {}) {
  return {
    apiKey: "k",
    model: "claude-haiku-5-5",
    costPrefix: "anthropic-haiku-5.5",
    systemPrompt: "You are Sophie.",
    turnContext: "## Where this account stands\nAll good.",
    history: [] as Parameters<typeof replayAnthropicTurn>[0]["history"],
    userMessage: "How is my campaign doing?",
    tools: [TOOL] as never,
    executeTool: vi.fn(async ({ name }: { name: string }) => ({ name, result: { ok: true } })) as never,
    holdTextBesideToolCalls: true,
    beforeProviderCall: async () => undefined,
    ...overrides,
  };
}

beforeEach(() => {
  sent.length = 0;
  replies = [];
});

describe("replayAnthropicTurn sends the /chat Anthropic request", () => {
  it("adaptive thinking, context management and betas as /chat; no effort when none is stated (the copilot config's NULL)", async () => {
    replies = [textReply("Doing well.")];
    const r = await replayAnthropicTurn(base());
    expect(r.fullResponse).toBe("Doing well.");
    const { params, headers } = sent[0];
    expect(params.thinking).toEqual({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    expect(params.output_config).toBeUndefined();
    expect(params.context_management).toBeDefined();
    expect(params.model).toBe("claude-haiku-5-5");
    expect(headers["anthropic-beta"]).toContain("thinking-binding-controls");
  });

  it("a stated effort goes on the wire as output_config.effort", async () => {
    replies = [textReply("ok")];
    await replayAnthropicTurn(base({ effort: "low" }));
    expect(sent[0].params.output_config).toEqual({ effort: "low" });
  });

  it("replays stored tool calls as tool_use / tool_result pairs, never as text", async () => {
    replies = [textReply("ok")];
    await replayAnthropicTurn(
      base({
        history: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Here it is.", toolCalls: [{ name: "find_operation", args: { q: "x" }, result: { found: 1 } }] as never },
        ],
      }),
    );
    const messages = sent[0].params.messages as Array<{ role: string; content: unknown }>;
    const flat = JSON.stringify(messages);
    expect(flat).toContain('"type":"tool_use"');
    expect(flat).toContain('"type":"tool_result"');
  });

  it("the person's photos go in as image blocks (Haiku reads them in production)", async () => {
    replies = [textReply("Nice logo.")];
    await replayAnthropicTurn(base({ images: [{ mimeType: "image/png", base64: "AAAA", width: 10, height: 10 }] }));
    expect(JSON.stringify(sent[0].params.messages)).toContain('"type":"image"');
  });

  it("a turn that runs tools until the budget is spent gets a final round with tools off and the note", async () => {
    replies = [...Array.from({ length: 10 }, (_, i) => toolReply("find_operation", `toolu_${i}`)), textReply("Here is what I found.")];
    const r = await replayAnthropicTurn(base());
    expect(r.fullResponse).toBe("Here is what I found.");
    expect(sent).toHaveLength(11);
    expect(sent[10].params.tool_choice).toEqual({ type: "none" });
    expect(sent[9].params.tool_choice).toBeUndefined();
  });

  it("a turn that ran tools and ended silent is re-asked once, tools off", async () => {
    replies = [toolReply("find_operation"), textReply(""), textReply("Answer.")];
    const r = await replayAnthropicTurn(base());
    expect(r.fullResponse).toBe("Answer.");
    expect(sent[2].params.tool_choice).toEqual({ type: "none" });
  });

  it("a lead turn never switches tools off and is re-asked once to call its end tool", async () => {
    const executeTool = vi.fn(async ({ name }: { name: string }) => (name === "answer_person" ? "input_request" : { name, result: {} }));
    replies = [textReply("I would say hi."), toolReply("answer_person")];
    await replayAnthropicTurn(base({ endToolName: "answer_person", executeTool: executeTool as never, tools: [TOOL, { ...TOOL, name: "answer_person" }] as never }));
    expect(sent).toHaveLength(2);
    expect(sent[1].params.tool_choice).toBeUndefined();
    expect(JSON.stringify(sent[1].params.messages)).toContain("You ended your turn without calling answer_person");
  });

  it("a failing tool reaches the model as a formatted error flagged is_error", async () => {
    const executeTool = vi.fn(async () => {
      throw new Error("boom");
    });
    replies = [toolReply("find_operation"), textReply("Sorry.")];
    const r = await replayAnthropicTurn(base({ executeTool: executeTool as never }));
    expect(r.toolCalls[0].result).toMatchObject({ tool: "find_operation" });
    expect(JSON.stringify(sent[1].params.messages)).toContain('"is_error":true');
  });
});

describe("readWireSettings states what a request carried", () => {
  it("reads Claude's thinking, effort and betas", () => {
    const s = readWireSettings(
      "https://api.anthropic.com/v1/messages",
      { "anthropic-beta": "compact-2026-01-12" },
      { model: "claude-haiku-5-5", thinking: { type: "adaptive" }, output_config: { effort: "medium" }, max_tokens: 64000, context_management: {} },
    );
    expect(s).toEqual({
      host: "api.anthropic.com",
      model: "claude-haiku-5-5",
      thinking: { type: "adaptive" },
      outputConfig: { effort: "medium" },
      reasoningEffort: null,
      maxOutputTokens: 64000,
      contextManagement: true,
      betas: "compact-2026-01-12",
    });
  });

  it("reads DeepSeek's reasoning field (absent = the vendor's default)", () => {
    const on = readWireSettings("https://api.deepseek.com/chat/completions", {}, { model: "deepseek-flash", max_tokens: 8000 });
    expect(on.thinking).toBeNull();
    const off = readWireSettings("https://api.deepseek.com/chat/completions", {}, { model: "deepseek-flash", thinking: { type: "disabled" } });
    expect(off.thinking).toEqual({ type: "disabled" });
  });
});
