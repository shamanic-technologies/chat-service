import { describe, expect, it } from "vitest";
import { claudeCodeModel, pickRunnerOrg, RUNNER_SEEN_WITHIN_MS } from "../../src/evals/claude-code.js";
import { createMemoryLocalLlmStore } from "../../src/lib/local-llm-store.js";

// EVAL-SPEND-CAP-1121 (owner 2026-11-22): eval replies run on Claude Code at $0,
// answered by a Mac runner seen lately; any other vendor is refused.

describe("eval replies on Claude Code", () => {
  it("asks Claude Code for the definition's Claude model, never another vendor", () => {
    expect(claudeCodeModel("anthropic", "claude-haiku")).toMatch(/^claude-haiku/);
    expect(claudeCodeModel("deepseek", "deepseek-flash", "claude-haiku-5-5")).toBe("claude-haiku-5-5");
    expect(() => claudeCodeModel("deepseek", "deepseek-flash")).toThrow(/Claude Code only/);
    expect(() => claudeCodeModel("anthropic", "claude-haiku", "gpt-6")).toThrow(/Claude model id/);
  });

  it("picks the declaring org whose runner was seen most recently, and refuses when none answered lately", async () => {
    const store = createMemoryLocalLlmStore();
    const now = new Date("2026-11-22T10:00:00Z");
    await store.setDeclared("org-old", true, "u", now);
    await store.setDeclared("org-new", true, "u", now);
    await store.touchRunner("org-old", new Date(now.getTime() - 5 * 60_000), { name: "distribute for Mac", version: "1" });
    await store.touchRunner("org-new", new Date(now.getTime() - 60_000), { name: "distribute for Mac", version: "2" });
    expect((await pickRunnerOrg(store, now)).orgId).toBe("org-new");
    expect((await pickRunnerOrg(store, now, "org-old")).orgId).toBe("org-old");
    const later = new Date(now.getTime() + RUNNER_SEEN_WITHIN_MS + 60_000);
    await expect(pickRunnerOrg(store, later)).rejects.toThrow(/Open the distribute app/);
  });
});
