// ---------------------------------------------------------------------------
// Cost-name resolution — which catalog row describes THIS call's spend
//
// A cost name is not a formatting detail: runs-service resolves the price from
// the name, so a name that matches the wrong row bills the wrong amount and
// says nothing. costs-service carries one row per PRICED DIMENSION, and the
// dimensions differ per vendor:
//
//   DeepSeek  cache-hit input priced apart from a miss, AND a peak/off-peak
//             schedule → 6 names, `deepseek-v4.1-flash-{peak,off-peak}-tokens-
//             {input,cached-input,output}`. WHICH regime applies at an
//             instant is read from costs-service's `regimeHoursUtc` on those
//             rows (hours, weekdays, Chinese public holidays), never held
//             here (DEEPSEEK-HOLIDAYS-1124). (The
//             retired `deepseek-v4-{flash,pro}-*` names stay priced in the
//             catalog so past spend keeps resolving; nothing declares them.)
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

/**
 * A regime that cannot be resolved EXACTLY from the catalogue: the price list
 * was never read, a regime row is missing, its rule is unreadable, or the rules
 * do not partition the instant (none or several match). Thrown before any
 * spend, like `UnpricedModelError`: the wrong guess is a customer overbill, so
 * there is no default regime and no copy of the schedule to fall back to.
 */
export class AmbiguousPricingRegimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousPricingRegimeError";
  }
}

// ---------------------------------------------------------------------------
// The regime rules, as costs-service states them (DEEPSEEK-HOLIDAYS-1124,
// owner 2026-11-25: « one source of truth »).
//
// `GET /v1/platform-prices` serves `regimeHoursUtc` on every regime row:
// comma-separated `[!]<scope>@HH:MM-HH:MM`, half-open on the minute; `<scope>`
// is a weekday range (`Mon-Fri`), a UTC date (`2027-06-09`) or an inclusive UTC
// date range (`2027-10-01..2027-10-07`). An instant is in the regime when a
// plain window covers it and no `!` window does. chat-service reads it at boot
// and hourly (`refreshFallbackPrices`) and keeps the last good read; it never
// holds a schedule of its own.
// ---------------------------------------------------------------------------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^(\d{2}):(\d{2})$/;

type RegimeScope = { kind: "weekdays"; days: Set<number> } | { kind: "dates"; from: string; to: string };
interface RegimeWindow {
  exclude: boolean;
  scope: RegimeScope;
  startMinute: number;
  endMinute: number;
}

function minuteOf(hhmm: string, rule: string): number {
  const m = HHMM.exec(hhmm);
  if (!m) throw new AmbiguousPricingRegimeError(`[cost] regimeHoursUtc "${rule}": "${hhmm}" is not HH:MM`);
  const minute = Number(m[1]) * 60 + Number(m[2]);
  if (Number(m[2]) > 59 || minute > 24 * 60) {
    throw new AmbiguousPricingRegimeError(`[cost] regimeHoursUtc "${rule}": "${hhmm}" is not a time of day`);
  }
  return minute;
}

function parseScope(scope: string, rule: string): RegimeScope {
  if (scope.includes("..")) {
    const [from, to] = scope.split("..");
    if (!DATE.test(from) || !DATE.test(to) || to < from) {
      throw new AmbiguousPricingRegimeError(`[cost] regimeHoursUtc "${rule}": "${scope}" is not a date range`);
    }
    return { kind: "dates", from, to };
  }
  if (DATE.test(scope)) return { kind: "dates", from: scope, to: scope };
  const [first, last = first] = scope.split("-");
  const a = WEEKDAYS.indexOf(first as (typeof WEEKDAYS)[number]);
  const b = WEEKDAYS.indexOf(last as (typeof WEEKDAYS)[number]);
  if (a < 0 || b < 0) throw new AmbiguousPricingRegimeError(`[cost] regimeHoursUtc "${rule}": unknown scope "${scope}"`);
  const days = new Set<number>();
  for (let d = a; ; d = (d + 1) % 7) {
    days.add(d);
    if (d === b) break;
  }
  return { kind: "weekdays", days };
}

/** Parse one `regimeHoursUtc` rule; anything it does not know THROWS (never a guess). */
export function parseRegimeHours(rule: string): RegimeWindow[] {
  const windows = rule.split(",").map((raw) => {
    const part = raw.trim();
    const exclude = part.startsWith("!");
    const body = exclude ? part.slice(1) : part;
    const at = body.split("@");
    if (at.length !== 2) throw new AmbiguousPricingRegimeError(`[cost] regimeHoursUtc "${rule}": "${part}" is not <scope>@HH:MM-HH:MM`);
    const hours = at[1].split("-");
    if (hours.length !== 2) throw new AmbiguousPricingRegimeError(`[cost] regimeHoursUtc "${rule}": "${at[1]}" is not HH:MM-HH:MM`);
    const startMinute = minuteOf(hours[0], rule);
    const endMinute = minuteOf(hours[1], rule);
    if (endMinute <= startMinute) throw new AmbiguousPricingRegimeError(`[cost] regimeHoursUtc "${rule}": empty window "${at[1]}"`);
    return { exclude, scope: parseScope(at[0], rule), startMinute, endMinute };
  });
  if (!windows.some((w) => !w.exclude)) throw new AmbiguousPricingRegimeError(`[cost] regimeHoursUtc "${rule}": no plain window`);
  return windows;
}

function windowCovers(w: RegimeWindow, at: Date): boolean {
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
  if (minute < w.startMinute || minute >= w.endMinute) return false;
  if (w.scope.kind === "weekdays") return w.scope.days.has(at.getUTCDay());
  const day = at.toISOString().slice(0, 10);
  return day >= w.scope.from && day <= w.scope.to;
}

/** true when `at` is in the regime the rule states: a plain window covers it and no `!` window does. */
export function regimeCovers(windows: RegimeWindow[], at: Date): boolean {
  return windows.some((w) => !w.exclude && windowCovers(w, at)) && !windows.some((w) => w.exclude && windowCovers(w, at));
}

/** Cost name → its `regimeHoursUtc`, from the last good read of costs-service's price list. Null = never read. */
let regimeRules: Map<string, string> | null = null;

/**
 * Store the regime rules of a price-list read. A read that carries a regime row
 * with no rule, or an unreadable rule, is refused whole and the last good read
 * stays (logged loud by the caller): a bad row must not erase a good schedule.
 */
export function setRegimeCatalogue(
  rows: ReadonlyArray<{ name: string; pricingRegime?: string | null; regimeHoursUtc?: string | null }>,
): void {
  const next = new Map<string, string>();
  for (const row of rows) {
    if (row.pricingRegime == null) continue;
    if (typeof row.regimeHoursUtc !== "string") {
      throw new AmbiguousPricingRegimeError(`[cost] ${row.name} is a ${row.pricingRegime} row with no regimeHoursUtc`);
    }
    parseRegimeHours(row.regimeHoursUtc);
    next.set(row.name, row.regimeHoursUtc);
  }
  regimeRules = next;
}

/** true once a price-list read carried readable regime rules (boot retries every minute until then). */
export function regimeCatalogueRead(): boolean {
  return regimeRules !== null;
}

/** Test hook: forget the read, as at boot. */
export function resetRegimeCatalogue(): void {
  regimeRules = null;
}

/** The one rule a regime's rows state (input / cached input / output must agree). */
function regimeRuleFor(costPrefix: string, segment: string): string {
  if (!regimeRules) {
    throw new AmbiguousPricingRegimeError(
      `[cost] ${costPrefix}: costs-service's price list has not been read, so its peak/off-peak hours are unknown. ` +
        `Check COSTS_SERVICE_URL and GET /v1/platform-prices; no regime is guessed.`,
    );
  }
  const rules = new Set<string>();
  for (const suffix of ["tokens-input", "tokens-cached-input", "tokens-output"]) {
    const rule = regimeRules.get(`${costPrefix}-${segment}-${suffix}`);
    if (rule !== undefined) rules.add(rule);
  }
  if (rules.size === 0) {
    throw new AmbiguousPricingRegimeError(`[cost] ${costPrefix}: costs-service serves no "${segment}" regime row with its hours`);
  }
  if (rules.size > 1) {
    throw new AmbiguousPricingRegimeError(`[cost] ${costPrefix}: the "${segment}" rows state different hours`);
  }
  return [...rules][0];
}

/**
 * The regime in force at `at` for `costPrefix`, read from costs-service's rules:
 * exactly ONE of the vendor's regimes must cover the instant (the catalogue
 * states them as a partition), else it throws. A Chinese public holiday on a
 * weekday resolves off-peak because the peak row excludes it and the off-peak
 * row adds it whole (costs-service v0.90.0).
 */
export function selectPricingRegime(costPrefix: string, schedule: PricingRegimeSchedule, at: Date): string {
  const matches = [schedule.peakSegment, schedule.offPeakSegment].filter((segment) =>
    regimeCovers(parseRegimeHours(regimeRuleFor(costPrefix, segment)), at),
  );
  if (matches.length !== 1) {
    throw new AmbiguousPricingRegimeError(
      `[cost] ${costPrefix} at ${at.toISOString()}: ${matches.length === 0 ? "no regime" : "both regimes"} ` +
        `cover the instant in costs-service's regimeHoursUtc; no regime is guessed.`,
    );
  }
  return matches[0];
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

  const segment = pricing.regime ? `-${selectPricingRegime(costPrefix, pricing.regime, at)}` : "";
  return {
    input: `${costPrefix}${segment}-tokens-input`,
    cachedInput: pricing.cachedInput ? `${costPrefix}${segment}-tokens-cached-input` : null,
    output: `${costPrefix}${segment}-tokens-output`,
  };
}

/** One billed dimension of a direct-vendor completion, declared verbatim. */
export interface VendorCostLine {
  costName: string;
  quantity: number;
}

/**
 * The exact lines a direct-vendor completion is billed under (LLM-HEADS-1027).
 *
 * Splits the prompt into fresh input, cache hit and cache write, then picks the
 * tier: a vendor with `longContextAboveInputTokens` bills EVERY token of a
 * request over that prompt size at its `-long-context-` rows. A vendor that
 * does not price a dimension keeps those tokens in fresh input, which is what
 * it invoices. Zero quantities are dropped.
 */
export function vendorCostLines(args: {
  provider: string;
  costPrefix: string;
  at: Date;
  tokensInput: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  tokensOutput: number;
}): VendorCostLine[] {
  const { provider, costPrefix, at, tokensInput, tokensOutput } = args;
  if (!isVendorProvider(provider)) {
    throw new Error(`[cost] vendorCostLines called for non-vendor provider "${provider}"`);
  }
  const { pricing } = VENDORS[provider];
  const longContext =
    pricing.kind === "priced" &&
    pricing.longContextAboveInputTokens !== undefined &&
    tokensInput > pricing.longContextAboveInputTokens;
  const names = buildLlmCostNames({ provider, costPrefix: longContext ? `${costPrefix}-long-context` : costPrefix, at });
  const cached = names.cachedInput ? Math.min(args.cachedInputTokens, tokensInput) : 0;
  const writes =
    pricing.kind === "priced" && pricing.cacheWrite ? Math.min(args.cacheWriteTokens, tokensInput - cached) : 0;
  const lines: VendorCostLine[] = [
    { costName: names.input, quantity: tokensInput - cached - writes },
    ...(names.cachedInput ? [{ costName: names.cachedInput, quantity: cached }] : []),
    { costName: names.input.replace(/-tokens-input$/, "-tokens-cache-write"), quantity: writes },
    { costName: names.output, quantity: tokensOutput },
  ];
  return lines.filter((l) => l.quantity > 0);
}

// ---------------------------------------------------------------------------
// TypeSafe — ONE name, because the vendor prices ONE dimension
//
// Input tokens are the entire bill at this vendor: output tokens are free, and
// there is no cache dimension and no peak/off-peak schedule. So the vendor-
// driven resolver above does not apply — there is nothing to resolve. Declaring
// an output row "for symmetry" with the LLM vendors would bill customers for
// something no invoice carries, which is the mirror image of the cache-miss
// overbill that resolver exists to prevent.
//
// The string is COPIED BYTE-EQUAL from costs-service `SEED_PROVIDERS_COSTS`, not
// derived from the model id — runs-service 422s a name the catalog does not
// carry, and the catalog's convention is a shape, not a formula. Note the
// segment is the RELEASE (`jev-1.13`), not an alias: an alias moves to a new
// model without notice, and a name keyed on one would silently reprice. That is
// also why the client always sends the pinned release id on the wire.
// ---------------------------------------------------------------------------
export const TYPESAFE_INPUT_TOKENS_COST_NAME = "typesafe-jev-1.13-tokens-input";

// ---------------------------------------------------------------------------
// OpenAI Decisions (gpt-6-luna) — input tokens only, two RATES by prompt size
//
// "Input costs $0.10 per 1M tokens. There are no cache-read, cache-write, or
// output-token charges" (Decisions guide), and a prompt over 272K tokens is
// priced at 2x for the whole request (model page). So one name per rate, never
// an output or cache row. COPIED BYTE-EQUAL from costs-service
// `SEED_PROVIDERS_COSTS`; distinct from any chat-completions gpt-6-luna row,
// which prices cache and output.
// ---------------------------------------------------------------------------
export const OPENAI_DECISIONS_TOKENS_INPUT_COST_NAME = "openai-gpt-6-luna-decisions-tokens-input";
export const OPENAI_DECISIONS_LONG_CONTEXT_TOKENS_INPUT_COST_NAME =
  "openai-gpt-6-luna-decisions-long-context-tokens-input";

// ---------------------------------------------------------------------------
// Cloudflare Clef / Clef-flash (Workers AI) — input tokens only, one rate per
// model (clef $0.24/M, clef-flash $0.038/M, output $0; account model catalog,
// read 2026-10-21). COPIED BYTE-EQUAL from costs-service `SEED_PROVIDERS_COSTS`.
// ---------------------------------------------------------------------------
export const CLEF_TOKENS_INPUT_COST_NAME = "cloudflare-clef-tokens-input";
export const CLEF_FLASH_TOKENS_INPUT_COST_NAME = "cloudflare-clef-flash-tokens-input";
