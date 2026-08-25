import { describe, it, expect } from "vitest";
import {
  buildLlmCostNames,
  flatCostNames,
  selectPricingRegime,
  AmbiguousPricingRegimeError,
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

  // The vendor's published schedule: peak 01:00-04:00 and 06:00-10:00 UTC,
  // Monday through Friday. costs-service holds its own copy of the same rule;
  // this asserts ours, and a vendor change has to land in both repos.
  it("holds the vendor's published peak windows", () => {
    expect(schedule.peakWindowsUtc).toEqual(["01:00-04:00", "06:00-10:00"]);
    expect(schedule.peakDaysUtc).toEqual([1, 2, 3, 4, 5]);
    expect(schedule.peakDaysFrom?.toISOString()).toBe("2026-08-22T16:00:00.000Z");
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

  it("selects by the clock, not the price-change date — a weekday hour resolves the same either side of it", () => {
    // costs-service gave both regimes an identical price point before
    // 2026-08-16T16:00Z, so the caller never branches on when the rates moved.
    expect(selectPricingRegime(schedule, at("2026-01-05T02:00:00Z"))).toBe("peak"); // Monday
    expect(selectPricingRegime(schedule, at("2027-01-05T02:00:00Z"))).toBe("peak"); // Tuesday
  });
});

// From 00:00 Beijing on Sunday 2026-08-23 (= 2026-08-22T16:00Z) DeepSeek bills
// off-peak "throughout the day on weekends". Without this, a Saturday 02:00
// call declares the peak name while the vendor invoices off-peak — the org is
// charged up to 2x what we are, on ~14 hours a week.
describe("selectPricingRegime — DeepSeek weekend exemption", () => {
  const schedule = (() => {
    const pricing = VENDORS.deepseek.pricing;
    if (pricing.kind !== "priced" || !pricing.regime) throw new Error("DeepSeek must carry a regime");
    return pricing.regime;
  })();

  // Every hour a weekday would call peak, on both weekend days.
  const WEEKEND_PEAK_HOURS = [
    "2026-08-29T01:00:00Z", // Saturday, first peak minute of window 1
    "2026-08-29T02:30:00Z",
    "2026-08-29T03:59:59Z",
    "2026-08-29T06:00:00Z", // Saturday, window 2
    "2026-08-29T09:59:59Z",
    "2026-08-30T01:00:00Z", // Sunday
    "2026-08-30T07:30:00Z",
    "2026-08-30T09:59:59Z",
  ];
  for (const iso of WEEKEND_PEAK_HOURS) {
    it(`${iso} is off-peak — a former peak hour on a weekend`, () => {
      expect(selectPricingRegime(schedule, at(iso))).toBe("off-peak");
    });
  }

  it("keeps peak on the weekdays either side of that weekend", () => {
    expect(selectPricingRegime(schedule, at("2026-08-28T02:00:00Z"))).toBe("peak"); // Friday
    expect(selectPricingRegime(schedule, at("2026-08-31T02:00:00Z"))).toBe("peak"); // Monday
  });

  it("leaves a weekend hour outside every window off-peak, as it always was", () => {
    expect(selectPricingRegime(schedule, at("2026-08-29T13:00:00Z"))).toBe("off-peak");
    expect(selectPricingRegime(schedule, at("2026-08-30T23:59:59Z"))).toBe("off-peak");
  });

  // The rule took effect mid-Saturday UTC. Before that instant the vendor did
  // charge peak on a weekend, so the selector must still say so.
  it("does not backdate the exemption past 2026-08-22T16:00Z", () => {
    expect(selectPricingRegime(schedule, at("2026-08-15T02:00:00Z"))).toBe("peak"); // Saturday, before
    expect(selectPricingRegime(schedule, at("2026-08-16T07:00:00Z"))).toBe("peak"); // Sunday, before
    expect(selectPricingRegime(schedule, at("2026-08-22T15:59:59Z"))).toBe("off-peak"); // Sat, but 15:59 is outside every window anyway
    expect(selectPricingRegime(schedule, at("2026-08-23T02:00:00Z"))).toBe("off-peak"); // Sunday, first affected day
  });

  // Peak and off-peak stay a partition across a whole week: every hour of every
  // day matches exactly one regime name, so no call ever has to guess.
  it("matches exactly one regime for every hour of a full week", () => {
    for (let day = 24; day <= 30; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const iso = `2026-08-${day}T${String(hour).padStart(2, "0")}:00:00Z`;
        const regime = selectPricingRegime(schedule, at(iso));
        expect([schedule.peakSegment, schedule.offPeakSegment]).toContain(regime);
      }
    }
  });
});

describe("selectPricingRegime — day scope must be resolvable from the UTC weekday", () => {
  it("throws when a peak window runs past the Beijing day boundary", () => {
    expect(() =>
      selectPricingRegime(
        {
          peakWindowsUtc: ["15:00-18:00"],
          peakDaysUtc: [1, 2, 3, 4, 5],
          peakDaysFrom: null,
          peakSegment: "peak",
          offPeakSegment: "off-peak",
        },
        at("2026-08-28T16:00:00Z"),
      ),
    ).toThrow(AmbiguousPricingRegimeError);
  });

  it("allows a late window when the schedule has no day scope", () => {
    expect(
      selectPricingRegime(
        {
          peakWindowsUtc: ["15:00-18:00"],
          peakDaysUtc: null,
          peakDaysFrom: null,
          peakSegment: "peak",
          offPeakSegment: "off-peak",
        },
        at("2026-08-28T16:00:00Z"),
      ),
    ).toBe("peak");
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

  it("DeepSeek: a former peak hour on a Saturday declares off-peak names", () => {
    expect(
      buildLlmCostNames({ provider: "deepseek", costPrefix: "deepseek-v4-pro", at: at("2026-08-29T02:00:00Z") }),
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

  it("Moonshot: cached input, no regime — the hour changes nothing", () => {
    // costs-service v0.46.0 seeded the six Moonshot rows (flat, cache-priced,
    // no time-of-day schedule) and they resolve in production, so Kimi is
    // declarable now — it used to throw UnpricedModelError here.
    const peakHour = buildLlmCostNames({ provider: "moonshot", costPrefix: "moonshot-kimi-k3", at: at("2026-08-20T02:00:00Z") });
    const offHour = buildLlmCostNames({ provider: "moonshot", costPrefix: "moonshot-kimi-k3", at: at("2026-08-20T12:00:00Z") });
    expect(peakHour).toEqual({
      input: "moonshot-kimi-k3-tokens-input",
      cachedInput: "moonshot-kimi-k3-tokens-cached-input",
      output: "moonshot-kimi-k3-tokens-output",
    });
    expect(offHour).toEqual(peakHour);
  });

  it("every reachable model now resolves a name — nothing is left unpriced", () => {
    // The guard that mattered while Moonshot was unseeded: no vendor may be
    // reachable without a catalog row behind it. Kept pointing at the real
    // model set so a future alias added ahead of its rows fails HERE.
    const models: Array<[string, string]> = [
      ["deepseek", "deepseek-v4-flash"],
      ["deepseek", "deepseek-v4-pro"],
      ["zai", "zai-glm-4.7-flashx"],
      ["zai", "zai-glm-5.2"],
      ["moonshot", "moonshot-kimi-k2.6"],
      ["moonshot", "moonshot-kimi-k3"],
    ];
    for (const [provider, costPrefix] of models) {
      const names = buildLlmCostNames({ provider, costPrefix, at: at("2026-08-20T02:00:00Z") });
      expect(names.input.startsWith(costPrefix), costPrefix).toBe(true);
      expect(names.cachedInput, costPrefix).not.toBeNull();
      expect(names.output.endsWith("-tokens-output"), costPrefix).toBe(true);
    }
  });

  it("still fails loud for a vendor whose catalog rows are missing", () => {
    // UnpricedModelError is the mechanism, not a Moonshot fact — exercise it
    // through a vendor stubbed unpriced so the path stays covered.
    const unpriced = { kind: "unpriced" as const, reason: "Stub vendor has no rows." };
    const original = VENDORS.moonshot.pricing;
    (VENDORS.moonshot as { pricing: typeof unpriced | typeof original }).pricing = unpriced;
    try {
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
      expect(err.message).toContain("costs-service");
    } finally {
      (VENDORS.moonshot as { pricing: typeof original }).pricing = original;
    }
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
