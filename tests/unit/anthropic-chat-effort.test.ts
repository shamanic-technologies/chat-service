import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Per-config thinking effort on the Anthropic /chat stream (owner 2026-10-11:
 * the Copilot thinks more). A config that states an effort sends it as
 * `output_config.effort` beside the unchanged stream shape (adaptive thinking +
 * block binding + context edits); a config that states none sends NO
 * `output_config`, byte-identical to before the knob existed.
 */

let capturedParams: Record<string, any> | undefined;

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      stream: (params: Record<string, unknown>) => {
        capturedParams = params;
        return { finalMessage: async () => ({ content: [], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" }) };
      },
    };
  },
}));

const { createAnthropicClient } = await import("../../src/lib/anthropic.js");
const { buildConfigConflictSet } = await import("../../src/lib/config-defaults.js");
const { PlatformConfigRequestSchema, ANTHROPIC_EFFORTS } = await import("../../src/schemas.js");

describe("createStream() effort", () => {
  beforeEach(() => {
    capturedParams = undefined;
  });

  it("sends output_config.effort when the config states one, keeping the stream shape", () => {
    const claude = createAnthropicClient({ apiKey: "k", systemPrompt: "Sys" });
    claude.createStream([{ role: "user", content: "hi" }], undefined, undefined, { model: "claude-sonnet-5-5", effort: "max" });
    expect(capturedParams!.output_config).toEqual({ effort: "max" });
    expect(capturedParams!.thinking).toEqual({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    expect(capturedParams!.context_management.edits.map((e: { type: string }) => e.type)).toEqual([
      "clear_thinking_20251015",
      "compact_20260112",
      "clear_tool_uses_20250919",
    ]);
  });

  it("sends no output_config when the config states none (today's behaviour)", () => {
    const claude = createAnthropicClient({ apiKey: "k", systemPrompt: "Sys" });
    claude.createStream([{ role: "user", content: "hi" }], undefined, undefined, { model: "claude-sonnet-5-5" });
    expect(capturedParams).not.toHaveProperty("output_config");
  });
});

describe("createStream() final round of the tool budget", () => {
  const tools = [{ name: "list_audiences", description: "d", input_schema: { type: "object" as const, properties: {} } }];

  it("sends tool_choice none, keeping the tools declared", () => {
    const claude = createAnthropicClient({ apiKey: "k", systemPrompt: "Sys" });
    claude.createStream([{ role: "user", content: "hi" }], tools, undefined, { model: "claude-sonnet-5-5", toolChoice: "none" });
    expect(capturedParams!.tool_choice).toEqual({ type: "none" });
    expect(capturedParams!.tools).toHaveLength(1);
  });

  it("sends no tool_choice on every other round", () => {
    const claude = createAnthropicClient({ apiKey: "k", systemPrompt: "Sys" });
    claude.createStream([{ role: "user", content: "hi" }], tools, undefined, { model: "claude-sonnet-5-5" });
    expect(capturedParams).not.toHaveProperty("tool_choice");
  });
});

describe("platform config effort", () => {
  const base = { key: "copilot", systemPrompt: "s", allowedTools: ["present_choices"] };

  it("accepts every level Sonnet 5.5 takes, on an anthropic config", () => {
    expect(ANTHROPIC_EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
    for (const effort of ANTHROPIC_EFFORTS) {
      expect(PlatformConfigRequestSchema.safeParse({ ...base, provider: "anthropic", model: "sonnet", effort }).success).toBe(true);
    }
    expect(PlatformConfigRequestSchema.safeParse({ ...base, provider: "anthropic", model: "sonnet", effort: "ultra" }).success).toBe(false);
  });

  it("refuses an effort on a Gemini config (it would be silently ignored)", () => {
    expect(PlatformConfigRequestSchema.safeParse({ ...base, provider: "google", model: "pro", effort: "high" }).success).toBe(false);
  });

  it("re-registration preserves a stored effort when omitted, and writes one when sent", () => {
    expect(buildConfigConflictSet({ systemPrompt: "s", allowedTools: [] })).not.toHaveProperty("effort");
    expect(buildConfigConflictSet({ systemPrompt: "s", allowedTools: [], effort: "max" }).effort).toBe("max");
  });
});
