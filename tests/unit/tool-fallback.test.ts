import { describe, it, expect } from "vitest";
import { buildToolResultFallback } from "../../src/lib/tool-fallback.js";

describe("buildToolResultFallback", () => {
  it("returns empty string when no tools ran", () => {
    expect(buildToolResultFallback([])).toBe("");
  });

  // Prod 2026-10-27 (SOPHIE-NO-ANSWER-1028): the WhatsApp Copilot sent "I looked
  // this up (list_staff_requests, discover_services, ...)". A person never sees
  // our tool names.
  it("speaks plainly, never naming a tool", () => {
    const out = buildToolResultFallback([
      { name: "read_skill", result: {} },
      { name: "list_staff_requests", result: {} },
    ]);
    expect(out).not.toMatch(/read_skill|list_staff_requests|looked this up|did not finish/);
    expect(out).toMatch(/send your message again/);
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
