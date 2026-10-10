import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { stripNul } from "../../src/lib/strip-nul.js";

describe("stripNul (Postgres refuses NUL in text and jsonb)", () => {
  it("removes NUL from strings at any depth, keeps everything else", () => {
    const d = new Date(0);
    expect(stripNul({ a: "x\u0000y", b: [{ c: "\u0000" }, 3, null], d, e: true })).toEqual({ a: "xy", b: [{ c: "" }, 3, null], d, e: true });
  });

  it("every message insert in /chat goes through it", () => {
    const src = readFileSync(join(__dirname, "../../src/index.ts"), "utf-8");
    const inserts = src.match(/db\.insert\(messages\)\.values\(/g) ?? [];
    const stripped = src.match(/db\.insert\(messages\)\.values\(stripNul\(/g) ?? [];
    expect(inserts.length).toBeGreaterThan(0);
    expect(stripped.length).toBe(inserts.length);
  });
});
