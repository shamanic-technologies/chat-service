// ---------------------------------------------------------------------------
// Cost-name resolution — which catalog row describes THIS call's spend
//
// A cost name is not a formatting detail: runs-service resolves the price from
// the name, so a name that matches the wrong row bills the wrong amount and
// says nothing. costs-service carries one row per PRICED DIMENSION, and the
// dimensions differ per vendor:
//
//   DeepSeek  cache-hit input priced apart from a miss, AND a peak/off-peak
//             schedule → 12 names, `deepseek-v4-{flash,pro}-{peak,off-peak}-
//             tokens-{input,cached-input,output}`.
//   Z.ai      cache-hit input priced apart from a miss, no schedule → 3 names
//             per model, `zai-glm-5.3-tokens-{input,cached-input,output}`.
//   Moonshot  cache-hit input priced apart from a miss, no schedule → 3 names
//             per model, `moonshot-kimi-k3-tokens-{input,cached-input,output}`.
//   Anthropic / Google  the flat `<prefix>-tokens-{input,cached-input,output}`
//             shape they have always used. Untouched by this module's vendor
//             logic; `flatCostNames` reproduces those strings byte-equal.
//
// So the resolver is driven by what a vendor DECLARES it prices (the `pricing`
// descriptor on its VENDORS entry), never by assuming every vendor carries
// every dimension. A vendor added later that prices neither cache nor time of
// day gets the flat three names and no invented ones; a vendor with no catalog
// rows at all fails loud here, before any spend, naming what is missing.
// ---------------------------------------------------------------------------

import { VENDORS, isVendorProvider, type PricingRegimeSchedule } from "./openai-compatible.js";

/**
 * The catalog names one call declares against.
 *
 * `cachedInput` is null for a provider whose catalog prices no cache dimension.
 * That is NOT "no cache hits happened" — it means the vendor bills every prompt
 * token at one rate, so the whole prompt count belongs under `input`. Never
 * substitute the input name for a missing cached name on a vendor that DOES
 * price the cache: that bills a hit as a miss (50x too much at DeepSeek).
 */
export interface LlmCostNames {
  input: string;
  cachedInput: string | null;
  output: string;
}

/**
 * A model this service can reach but costs-service cannot price. Thrown before
 * the provider call, so the request fails without spending — and the message
 * names the exact rows someone has to seed.
 */
export class UnpricedModelError extends Error {
  constructor(
    message: string,
    readonly missingCostNames: string[],
  ) {
    super(message);
    this.name = "UnpricedModelError";
  }
}

/** The flat three-name shape: `<prefix>-tokens-{input,cached-input,output}`. */
export function flatCostNames(costPrefix: string): LlmCostNames {
  return {
    input: `${costPrefix}-tokens-input`,
    cachedInput: `${costPrefix}-tokens-cached-input`,
    output: `${costPrefix}-tokens-output`,
  };
}

/** Minutes since 00:00 UTC for an `HH:MM` literal. `24:00` is the end of day. */
function minuteOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * Pick the regime in force at `at`, from the SAME `regimeHoursUtc` string the
 * catalog rows carry (`"01:00-04:00,06:00-10:00"`).
 *
 * Each window is half-open, `[start, end)`: 01:00 sharp is the first peak
 * minute and 04:00 sharp is the first off-peak minute again. That is what makes
 * the two regimes a partition — every instant matches exactly one, so a caller
 * never has to fall back to a regime-free name (which, from 2026-08-16T16:00Z,
 * would have no honest price behind it).
 */
export function selectPricingRegime(schedule: PricingRegimeSchedule, at: Date): string {
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
  const inPeak = schedule.peakWindowsUtc.some((window) => {
    const [start, end] = window.split("-");
    return minute >= minuteOfDay(start) && minute < minuteOfDay(end);
  });
  return inPeak ? schedule.peakSegment : schedule.offPeakSegment;
}

/**
 * Resolve the catalog names for one completion.
 *
 * `at` is the moment the cost is declared. Pass ONE timestamp per request for
 * both the pre-call hold and the post-call actual, so a call that straddles a
 * regime boundary does not hold against one regime and bill against the other.
 */
export function buildLlmCostNames(args: {
  provider: string;
  costPrefix: string;
  at: Date;
}): LlmCostNames {
  const { provider, costPrefix, at } = args;

  // Anthropic and Google: unchanged, flat names. Their paths report no cached
  // count, so the cached name is never actually declared.
  if (!isVendorProvider(provider)) return flatCostNames(costPrefix);

  const { pricing, label } = VENDORS[provider];

  if (pricing.kind === "unpriced") {
    const missing = [
      `${costPrefix}-tokens-input`,
      `${costPrefix}-tokens-cached-input`,
      `${costPrefix}-tokens-output`,
    ];
    throw new UnpricedModelError(
      `[cost] ${label} model "${costPrefix}" has no price in the costs-service catalog. ` +
        `${pricing.reason} Seed ${missing.join(", ")} in costs-service (src/db/seed.ts, ` +
        `SEED_PROVIDERS_COSTS) and deploy it to production before using this model.`,
      missing,
    );
  }

  const segment = pricing.regime ? `-${selectPricingRegime(pricing.regime, at)}` : "";
  return {
    input: `${costPrefix}${segment}-tokens-input`,
    cachedInput: pricing.cachedInput ? `${costPrefix}${segment}-tokens-cached-input` : null,
    output: `${costPrefix}${segment}-tokens-output`,
  };
}
