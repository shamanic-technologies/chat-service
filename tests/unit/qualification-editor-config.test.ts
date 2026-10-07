import { describe, it, expect } from "vitest";
import { resolveToolSet, TOOL_REGISTRY } from "../../src/lib/anthropic.js";
import { QUALIFICATION_EDITOR_CONFIG } from "../../src/lib/seed-platform-configs.js";

describe("qualification-editor config", () => {
  it("is keyed qualification-editor and resolves every allowed tool", () => {
    expect(QUALIFICATION_EDITOR_CONFIG.key).toBe("qualification-editor");
    const tools = resolveToolSet([...QUALIFICATION_EDITOR_CONFIG.allowedTools]);
    expect(tools.map((t) => t.name)).toEqual([...QUALIFICATION_EDITOR_CONFIG.allowedTools]);
  });

  it("offers no tool that edits a check's question", () => {
    for (const name of QUALIFICATION_EDITOR_CONFIG.allowedTools) {
      const props = Object.keys(
        (TOOL_REGISTRY[name].input_schema.properties ?? {}) as Record<string, unknown>,
      );
      if (name === "create_qualification_check") continue;
      expect(props, name).not.toContain("question");
    }
  });

  it("teaches reword = archive + recreate", () => {
    const prompt = QUALIFICATION_EDITOR_CONFIG.systemPrompt;
    expect(prompt).toMatch(/archive the old check and create a new one/);
    expect(TOOL_REGISTRY.update_qualification_check.description).toMatch(/can NOT change the question/);
  });

  it("uses the customer role names and warns before spend / reach changes", () => {
    const prompt = QUALIFICATION_EDITOR_CONFIG.systemPrompt;
    expect(prompt).toContain("Hard filter");
    expect(prompt).toContain("Bonus");
    expect(prompt).toMatch(/used a little credit/);
    expect(prompt).toMatch(/skips every company that fails it/);
  });

  it("customer-facing examples in the prompt carry no long dash", () => {
    const own = QUALIFICATION_EDITOR_CONFIG.systemPrompt.split("User-facing voice")[0];
    const quoted = own.match(/"[^"]*"/g) ?? [];
    for (const q of quoted) expect(q).not.toMatch(/[–—]/);
  });

  it("pins the turn shape: no outcome text beside a tool call, no repeat, no re-call", () => {
    const prompt = QUALIFICATION_EDITOR_CONFIG.systemPrompt;
    expect(prompt).toMatch(/never shown to the user/);
    expect(QUALIFICATION_EDITOR_CONFIG.holdTextBesideToolCalls).toBe(true);
    expect(prompt).toMatch(/never call it again for the same check/);
  });
});

describe("holdTextBesideToolCallsFor", () => {
  it("is on for qualification-editor only", async () => {
    const { holdTextBesideToolCallsFor } = await import("../../src/lib/seed-platform-configs.js");
    expect(holdTextBesideToolCallsFor("qualification-editor")).toBe(true);
    expect(holdTextBesideToolCallsFor("audience-editor")).toBe(false);
    expect(holdTextBesideToolCallsFor("workflow")).toBe(false);
  });
});
