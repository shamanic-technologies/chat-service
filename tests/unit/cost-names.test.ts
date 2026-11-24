import { afterEach, describe, it, expect } from "vitest";
import { REGIME_ROWS_2026_11_25 } from "../regime-hours.fixture.js";
import {
  buildLlmCostNames,
  flatCostNames,
  selectPricingRegime,
  setRegimeCatalogue,
  resetRegimeCatalogue,
  parseRegimeHours,
  regimeCovers,
  regimeCatalogueRead,
  AmbiguousPricingRegimeError,
  UnpricedModelError,
} from "../../src/lib/cost-names.js";
import { VENDORS, isVendorProvider } from "../../src/lib/openai-compatible.js";
import { PROVIDER_MODELS, resolveModel } from "../../src/lib/anthropic.js";

// Which catalog row a call bills against. A name that matches no row is
// rejected at declaration and fails loud; a name that matches the WRONG row
// bills the wrong price silently — which is why the DeepSeek regime boundaries
// below are asserted minute-exactly rather than "roughly".

const at = (iso: string) => new Date(iso);

// Peak vs off-peak is decided ONLY from costs-service's served `regimeHoursUtc`
// (DEEPSEEK-HOLIDAYS-1124, owner 2026-11-25). tests/setup.ts loads the rows read
// in prod on 2026-11-25; these cases pin how that rule is evaluated.
const FLASH = "deepseek-v4.1-flash";
const schedule = (() => {
  const pricing = VENDORS.deepseek.pricing;
  if (pricing.kind !== "priced" || !pricing.regime) throw new Error("DeepSeek must carry a regime");
  return pricing.regime;
})();
const regimeAt = (iso: string) => selectPricingRegime(FLASH, schedule, at(iso));

afterEach(() => setRegimeCatalogue(REGIME_ROWS_2026_11_25));

describe("selectPricingRegime — DeepSeek, from costs-service's hours", () => {
  it("holds only the name segments, no schedule", () => {
    expect(schedule).toEqual({ peakSegment: "peak", offPeakSegment: "off-peak" });
  });

  // Each window is half-open [start, end): the start minute is peak, the end
  // minute is already off-peak again. 2026-08-20 is a Thursday.
  const CASES: Array<[string, string]> = [
    ["2026-08-20T00:00:00Z", "off-peak"],
    ["2026-08-20T00:59:59Z", "off-peak"],
    ["2026-08-20T01:00:00Z", "peak"],
    ["2026-08-20T03:59:59Z", "peak"],
    ["2026-08-20T04:00:00Z", "off-peak"],
    ["2026-08-20T05:59:59Z", "off-peak"],
    ["2026-08-20T06:00:00Z", "peak"],
    ["2026-08-20T09:59:59Z", "peak"],
    ["2026-08-20T10:00:00Z", "off-peak"],
    ["2026-08-20T23:59:59Z", "off-peak"],
    ["2026-08-29T02:30:00Z", "off-peak"], // Saturday
    ["2026-08-30T07:30:00Z", "off-peak"], // Sunday
    ["2026-08-28T02:00:00Z", "peak"], // Friday
    ["2026-08-31T02:00:00Z", "peak"], // Monday
  ];
  for (const [iso, expected] of CASES) {
    it(`${iso} is ${expected}`, () => expect(regimeAt(iso)).toBe(expected));
  }

  // DEEPSEEK-HOLIDAYS-1124: "excluding Chinese public holidays ... off-peak, including
  // ... Chinese public holidays in full". Before, these declared peak and billed 2x.
  it.each([
    "2026-10-01T02:00:00Z", // National Day, Thursday
    "2026-10-07T07:00:00Z", // last day of National Day, Wednesday
    "2027-02-08T01:00:00Z", // Spring Festival, Monday, first peak minute
    "2027-06-09T09:59:00Z", // Dragon Boat, Wednesday, last peak minute
  ])("%s, a weekday public holiday at a peak hour, is off-peak", (iso) => {
    expect(regimeAt(iso)).toBe("off-peak");
    expect(buildLlmCostNames({ provider: "deepseek", costPrefix: FLASH, at: at(iso) }).input).toBe(
      "deepseek-v4.1-flash-off-peak-tokens-input",
    );
  });

  it("the next working day stays peak", () => {
    expect(buildLlmCostNames({ provider: "deepseek", costPrefix: FLASH, at: at("2026-10-08T02:00:00Z") }).input).toBe(
      "deepseek-v4.1-flash-peak-tokens-input",
    );
    expect(regimeAt("2027-02-15T01:00:00Z")).toBe("peak");
  });

  it("matches exactly one regime for every hour of every day of 2026 and 2027", () => {
    for (let t = Date.parse("2026-01-01T00:30:00Z"); t < Date.parse("2028-01-01T00:00:00Z"); t += 3600_000) {
      expect(["peak", "off-peak"]).toContain(selectPricingRegime(FLASH, schedule, new Date(t)));
    }
  });

  it("follows a change costs-service serves, with no change here", () => {
    setRegimeCatalogue([
      { name: `${FLASH}-peak-tokens-input`, pricingRegime: "peak", regimeHoursUtc: "Mon-Fri@01:00-04:00,!2028-01-03@00:00-24:00" },
      { name: `${FLASH}-off-peak-tokens-input`, pricingRegime: "off-peak", regimeHoursUtc: "Mon-Fri@00:00-01:00,Mon-Fri@04:00-24:00,Sat-Sun@00:00-24:00,2028-01-03@00:00-24:00" },
    ]);
    expect(regimeAt("2028-01-03T02:00:00Z")).toBe("off-peak"); // Monday, a served holiday
    expect(regimeAt("2028-01-04T02:00:00Z")).toBe("peak");
  });
});

describe("selectPricingRegime — never a guess", () => {
  it("throws while the price list has never been read", () => {
    resetRegimeCatalogue();
    expect(() => regimeAt("2026-08-20T02:00:00Z")).toThrow(AmbiguousPricingRegimeError);
    expect(() => buildLlmCostNames({ provider: "deepseek", costPrefix: FLASH, at: at("2026-08-20T02:00:00Z") })).toThrow(
      AmbiguousPricingRegimeError,
    );
  });

  it("throws when a regime's rows are missing", () => {
    setRegimeCatalogue([{ name: `${FLASH}-peak-tokens-input`, pricingRegime: "peak", regimeHoursUtc: "Mon-Fri@01:00-04:00" }]);
    expect(() => regimeAt("2026-08-20T02:00:00Z")).toThrow(/no "off-peak" regime row/);
  });

  it("throws when the served rules leave an instant uncovered or cover it twice", () => {
    setRegimeCatalogue([
      { name: `${FLASH}-peak-tokens-input`, pricingRegime: "peak", regimeHoursUtc: "Mon-Fri@01:00-04:00" },
      { name: `${FLASH}-off-peak-tokens-input`, pricingRegime: "off-peak", regimeHoursUtc: "Mon-Fri@03:00-24:00" },
    ]);
    expect(() => regimeAt("2026-08-20T00:30:00Z")).toThrow(/no regime/);
    expect(() => regimeAt("2026-08-20T03:30:00Z")).toThrow(/both regimes/);
  });

  it("throws when a regime's rows disagree", () => {
    setRegimeCatalogue([
      { name: `${FLASH}-peak-tokens-input`, pricingRegime: "peak", regimeHoursUtc: "Mon-Fri@01:00-04:00" },
      { name: `${FLASH}-peak-tokens-output`, pricingRegime: "peak", regimeHoursUtc: "Mon-Fri@01:00-05:00" },
      { name: `${FLASH}-off-peak-tokens-input`, pricingRegime: "off-peak", regimeHoursUtc: "Sat-Sun@00:00-24:00" },
    ]);
    expect(() => regimeAt("2026-08-20T02:00:00Z")).toThrow(/different hours/);
  });

  it("refuses an unreadable read whole and keeps the last good one", () => {
    for (const bad of ["Mon-Fri 01:00-04:00", "Moon@01:00-04:00", "Mon-Fri@04:00-01:00", "!Sat@00:00-24:00", "2026-13-01..2026-01-01@00:00-24:00"]) {
      expect(() => parseRegimeHours(bad)).toThrow(AmbiguousPricingRegimeError);
    }
    expect(() =>
      setRegimeCatalogue([{ name: `${FLASH}-peak-tokens-input`, pricingRegime: "peak", regimeHoursUtc: "Moon@01:00-04:00" }]),
    ).toThrow(AmbiguousPricingRegimeError);
    expect(regimeAt("2026-10-01T02:00:00Z")).toBe("off-peak");
    expect(() => setRegimeCatalogue([{ name: `${FLASH}-peak-tokens-input`, pricingRegime: "peak", regimeHoursUtc: null }])).toThrow(
      /no regimeHoursUtc/,
    );
  });

  it("reads a weekday range that wraps and a single weekday", () => {
    const windows = parseRegimeHours("Fri-Mon@00:00-24:00,Wed@01:00-02:00");
    expect(regimeCovers(windows, at("2026-08-30T12:00:00Z"))).toBe(true); // Sunday
    expect(regimeCovers(windows, at("2026-08-25T12:00:00Z"))).toBe(false); // Tuesday
    expect(regimeCovers(windows, at("2026-08-26T01:30:00Z"))).toBe(true); // Wednesday
  });
});

describe("buildLlmCostNames — per-vendor dimensions", () => {
  it("DeepSeek: regime segment + cache split", () => {
    expect(
      buildLlmCostNames({ provider: "deepseek", costPrefix: "deepseek-v4.1-flash", at: at("2026-08-20T02:00:00Z") }),
    ).toEqual({
      input: "deepseek-v4.1-flash-peak-tokens-input",
      cachedInput: "deepseek-v4.1-flash-peak-tokens-cached-input",
      output: "deepseek-v4.1-flash-peak-tokens-output",
    });
    expect(
      buildLlmCostNames({ provider: "deepseek", costPrefix: "deepseek-v4.1-flash", at: at("2026-08-20T12:00:00Z") }),
    ).toEqual({
      input: "deepseek-v4.1-flash-off-peak-tokens-input",
      cachedInput: "deepseek-v4.1-flash-off-peak-tokens-cached-input",
      output: "deepseek-v4.1-flash-off-peak-tokens-output",
    });
  });

  it("DeepSeek: a former peak hour on a Saturday declares off-peak names", () => {
    expect(
      buildLlmCostNames({ provider: "deepseek", costPrefix: "deepseek-v4.1-flash", at: at("2026-08-29T02:00:00Z") }),
    ).toEqual({
      input: "deepseek-v4.1-flash-off-peak-tokens-input",
      cachedInput: "deepseek-v4.1-flash-off-peak-tokens-cached-input",
      output: "deepseek-v4.1-flash-off-peak-tokens-output",
    });
  });

  it("DeepSeek: never declares the superseded regime-free names", () => {
    for (const iso of ["2026-08-20T02:00:00Z", "2026-08-20T12:00:00Z"]) {
      const names = buildLlmCostNames({ provider: "deepseek", costPrefix: "deepseek-v4.1-flash", at: at(iso) });
      for (const name of [names.input, names.cachedInput!, names.output]) {
        expect(name).toMatch(/-(peak|off-peak)-tokens-/);
      }
      expect(names.input).not.toBe("deepseek-v4.1-flash-tokens-input");
      expect(names.output).not.toBe("deepseek-v4.1-flash-tokens-output");
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
    // reachable without a catalog row behind it.
    //
    // DERIVED from MODEL_MAP, not hand-listed. The hand-written version claimed
    // to be "kept pointing at the real model set" and had already drifted — it
    // still named zai-glm-5.2 after glm-pro moved to 5.3, so the alias it was
    // meant to guard was the one alias it no longer covered. A list that must
    // be kept in sync by hand cannot be the thing that catches an alias added
    // ahead of its rows.
    const models: Array<[string, string]> = Object.entries(PROVIDER_MODELS)
      .filter(([provider]) => isVendorProvider(provider))
      .flatMap(([provider, aliases]) =>
        aliases.map((alias) => [provider, resolveModel(provider, alias).costPrefix] as [string, string]),
      );
    expect(models.length).toBeGreaterThan(0);
    for (const [provider, costPrefix] of models) {
      const names = buildLlmCostNames({ provider, costPrefix, at: at("2026-08-20T02:00:00Z") });
      expect(names.input.startsWith(costPrefix), costPrefix).toBe(true);
      // A vendor that prices no cache hit apart (Cerebras bills it at the input rate) declares no cached row.
      const cachePriced = (VENDORS[provider as keyof typeof VENDORS].pricing as { cachedInput?: boolean }).cachedInput !== false;
      if (cachePriced) expect(names.cachedInput, costPrefix).not.toBeNull();
      else expect(names.cachedInput, costPrefix).toBeNull();
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

describe("regimeCatalogueRead", () => {
  it("says whether a read landed, so boot retries each minute until it does", () => {
    resetRegimeCatalogue();
    expect(regimeCatalogueRead()).toBe(false);
    setRegimeCatalogue(REGIME_ROWS_2026_11_25);
    expect(regimeCatalogueRead()).toBe(true);
  });
});
