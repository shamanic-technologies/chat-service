import { describe, expect, it } from "vitest";
import { MixedFunnelError } from "../../src/lib/funnel-mix.js";

describe("funnel mix (owner 2026-10-12: features-service's verdict, never re-graded)", () => {
  it("names the funnel features-service served as mixed and the way out", () => {
    const e = new MixedFunnelError("f-1");
    expect(e.message).toMatch(/serves f-1 as mixed/);
    expect(e.message).toMatch(/separate Reactive funnel/);
  });
});
