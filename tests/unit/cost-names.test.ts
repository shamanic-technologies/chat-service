import { describe, it, expect } from "vitest";
import {
  buildLlmCostNames,
  flatCostNames,
  selectPricingRegime,
  UnpricedModelError,
} from "../../src/lib/cost-names.js";
import { VENDORS } from "../../src/lib/openai-compatible.js";

// Which catalog row a call bills against. A name that matches no row is
// rejected at declaration and fails loud; a name that matches the WRONG row
// bills the wrong price silently — which is why the DeepSeek regime boundaries
// below are asserted minute-exactly rather than "roughly".

const at = (iso: string) => new Date(iso);

describe("selectPricingRegime — DeepSeek peak windows", () => {
  const schedule = (() => {
    const pricing = VENDORS.deepseek.pricing;
    if (pricing.kind !== "priced" || !pricing.regime) throw new Error("DeepSeek must carry a regime");
    return pricing.regime;
  })();

  // The catalog's own regimeHoursUtc: peak 01:00-04:00 and 06:00-10:00 UTC.
  it("mirrors the catalog's peak windows verbatim", () => {
    expect(schedule.peakWindowsUtc).toEqual(["01:00-04:00", "06:00-10:00"]);
    expect(schedule.peakSegment).toBe("peak");
    expect(schedule.offPeakSegment).toBe("off-peak");
  });

  // Each window is half-open [start, end): the start minute is peak, the end
  // minute is already off-peak again.
  const CASES: Array<[string, string]> = [
    ["2026-08-20T00:00:00Z", "off-peak"],
    ["2026-08-20T00:59:59Z", "off-peak"],
    ["2026-08-20T01:00:00Z", "peak"], // first peak minute, window 1
    ["2026-08-20T02:30:00Z", "peak"],
    ["2026-08-20T03:59:59Z", "peak"], // last peak minute, window 1
    ["2026-08-20T04:00:00Z", "off-peak"], // boundary flips back
    ["2026-08-20T05:30:00Z", "off-peak"],
    ["2026-08-20T05:59:59Z", "off-peak"],
    ["2026-08-20T06:00:00Z", "peak"], // first peak minute, window 2
    ["2026-08-20T09:59:59Z", "peak"], // last peak minute, window 2
    ["2026-08-20T10:00:00Z", "off-peak"], // boundary flips back
    ["2026-08-20T16:00:00Z", "off-peak"],
    ["2026-08-20T23:59:59Z", "off-peak"],
  ];

  for (const [iso, expected] of CASES) {
    it(`${iso} is ${expected}`, () => {
      expect(selectPricingRegime(schedule, at(iso))).toBe(expected);
    });
  }

  it("selects by the UTC clock, not the local one", () => {
    // 01:30 UTC is peak whatever the runner's timezone says the hour is.
    expect(selectPricingRegime(schedule, at("2026-08-20T01:30:00Z"))).toBe("peak");
    expect(selectPricingRegime(schedule, at("2026-08-20T13:30:00Z"))).toBe("off-peak");
  });

  it("selects by the clock alone — the same hour resolves the same before and after the schedule starts", () => {
    // costs-service gave both regimes an identical price point before
    // 2026-08-16T16:00Z, so the caller never branches on the date.
    expect(selectPricingRegime(schedule, at("2026-01-05T02:00:00Z"))).toBe("peak");
    expect(selectPricingRegime(schedule, at("2027-01-05T02:00:00Z"))).toBe("peak");
  });
});

describe("buildLlmCostNames — per-vendor dimensions", () => {
  it("DeepSeek: regime segment + cache split, both models", () => {
    expect(
      buildLlmCostNames({ provider: "deepseek", costPrefix: "deepseek-v4-flash", at: at("2026-08-20T02:00:00Z") }),
    ).toEqual({
      input: "deepseek-v4-flash-peak-tokens-input",
      cachedInput: "deepseek-v4-flash-peak-tokens-cached-input",
      output: "deepseek-v4-flash-peak-tokens-output",
    });
    expect(
      buildLlmCostNames({ provider: "deepseek", costPrefix: "deepseek-v4-pro", at: at("2026-08-20T12:00:00Z") }),
    ).toEqual({
      input: "deepseek-v4-pro-off-peak-tokens-input",
      cachedInput: "deepseek-v4-pro-off-peak-tokens-cached-input",
      output: "deepseek-v4-pro-off-peak-tokens-output",
    });
  });

  it("DeepSeek: never declares the superseded regime-free names", () => {
    for (const iso of ["2026-08-20T02:00:00Z", "2026-08-20T12:00:00Z"]) {
      const names = buildLlmCostNames({ provider: "deepseek", costPrefix: "deepseek-v4-flash", at: at(iso) });
      for (const name of [names.input, names.cachedInput!, names.output]) {
        expect(name).toMatch(/-(peak|off-peak)-tokens-/);
      }
      expect(names.input).not.toBe("deepseek-v4-flash-tokens-input");
      expect(names.output).not.toBe("deepseek-v4-flash-tokens-output");
    }
  });

  it("Z.ai: cached input, no regime — the hour changes nothing", () => {
    const peakHour = buildLlmCostNames({ provider: "zai", costPrefix: "zai-glm-5.2", at: at("2026-08-20T02:00:00Z") });
    const offHour = buildLlmCostNames({ provider: "zai", costPrefix: "zai-glm-5.2", at: at("2026-08-20T12:00:00Z") });
    expect(peakHour).toEqual({
      input: "zai-glm-5.2-tokens-input",
      cachedInput: "zai-glm-5.2-tokens-cached-input",
      output: "zai-glm-5.2-tokens-output",
    });
    expect(offHour).toEqual(peakHour);
  });

  it("Moonshot: fails loud, naming every missing row", () => {
    let thrown: unknown;
    try {
      buildLlmCostNames({ provider: "moonshot", costPrefix: "moonshot-kimi-k3", at: at("2026-08-20T02:00:00Z") });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnpricedModelError);
    const err = thrown as UnpricedModelError;
    expect(err.missingCostNames).toEqual([
      "moonshot-kimi-k3-tokens-input",
      "moonshot-kimi-k3-tokens-cached-input",
      "moonshot-kimi-k3-tokens-output",
    ]);
    expect(err.message).toContain("moonshot-kimi-k3-tokens-input");
    expect(err.message).toContain("costs-service");
  });

  it("Anthropic and Google keep the flat names, unchanged", () => {
    expect(
      buildLlmCostNames({ provider: "google", costPrefix: "google-flash-3.7", at: at("2026-08-20T02:00:00Z") }),
    ).toEqual(flatCostNames("google-flash-3.7"));
    expect(
      buildLlmCostNames({ provider: "anthropic", costPrefix: "anthropic-sonnet-4.6", at: at("2026-08-20T02:00:00Z") }),
    ).toEqual({
      input: "anthropic-sonnet-4.6-tokens-input",
      cachedInput: "anthropic-sonnet-4.6-tokens-cached-input",
      output: "anthropic-sonnet-4.6-tokens-output",
    });
  });
});
