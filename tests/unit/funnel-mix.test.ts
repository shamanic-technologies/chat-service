import { describe, it, expect } from "vitest";
import { assertNotMixed, splitByMode } from "../../src/lib/funnel-mix.js";

describe("one kind per funnel (owner 2026-10-10)", () => {
  it("splits pipes by the producer's mode; a bare leg counts for nothing", () => {
    expect(splitByMode([{ id: "a", mode: "proactive" }, { id: "b", mode: "reactive" }, { id: "c" }])).toEqual({ proactive: ["a"], reactive: ["b"] });
  });
  it("a reactive pipe the customer's own team works is not a mix (it spends nothing of ours)", () => {
    expect(() => assertNotMixed("bliss", [{ id: "a", mode: "proactive", operatedBy: "platform" }, { id: "t", mode: "reactive", operatedBy: "customer" }])).not.toThrow();
    expect(() => assertNotMixed("victory", [{ id: "a", mode: "proactive", operatedBy: "platform" }, { id: "m", mode: "reactive", operatedBy: "platform" }])).toThrow(/mixes/);
  });

  it("refuses proactive + reactive together, accepts either alone", () => {
    expect(() => assertNotMixed("f", [{ id: "a", mode: "proactive" }, { id: "b", mode: "reactive" }])).toThrow(/mixes proactive/);
    expect(() => assertNotMixed("f", [{ id: "a", mode: "proactive" }, { id: "x", mode: "proactive" }])).not.toThrow();
    expect(() => assertNotMixed("f", [{ id: "b", mode: "reactive" }])).not.toThrow();
    expect(() => assertNotMixed("f", [])).not.toThrow();
  });
});
