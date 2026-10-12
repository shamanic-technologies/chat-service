import { describe, it, expect } from "vitest";
import { buildToolResultFallback } from "../../src/lib/tool-fallback.js";

describe("buildToolResultFallback", () => {
  it("returns empty string when no tools ran", () => {
    expect(buildToolResultFallback([])).toBe("");
  });

  it("names what was looked up, once per tool", () => {
    const out = buildToolResultFallback([
      { name: "read_skill", result: {} },
      { name: "list_audiences", result: { audiences: [] } },
      { name: "read_skill", result: {} },
    ]);
    expect(out).toContain("read_skill, list_audiences");
    expect(out.match(/read_skill/g)).toHaveLength(1);
  });

  // Prod 2026-10-12: the fallback pasted 22 raw results, the answer weighed
  // 339 KB and an agent driving the Copilot through the MCP could not read it.
  it("never pastes the tool results", () => {
    const big = { audiences: Array.from({ length: 26 }, (_, i) => ({ id: `a${i}`, filters: "x".repeat(4000) })) };
    const out = buildToolResultFallback([{ name: "list_audiences", result: big }]);
    expect(out).not.toContain("```");
    expect(out).not.toContain("a0");
    expect(out.length).toBeLessThan(300);
  });
});
