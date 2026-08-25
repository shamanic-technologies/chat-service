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
//             tokens-{input,cached-input,output}`. The schedule is hours AND
//             days: peak applies 01:00-04:00 / 06:00-10:00 UTC on weekdays
//             only, the vendor having exempted weekends from 2026-08-22T16:00Z.
//   Z.ai      cache-hit input priced apart from a miss, no schedule → 3 names
//             per model, `zai-glm-5.2-tokens-{input,cached-input,output}`.
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
 * The UTC minute at which a Beijing (UTC+8) day starts — 16:00 UTC the day
 * before. A peak window that reached this minute would sit on two Beijing days
 * at once, and a vendor rule stated in Beijing weekdays could then no longer be
 * evaluated on the UTC weekday. See `assertDayScopeIsUnambiguous`.
 */
const BEIJING_DAY_START_MINUTE_UTC = 16 * 60;

/**
 * A schedule whose windows and day scope cannot both be honoured. Thrown before
 * any spend, like `UnpricedModelError`: a regime we cannot resolve exactly is a
 * regime we must not guess at, because the wrong guess is a customer overbill.
 */
export class AmbiguousPricingRegimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousPricingRegimeError";
  }
}

/**
 * DeepSeek publishes its peak HOURS in UTC and its weekend EXEMPTION in Beijing
 * days. We select on UTC days, which is only equivalent while every peak window
 * lies wholly inside one Beijing day — true today because the windows end by
 * 10:00 UTC, six hours before the Beijing day rolls over at 16:00 UTC.
 *
 * If the vendor ever publishes a window at or past 16:00 UTC, that equivalence
 * breaks: a Friday 17:00 UTC window is Beijing Saturday (exempt) while its UTC
 * weekday says Friday (peak). Rather than silently bill the wrong regime for
 * that hour, throw — the correct fix is to evaluate the day in the vendor's own
 * timezone, and that is a change someone should make deliberately.
 */
function assertDayScopeIsUnambiguous(schedule: PricingRegimeSchedule): void {
  if (!schedule.peakDaysUtc) return;
  for (const window of schedule.peakWindowsUtc) {
    const [, end] = window.split("-");
    if (minuteOfDay(end) > BEIJING_DAY_START_MINUTE_UTC) {
      throw new AmbiguousPricingRegimeError(
        `[cost] peak window "${window}" runs past 16:00 UTC, where the vendor's Beijing ` +
          `calendar day has already rolled over, so a weekday-scoped peak cannot be resolved ` +
          `from the UTC weekday. Evaluate the day in the vendor's own timezone before ` +
          `serving this schedule.`,
      );
    }
  }
}

/**
 * Pick the regime in force at `at`, from this repo's own copy of the vendor's
 * published schedule (`VENDORS[...].pricing.regime`) — the windows and the day
 * scope beside them. costs-service states the same vendor rule separately, in
 * its own grammar; the two are kept in step by hand, not derived from one
 * another, so a vendor that moves its schedule has to be applied in both.
 *
 * Each window is half-open, `[start, end)`: 01:00 sharp is the first peak
 * minute and 04:00 sharp is the first off-peak minute again. That is what makes
 * the two regimes a partition — every instant matches exactly one, so a caller
 * never has to fall back to a regime-free name (which, from 2026-08-16T16:00Z,
 * would have no honest price behind it).
 *
 * The day scope narrows peak further, and only from `peakDaysFrom`: DeepSeek
 * exempted weekends from 2026-08-22T16:00Z, so a Saturday 02:00 call declares
 * off-peak today and still resolves to peak for an instant before that date,
 * which is what the vendor actually charged then. Off-peak is the WIDER regime
 * in both directions, so narrowing peak can only ever move a call to the rate
 * the vendor is charging — never off the partition.
 */
export function selectPricingRegime(schedule: PricingRegimeSchedule, at: Date): string {
  assertDayScopeIsUnambiguous(schedule);

  const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
  const inPeakWindow = schedule.peakWindowsUtc.some((window) => {
    const [start, end] = window.split("-");
    return minute >= minuteOfDay(start) && minute < minuteOfDay(end);
  });

  const dayScopeApplies =
    schedule.peakDaysUtc !== null &&
    (schedule.peakDaysFrom === null || at.getTime() >= schedule.peakDaysFrom.getTime());
  const dayCarriesPeak = !dayScopeApplies || schedule.peakDaysUtc!.includes(at.getUTCDay());

  return inPeakWindow && dayCarriesPeak ? schedule.peakSegment : schedule.offPeakSegment;
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
