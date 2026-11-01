import { describe, it, expect } from "vitest";
import { stripLongDashes } from "../../src/lib/long-dash.js";

describe("stripLongDashes", () => {
  it("turns a long dash between words into a comma (prod DeepSeek answer 2026-11-01)", () => {
    expect(stripLongDashes("- **Client Lead Follow-up** — follows up with new leads by itself."))
      .toBe("- **Client Lead Follow-up**, follows up with new leads by itself.");
    expect(stripLongDashes("Done–see you")).toBe("Done, see you");
  });

  it("keeps number ranges as a short hyphen", () => {
    expect(stripLongDashes("Between 10–20 leads, or 3 — 5 days")).toBe("Between 10-20 leads, or 3-5 days");
  });

  it("turns a line opening on a dash into a list hyphen", () => {
    expect(stripLongDashes("Two:\n— one\n  – two")).toBe("Two:\n- one\n  - two");
  });

  it("leaves text without a long dash byte-equal", () => {
    const s = "No dash here - just a hyphen.";
    expect(stripLongDashes(s)).toBe(s);
  });
});
