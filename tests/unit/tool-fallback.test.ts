import { describe, it, expect } from "vitest";
import { buildToolResultFallback } from "../../src/lib/tool-fallback.js";

describe("buildToolResultFallback", () => {
  it("returns empty string when no tools ran", () => {
    expect(buildToolResultFallback([])).toBe("");
  });

  it("renders tool name and JSON result", () => {
    const out = buildToolResultFallback([
      { name: "list_audiences", result: { audiences: [{ id: "a1", name: "Founders" }] } },
    ]);
    expect(out).not.toBe("");
    expect(out).toContain("list_audiences");
    expect(out).toContain("Founders");
  });

  it("renders multiple tool calls", () => {
    const out = buildToolResultFallback([
      { name: "list_audiences", result: { audiences: [] } },
      { name: "suggest_audiences", result: { candidates: [{ name: "EU founders" }] } },
    ]);
    expect(out).toContain("list_audiences");
    expect(out).toContain("suggest_audiences");
    expect(out).toContain("EU founders");
  });

  it("renders a string result verbatim", () => {
    const out = buildToolResultFallback([{ name: "echo", result: "hello world" }]);
    expect(out).toContain("hello world");
  });
});
