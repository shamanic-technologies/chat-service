import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Prompt caching request shape: complete() puts ONE 5-minute breakpoint on the
 * system block (never after the per-call user message); createStream() puts
 * one on the system block plus top-level automatic caching for the
 * conversation tail. Both only when the caller says the model's cache rows
 * are priced; otherwise the request carries no cache_control at all.
 */

let capturedParams: Record<string, any> | undefined;
let usage: Record<string, unknown> = { input_tokens: 10, output_tokens: 5 };

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      stream: (params: Record<string, unknown>) => {
        capturedParams = params;
        return {
          finalMessage: async () => ({
            content: [{ type: "text", text: "ok" }],
            usage,
            stop_reason: "end_turn",
          }),
        };
      },
    };
  },
}));

const { createAnthropicClient, MODEL } = await import("../../src/lib/anthropic.js");

describe("complete() prompt caching", () => {
  beforeEach(() => {
    capturedParams = undefined;
    usage = { input_tokens: 10, output_tokens: 5 };
  });

  it("marks the system block with a 5-minute breakpoint when cache is on", async () => {
    const claude = createAnthropicClient({ apiKey: "k", systemPrompt: "Stable prompt." });
    await claude.complete("Per-call question", { model: "claude-sonnet-5-5", cache: true });
    expect(capturedParams!.system).toEqual([
      { type: "text", text: "Stable prompt.", cache_control: { type: "ephemeral" } },
    ]);
    expect(capturedParams!.cache_control).toBeUndefined();
    expect(JSON.stringify(capturedParams!.messages)).not.toContain("cache_control");
  });

  it("sends the plain system string and no cache_control when cache is off", async () => {
    const claude = createAnthropicClient({ apiKey: "k", systemPrompt: "Stable prompt." });
    await claude.complete("Hi", { model: "claude-haiku-4-5" });
    expect(capturedParams!.system).toBe("Stable prompt.");
    expect(JSON.stringify(capturedParams)).not.toContain("cache_control");
  });

  it("returns the four billed dimensions and the full prompt size", async () => {
    usage = { input_tokens: 30, output_tokens: 7, cache_read_input_tokens: 4_000, cache_creation_input_tokens: 900 };
    const claude = createAnthropicClient({ apiKey: "k", systemPrompt: "p" });
    const r = await claude.complete("Hi", { model: "claude-sonnet-5-5", cache: true });
    expect(r.billed).toEqual({ requestPromptTokens: 4_930, tokensInput: 30, cacheReadTokens: 4_000, cacheWriteTokens: 900, tokensOutput: 7 });
    expect(r.tokensInput).toBe(4_930);
    expect(r.tokensOutput).toBe(7);
  });
});

describe("createStream() prompt caching", () => {
  beforeEach(() => {
    capturedParams = undefined;
  });

  it("caches system (+tools) explicitly and the conversation tail automatically", () => {
    const claude = createAnthropicClient({ apiKey: "k", systemPrompt: "Sys" });
    claude.createStream([{ role: "user", content: "hi" }], undefined, undefined, {
      model: "claude-sonnet-5-5",
      cache: true,
    });
    expect(capturedParams!.model).toBe("claude-sonnet-5-5");
    expect(capturedParams!.system).toEqual([{ type: "text", text: "Sys", cache_control: { type: "ephemeral" } }]);
    expect(capturedParams!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("defaults to MODEL with no cache_control", () => {
    const claude = createAnthropicClient({ apiKey: "k", systemPrompt: "Sys" });
    claude.createStream([{ role: "user", content: "hi" }]);
    expect(capturedParams!.model).toBe(MODEL);
    expect(JSON.stringify(capturedParams)).not.toContain("cache_control");
  });
});
