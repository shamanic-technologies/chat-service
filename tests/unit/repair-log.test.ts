import { describe, it, expect } from "vitest";
import { escapeSample, repairLogSuffix } from "../../src/lib/repair-log.js";

describe("escapeSample", () => {
  it("truncates to default 80 chars", () => {
    const long = "a".repeat(200);
    expect(escapeSample(long)).toHaveLength(80);
  });

  it("truncates to caller-supplied length", () => {
    expect(escapeSample("abcdef", 3)).toBe("abc");
  });

  it("escapes embedded double quotes", () => {
    expect(escapeSample('she said "hi"')).toBe('she said \\"hi\\"');
  });

  it("escapes newline / carriage-return / tab", () => {
    expect(escapeSample("a\nb\rc\td")).toBe("a\\nb\\rc\\td");
  });

  it("escapes backslash before other escapes (avoids re-escape collisions)", () => {
    expect(escapeSample("\\n")).toBe("\\\\n");
  });

  it("returns empty string for empty input", () => {
    expect(escapeSample("")).toBe("");
  });
});

describe("repairLogSuffix", () => {
  it("formats Gemini context as provider=google", () => {
    const suffix = repairLogSuffix('{"ok":true}', {
      apiKey: "k",
      model: "gemini-3-flash-preview",
      isGemini: true,
    });
    expect(suffix).toBe(
      ' provider=google model=gemini-3-flash-preview sample="{\\"ok\\":true}"',
    );
  });

  it("formats Anthropic context as provider=anthropic", () => {
    const suffix = repairLogSuffix("partial", {
      apiKey: "k",
      model: "claude-sonnet-4-6",
      isGemini: false,
    });
    expect(suffix).toBe(' provider=anthropic model=claude-sonnet-4-6 sample="partial"');
  });

  it("falls back to provider=unknown when no context supplied", () => {
    const suffix = repairLogSuffix("partial");
    expect(suffix).toBe(' provider=unknown model=unknown sample="partial"');
  });

  it("truncates the sample to 80 chars regardless of raw length", () => {
    const long = "x".repeat(300);
    const suffix = repairLogSuffix(long, {
      apiKey: "k",
      model: "gemini-3-flash-preview",
      isGemini: true,
    });
    const match = suffix.match(/sample="([^"]*)"/);
    expect(match).not.toBeNull();
    expect(match![1]).toHaveLength(80);
  });

  it("escapes newlines in the sample so the log line stays single-line", () => {
    const suffix = repairLogSuffix("line1\nline2", {
      apiKey: "k",
      model: "gemini-3-flash-preview",
      isGemini: true,
    });
    expect(suffix).toContain('sample="line1\\nline2"');
    expect(suffix).not.toContain("\n");
  });
});
