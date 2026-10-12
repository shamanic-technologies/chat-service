import { describe, it, expect, vi, beforeEach } from "vitest";

// POST /complete + /internal/platform-complete `effort` (2026-10-12): a caller
// can ask an Anthropic model to reason at a stated level for one call. Without
// a `thinking` block these models do not reason on /complete (probed live:
// Opus 5.5 at effort medium, no thinking block → 0 thinking tokens), so the
// field sends `thinking: {type:"adaptive"}` + `output_config.effort`.

let lastParams: Record<string, unknown> | undefined;

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      create: () => {
        throw new Error("complete() must use stream");
      },
      stream: (params: Record<string, unknown>) => {
        lastParams = params;
        return {
          finalMessage: async () => ({
            stop_reason: "end_turn",
            content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"ok":true}' }],
            // output_tokens already includes thinking tokens (Anthropic usage).
            usage: { input_tokens: 10, output_tokens: 700, output_tokens_details: { thinking_tokens: 374 } },
          }),
        };
      },
    };
  },
}));

const { createAnthropicClient, assertAnthropicEffortSupported, anthropicAcceptsEffort, resolveModel, PROVIDER_MODELS } =
  await import("../../src/lib/anthropic.js");
const { CompleteRequestSchema, InternalPlatformCompleteRequestSchema } = await import("../../src/schemas.js");

const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

describe("anthropic complete() effort", () => {
  const claude = createAnthropicClient({ apiKey: "k", systemPrompt: "sys" });
  beforeEach(() => {
    lastParams = undefined;
  });

  it("omitted: no thinking block and no output_config — byte-identical request", async () => {
    await claude.complete("hi", { model: "claude-opus-5-5" });
    expect(lastParams!.thinking).toBeUndefined();
    expect(lastParams!.output_config).toBeUndefined();
    expect(Object.keys(lastParams!).sort()).toEqual(["max_tokens", "messages", "model", "system"]);
  });

  it("omitted with a schema: only output_config.format, no effort, no thinking", async () => {
    await claude.complete("hi", { model: "claude-opus-5-5", responseSchema: schema });
    expect(lastParams!.thinking).toBeUndefined();
    expect(lastParams!.output_config).toEqual({ format: expect.objectContaining({ type: "json_schema" }) });
  });

  it("effort medium on Opus 5.5 → adaptive thinking + output_config.effort beside the schema", async () => {
    const r = await claude.complete("hi", { model: "claude-opus-5-5", responseSchema: schema, effort: "medium" });
    expect(lastParams!.thinking).toEqual({ type: "adaptive" });
    expect(lastParams!.output_config).toEqual({
      format: expect.objectContaining({ type: "json_schema" }),
      effort: "medium",
    });
    // Thinking is billed as output: the whole output_tokens count is declared.
    expect(r.tokensOutput).toBe(700);
    expect(r.content).toBe('{"ok":true}');
  });

  it("disableThinking keeps its floor and never turns thinking on", async () => {
    await claude.complete("hi", { model: "claude-opus-5-5", disableThinking: true });
    expect(lastParams!.thinking).toBeUndefined();
    expect(lastParams!.output_config).toEqual({ effort: "low" });
  });

  it("effort beside disableThinking: true is refused before any call", async () => {
    await expect(
      claude.complete("hi", { model: "claude-opus-5-5", effort: "medium", disableThinking: true }),
    ).rejects.toThrow(/contradict/);
    expect(lastParams).toBeUndefined();
  });

  it("a model not known to accept effort is refused, never silently answered", () => {
    expect(() => assertAnthropicEffortSupported("claude-unknown-9", "high", undefined)).toThrow(/does not accept "effort"/);
    expect(() => assertAnthropicEffortSupported("claude-unknown-9", undefined, undefined)).not.toThrow();
  });

  it("every Anthropic alias resolves to a model that accepts effort (none is Haiku 4.5)", () => {
    for (const alias of PROVIDER_MODELS.anthropic) {
      const id = resolveModel("anthropic", alias).apiModelId;
      expect(id).not.toMatch(/haiku-4/);
      expect(anthropicAcceptsEffort(id)).toBe(true);
    }
  });
});

describe("effort request validation", () => {
  const base = { message: "m", systemPrompt: "s", provider: "anthropic", model: "opus" };
  for (const [name, s] of [["CompleteRequest", CompleteRequestSchema], ["InternalPlatformCompleteRequest", InternalPlatformCompleteRequestSchema]] as const) {
    it(`${name}: accepts every Anthropic effort level`, () => {
      for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
        expect(s.safeParse({ ...base, effort }).success).toBe(true);
      }
    });
    it(`${name}: refuses an unknown level`, () => {
      expect(s.safeParse({ ...base, effort: "minimal" }).success).toBe(false);
    });
    it(`${name}: refuses effort on a non-Anthropic provider`, () => {
      expect(s.safeParse({ ...base, provider: "google", model: "flash-pro", effort: "medium" }).success).toBe(false);
    });
    it(`${name}: refuses effort beside disableThinking: true`, () => {
      expect(s.safeParse({ ...base, effort: "medium", disableThinking: true }).success).toBe(false);
      expect(s.safeParse({ ...base, effort: "medium", disableThinking: false }).success).toBe(true);
    });
  }
});
