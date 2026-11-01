import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { buildAnthropicTurnMessages, lastUserMessage } from "../../src/lib/anthropic-turn.js";

/**
 * CHAT-COST-1101 (prod 2026-11-01): the per-turn context (page, recent actions,
 * a Lead event's writer block) sat in the system prompt, so every Copilot turn
 * rewrote the cache of the tools, the skills and the whole history. It now rides
 * after the user's message, and the user's message carries the breakpoint the
 * next turn reads.
 */
const history: Anthropic.MessageParam[] = [
  { role: "user", content: "Pause my campaign" },
  { role: "assistant", content: [{ type: "text", text: "Paused." }] },
];
const CONTEXT = "\n\n---\n## Additional Context (this request only)\n{\"page\":\"leads\"}";

describe("buildAnthropicTurnMessages", () => {
  it("puts the turn's context after the user's message, as a mid-conversation system message", () => {
    const out = buildAnthropicTurnMessages(history, "How many are left", CONTEXT, true);
    expect(out.slice(0, 2)).toEqual(history);
    expect(out[2]).toEqual({
      role: "user",
      content: [{ type: "text", text: "How many are left", cache_control: { type: "ephemeral" } }],
    });
    expect(out[3]).toEqual({ role: "system", content: CONTEXT.trim() });
    expect(out).toHaveLength(4);
  });

  it("the cache breakpoint ends on the user's message, never on the context (the next turn does not replay it)", () => {
    const out = buildAnthropicTurnMessages(history, "hi", CONTEXT, true);
    expect(JSON.stringify(out[3])).not.toContain("cache_control");
  });

  it("sends no context message when the turn has none", () => {
    const out = buildAnthropicTurnMessages(history, "hi", "   ", true);
    expect(out).toHaveLength(3);
    expect(out[2].role).toBe("user");
  });

  it("carries no cache_control for a model whose cache rows are not priced", () => {
    const out = buildAnthropicTurnMessages(history, "hi", CONTEXT, false);
    expect(out[2]).toEqual({ role: "user", content: "hi" });
    expect(JSON.stringify(out)).not.toContain("cache_control");
  });

  it("does not mutate the history it is given", () => {
    const copy = JSON.parse(JSON.stringify(history));
    buildAnthropicTurnMessages(history, "hi", CONTEXT, true);
    expect(history).toEqual(copy);
  });
});

describe("lastUserMessage", () => {
  it("skips the context message to reach the user's side", () => {
    const out = buildAnthropicTurnMessages(history, "hi", CONTEXT, true);
    expect(lastUserMessage(out)).toBe(out[2]);
  });
});
