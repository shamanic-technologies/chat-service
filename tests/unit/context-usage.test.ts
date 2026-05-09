import { describe, it, expect } from "vitest";
import { buildContextUsageEvent, MAX_CONTEXT_TOKENS } from "../../src/lib/context-usage.js";

describe("buildContextUsageEvent", () => {
  it("computes percent rounded to nearest integer", () => {
    const evt = buildContextUsageEvent({ inputTokens: 50_000, outputTokens: 1_000 });
    expect(evt.type).toBe("context_usage");
    expect(evt.inputTokens).toBe(50_000);
    expect(evt.outputTokens).toBe(1_000);
    expect(evt.maxTokens).toBe(MAX_CONTEXT_TOKENS);
    expect(evt.percent).toBe(Math.round((50_000 / MAX_CONTEXT_TOKENS) * 100));
  });

  it("caps percent at 100 even if input exceeds maxTokens", () => {
    const evt = buildContextUsageEvent({ inputTokens: MAX_CONTEXT_TOKENS * 2, outputTokens: 0 });
    expect(evt.percent).toBe(100);
  });

  it("returns zero percent when inputTokens is zero", () => {
    const evt = buildContextUsageEvent({ inputTokens: 0, outputTokens: 0 });
    expect(evt.percent).toBe(0);
  });

  it("MAX_CONTEXT_TOKENS is 200000 (Anthropic Sonnet limit)", () => {
    expect(MAX_CONTEXT_TOKENS).toBe(200_000);
  });
});
