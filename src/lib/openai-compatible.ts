// ---------------------------------------------------------------------------
// Direct-vendor OpenAI-compatible client — ONE adapter, N vendors
//
// The third provider path, alongside the two hand-written native clients
// (anthropic.ts, gemini.ts). Where those speak a vendor-specific dialect and
// carry that vendor's accumulated quirks, this one speaks ONE generic dialect
// (OpenAI Chat Completions) against vendors that all serve it.
//
// It replaces the Vercel AI Gateway path (removed 2026-08-15). The gateway
// charged above the vendors' own list prices (1.4x on DeepSeek V4 Flash, 4x on
// V4 Pro), added a payment-processing fee on every top-up, and gated recent
// models behind a paid tier. We call the vendors directly instead.
//
// The vendors differ in exactly three things, and all three are DATA here, not
// code: the base URL, the key-service provider slug, and where the usage
// payload reports cached prompt tokens. Adding a seventh model is a MODEL_MAP
// entry; adding a fourth vendor is a VENDORS entry. Neither is a new client.
//
// Scope is deliberately narrow (see README "Direct vendor models"):
// non-streaming `/complete` + `/internal/platform-complete` only. No /chat, no
// tool calling, no web search, no images, no embeddings.
// ---------------------------------------------------------------------------

import { markVendorServing, notifyVendorOutOfCredit } from "./vendor-credit-alert.js";

/** Request timeout. Matches the Gemini Flash-tier budget. */
const VENDOR_TIMEOUT_MS = 10 * 60_000;

/** Max connect-phase retries before giving up. */
const MAX_CONNECT_RETRIES = 3;

/** Backoff schedule for connect-phase retries (ms). */
const RETRY_DELAYS_MS = [250, 500, 1000];

/**
 * Backoff schedule for a vendor RATE LIMIT (429), in ms — a SECOND, independent
 * budget from the connect-phase one above.
 *
 * A 429 is the one completed HTTP response that is safe to replay: the vendor
 * refused the request at its front door, so no model ran, no tokens were
 * emitted and nothing was billed. It is also transitory by definition — every
 * vendor here caps requests IN FLIGHT, so the slot that was full when we asked
 * is free again a second later.
 *
 * Not retrying it is expensive in a way the log does not show: by the time a
 * campaign reaches the LLM it has already paid for lead enrichment and the rest
 * of its upstream work, so a refused completion throws away everything spent
 * before it — the run dies having produced nothing, for a reason that would
 * have cleared on its own.
 *
 * The bound is what keeps this from turning a saturated vendor into a hung
 * request: four retries over ~13s of waiting, worst case. A vendor still
 * refusing after that is genuinely over capacity, and `VendorRateLimitError`
 * says so rather than hiding it behind an eventual success.
 *
 * ONE schedule for all three vendors, deliberately: the CONCURRENCY they allow
 * differs per vendor and per model (see `VendorConfig.concurrency`), but a 429
 * means the same thing everywhere — "not right now" — and there is no vendor
 * evidence that a different curve suits one of them. Per-vendor tuning would be
 * three numbers to keep true instead of one.
 */
const RATE_LIMIT_BACKOFF_MS = [500, 1500, 3500, 7500];

/** Max rate-limit retries before failing loud. */
const MAX_RATE_LIMIT_RETRIES = RATE_LIMIT_BACKOFF_MS.length;

/**
 * Longest `Retry-After` we will honour. A vendor asking us to wait longer than
 * the whole backoff budget is telling us it is saturated, not busy — waiting it
 * out would hold the caller's request open for minutes, which is the failure
 * mode this retry exists to avoid, not one to trade into.
 */
const MAX_RETRY_AFTER_MS = 10_000;

/**
 * Transient connect-phase error codes. A request that fails with one of these
 * NEVER reached the server, so replaying it cannot double-spend.
 */
const TRANSIENT_CONNECT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export class VendorProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VendorProviderError";
  }
}

/**
 * The vendor refused the SHAPE of the request, not the work.
 *
 * A distinct class because the two failures need opposite handling and the
 * caller cannot tell them apart from the status alone. A vendor being down, a
 * rate limit, a socket reset — all transient, "try again" is honest advice. A
 * vendor rejecting an OPTION we sent (an unsupported `response_format`, a
 * parameter it does not implement) will refuse the identical request forever:
 * every retry burns a run and a hold, and the caller reads the 502 as
 * flakiness. So this surfaces as a 400 naming the option and the vendor,
 * which is what "wrong configuration" actually looks like.
 *
 * This is the LAST line, not the first: the per-vendor capability data below
 * is what stops us sending an option a vendor cannot serve. This catches the
 * ones we have not learned yet, loudly, on the first call rather than the
 * three-hundredth.
 */
export class VendorUnsupportedOptionError extends VendorProviderError {
  /** HTTP status the vendor refused with. */
  readonly status: number;
  /** Vendor's own message, untruncated by this class. */
  readonly vendorMessage: string;

  constructor(message: string, status: number, vendorMessage: string) {
    super(message);
    this.name = "VendorUnsupportedOptionError";
    this.status = status;
    this.vendorMessage = vendorMessage;
  }
}

/**
 * The vendor is refusing new work RIGHT NOW, and kept refusing for the whole
 * retry budget.
 *
 * Distinct from a plain `VendorProviderError` because the two say different
 * things to whoever reads the log: a 500 is the vendor being broken, this is us
 * asking for more parallelism than the account is allowed. It carries the
 * numbers that make that actionable — how many times we asked and over how
 * long — so a persistently saturated vendor stays VISIBLE instead of being
 * smoothed away by the retry that precedes it.
 */
export class VendorRateLimitError extends VendorProviderError {
  /** Total attempts made, including the first. */
  readonly attempts: number;
  /** Wall-clock ms spent waiting between attempts. */
  readonly waitedMs: number;
  /** Vendor's own message from the final refusal. */
  readonly vendorMessage: string;

  constructor(message: string, attempts: number, waitedMs: number, vendorMessage: string) {
    super(message);
    this.name = "VendorRateLimitError";
    this.attempts = attempts;
    this.waitedMs = waitedMs;
    this.vendorMessage = vendorMessage;
  }
}

/**
 * Vendors reachable through this adapter. The id doubles as the API `provider`
 * value AND the key-service provider slug — one vendor, one key, one name.
 */
export type VendorId = "deepseek" | "zai" | "moonshot";

/** Raw `usage` object as returned by an OpenAI-compatible chat completion. */
export interface VendorUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** DeepSeek: prompt tokens served from its context cache. */
  prompt_cache_hit_tokens?: number;
  /** DeepSeek: prompt tokens that missed the cache. Carried for logging only. */
  prompt_cache_miss_tokens?: number;
  /** Moonshot / Kimi: prompt tokens served from cache, flat on `usage`. */
  cached_tokens?: number;
  /** Z.ai and the OpenAI convention: nested under `prompt_tokens_details`. */
  prompt_tokens_details?: { cached_tokens?: number };
}

/**
 * A vendor's time-of-day price schedule, mirrored from the catalog rows.
 *
 * `peakWindowsUtc` is the costs-service `regimeHoursUtc` value split on the
 * comma, and the two segments are the literal name parts the catalog uses — so
 * the string this produces is byte-equal to a real row rather than an
 * independently-invented convention.
 */
export interface PricingRegimeSchedule {
  /** UTC windows in which the peak regime applies, `"HH:MM-HH:MM"` each. */
  peakWindowsUtc: string[];
  /** Name segment for the peak rows. */
  peakSegment: string;
  /** Name segment for every other hour. */
  offPeakSegment: string;
}

/**
 * What a vendor's costs-service catalog actually prices.
 *
 * The three vendors do not agree, and the asymmetry is real rather than an
 * oversight: DeepSeek prices a cache hit AND a time-of-day regime, Z.ai prices
 * a cache hit only, Moonshot prices nothing yet. Declaring a dimension a vendor
 * does not carry names a row that does not exist (422 at declaration); assuming
 * one it does carry bills a hit at the miss rate. So each vendor states its own
 * dimensions here and `buildLlmCostNames` (src/lib/cost-names.ts) reads them —
 * a vendor added later declares what it prices and nothing else.
 */
export type VendorPricing =
  | {
      kind: "priced";
      /** True when the catalog carries a separate `-tokens-cached-input` row. */
      cachedInput: boolean;
      /** Non-null when the catalog splits prices by time of day. */
      regime: PricingRegimeSchedule | null;
    }
  | {
      kind: "unpriced";
      /** Why there is no price yet — surfaced in the fail-loud message. */
      reason: string;
    };

/**
 * How many requests a vendor will serve us AT ONCE, as the vendor publishes it.
 *
 * Recorded here for the same reason the price is: it is a property of the model
 * that decides whether the model can carry our workload, and reading only the
 * price makes a swap look free when it is not. GLM-5.3 arrived at GLM-5.2's
 * exact list price and one TENTH of its concurrency; that swap shipped as a
 * "drop-in" because price was the only axis anyone compared (2026-08-20, undone
 * five days later after three campaigns on one shared slot produced 127
 * refusals in five hours).
 *
 * The vendors scope the limit differently and that difference is load-bearing:
 * DeepSeek and Z.ai publish a number PER MODEL (so an alias swap can change it
 * without anything else changing), Moonshot publishes it PER ACCOUNT by spend
 * tier (so it moves when the balance moves, never when the model does).
 *
 * This is DOCUMENTATION with a test attached, not a runtime limiter — nothing
 * here throttles or queues. `assertAliasConcurrency` in the unit tests reads it
 * to fail the build if a production alias is ever pointed at a model published
 * at a single in-flight slot again.
 */
export type VendorConcurrency =
  | {
      scope: "per-model";
      /** Vendor model id → published in-flight request limit. */
      limits: Record<string, number>;
      /** Where the numbers come from. */
      source: string;
      /** ISO date the numbers were read. */
      observedOn: string;
    }
  | {
      scope: "per-account";
      /** Tier label → published in-flight request limit for that tier. */
      tierLimits: Record<string, number>;
      /** What decides which tier applies, and what is NOT known here. */
      note: string;
      source: string;
      observedOn: string;
    };

/**
 * What a vendor told us when it refused a call, reduced to the few fields the
 * three of them actually use to say WHY.
 *
 * Built by `parseVendorRefusal` from the HTTP status and the raw body, so a
 * vendor that answers with an unparseable body still yields a usable signal
 * (status + text) rather than throwing inside the error path.
 */
export interface VendorRefusalSignal {
  /** HTTP status of the refusal. */
  status: number;
  /** Vendor error code as a string, `""` when absent. Z.ai's `1113` lives here. */
  code: string;
  /** Vendor error type, `""` when absent. Moonshot's quota type lives here. */
  type: string;
  /** Whole raw body, lowercased, for the vendors that only say it in prose. */
  text: string;
}

/**
 * Whether THIS vendor lets a caller turn the model's REASONING off, and what
 * the request field is called when it does.
 *
 * Recorded here for the same reason the price and the concurrency are: it is a
 * property of the vendor that decides what a generation costs, and it is not
 * the same string at any two of them. Every model we reach on these three
 * vendors reasons by default, we are billed for every reasoning token as
 * output, and `/complete` hands the caller the answer only — the reasoning is
 * read by nobody and thrown away at the parse.
 *
 * Measured in production the day this shipped: the same cold-email campaign at
 * the same daily budget spent 316 output tokens per generation on Gemini and
 * 9,633 on GLM — thirty times the output for the same three emails, and the
 * whole difference was reasoning we discard. Turning it off on GLM-5.2 cut a
 * probe from 703 output tokens to 389 with the answer intact (1,955 chars
 * against 1,565 — same three emails, less padding), and on Kimi K2.6 from
 * 1,173 to 452 while the answer got LONGER (1,140 → 1,866 chars).
 *
 * `requestFields` is merged into the request body verbatim, so a fourth vendor
 * that spells it differently is a data entry rather than a branch. What it must
 * never be is one vendor's field name sent to another: DeepSeek and Z.ai both
 * accept and silently IGNORE an unknown top-level field (probed 2026-08-25 with
 * a junk key: 200, reasoning still on), so a wrong name buys nothing and looks
 * exactly like success.
 */
export type VendorReasoning =
  | {
      kind: "disablable";
      /** Merged into the request body when reasoning is being turned off. */
      requestFields: Record<string, unknown>;
      /**
       * Vendor model ids that REFUSE this field, and what the vendor answers.
       *
       * Recorded, not worked around. A model listed here still gets the field
       * and still fails loud with the vendor's own words (400, retryable:false)
       * — silently dropping the option would hide a model that cannot serve the
       * workload cheaply behind an invoice nobody reads. Empty for a vendor
       * where every model we reach accepts it.
       */
      refusedBy: Record<string, string>;
      /** Where the field name comes from. */
      source: string;
      /** What was measured, and when. */
      evidence: string;
    }
  | {
      kind: "none";
      /** Why this vendor has no such control — surfaced in the docs, not guessed. */
      reason: string;
    };

export interface VendorConfig {
  id: VendorId;
  /** Human-readable name, used in caller-facing error messages. */
  label: string;
  /**
   * OpenAI-compatible API base, no trailing slash. The adapter POSTs to
   * `${baseUrl}/chat/completions`.
   */
  baseUrl: string;
  /** Vendor's own API documentation, for whoever debugs this next. */
  docsUrl: string;
  /**
   * Where THIS vendor reports cached prompt tokens.
   *
   * All three price a cache hit far below a fresh token (50x cheaper at
   * DeepSeek), and all three report the count — but each in a different place.
   * That divergence is the only reason this function exists; everything else
   * about the three requests is identical. See `mapVendorResponse` for what the
   * number is used for.
   */
  readCachedTokens: (usage: VendorUsage) => number;
  /**
   * The priced dimensions THIS vendor's catalog rows carry. Read at cost
   * declaration; see `VendorPricing`.
   */
  pricing: VendorPricing;
  /**
   * How much parallelism THIS vendor sells us. See `VendorConcurrency` — it
   * sits next to the price because reading the price alone is what let a
   * ten-fold throughput cut ship as a drop-in swap.
   */
  concurrency: VendorConcurrency;
  /**
   * The strongest `response_format` THIS vendor accepts.
   *
   * "OpenAI-compatible" is a description of the request SHAPE, not a promise
   * about which values inside it are implemented — and structured output is
   * exactly where the three diverge. Z.ai and Moonshot accept the full
   * `{type:"json_schema", json_schema:{schema}}` form; DeepSeek accepts only
   * `{type:"json_object"}` and answers anything else with
   * `400 "This response_format type is unavailable now"`.
   *
   * So this is DATA, like every other per-vendor difference here. Sending a
   * caller's `responseSchema` to a `json_object` vendor as `json_object` is
   * that vendor's OWN native JSON mode, not a fallback: it is the strongest
   * enforcement the vendor offers, the model is the one the caller asked for,
   * and `parseModelJsonOutput` still fails loud (502) on output it cannot
   * read. What we must never do is send a form the vendor refuses — that is
   * not stricter, it is zero completions.
   *
   * A fourth vendor states its own value here after probing the live API;
   * `tests/unit/openai-compatible.test.ts` asserts every vendor declares one.
   */
  structuredOutput: "json_schema" | "json_object";
  /**
   * Whether reasoning can be turned off on THIS vendor, and how. See
   * `VendorReasoning` — it decides what a generation costs, so it sits next to
   * the price and the concurrency rather than in a branch.
   */
  reasoning: VendorReasoning;
  /**
   * True when THIS vendor's refusal means "the prepaid balance is empty", as
   * opposed to every other reason it refuses.
   *
   * This is the whole point of the predicate being per-vendor DATA: two of the
   * three report an empty balance with the SAME 429 they use for a rate limit,
   * and each words the distinction differently. Keying an alert on the status
   * alone would either cry wolf on every burst or bury a real outage in that
   * noise, so the classification reads what the vendor actually said. Wording
   * observed 2026-08-15; the vendors' own docs are linked per entry.
   *
   * Deliberately NARROW: an auth failure, a bad request, a missing model and a
   * plain rate limit must all return false. A false positive emails the owner
   * about a balance that is fine; a false negative is silence during a real
   * outage. Both are bad, so match the vendor's own out-of-credit vocabulary
   * rather than anything adjacent to it.
   */
  isOutOfCreditRefusal: (signal: VendorRefusalSignal) => boolean;
}

/**
 * Prose both Z.ai and Moonshot use for an empty balance, and DeepSeek uses in
 * the body of its 402. All three tell the reader to top the account up, which
 * is the phrase no rate-limit or auth error carries.
 */
const EMPTY_BALANCE_PROSE = /insufficient balance|run out of balance|no resource package/;

export const VENDORS: Record<VendorId, VendorConfig> = {
  // https://api-docs.deepseek.com/quick_start/pricing — read 2026-08-15.
  // Cache hit $0.014 vs cache miss $0.44 per 1M input tokens (peak): 31x.
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    docsUrl: "https://api-docs.deepseek.com",
    // DeepSeek splits the prompt count itself: prompt_tokens = hit + miss.
    readCachedTokens: (usage) => usage.prompt_cache_hit_tokens ?? 0,
    // Both dimensions. Peak hours are DeepSeek's own, copied from the catalog
    // rows' regimeHoursUtc ("01:00-04:00,06:00-10:00"); every other hour is
    // off-peak. The time-of-day rates take effect 2026-08-16T16:00Z and
    // costs-service handled that with effective-dated price points — both
    // regimes already carry today's identical rate — so the regime is selected
    // by the clock alone, never by the date.
    pricing: {
      kind: "priced",
      cachedInput: true,
      regime: {
        peakWindowsUtc: ["01:00-04:00", "06:00-10:00"],
        peakSegment: "peak",
        offPeakSegment: "off-peak",
      },
    },
    // DeepSeek publishes concurrency per model and sells far more of it than
    // we use — and says so plainly: "A request counts as one concurrent
    // connection from the time it is sent until the model response is
    // complete", and "when the concurrency limit is exceeded, you will receive
    // an HTTP 429 error code". Expansion is free on request. Neither DeepSeek
    // alias is anywhere near these, so no alias choice here is throughput-bound.
    concurrency: {
      scope: "per-model",
      limits: { "deepseek-v4-pro": 500, "deepseek-v4-flash": 2500 },
      source: "https://api-docs.deepseek.com/quick_start/rate_limit",
      observedOn: "2026-08-25",
    },
    // json_object ONLY. DeepSeek's JSON-output guide documents
    // `{"type":"json_object"}` and nothing else
    // (https://api-docs.deepseek.com/guides/json_mode, read 2026-08-25), and
    // the API refuses the json_schema form outright: `400 {"error":{"message":
    // "This response_format type is unavailable now","type":
    // "invalid_request_error"}}` — reproduced 2026-08-25 against BOTH
    // deepseek-v4-flash and deepseek-v4-pro, while the same probe with
    // json_object returned valid JSON on both. That refusal is what made every
    // deepseek-pro completion fail for five hours the night before: the alias
    // had never been called in production, so no request had ever carried a
    // responseSchema to this vendor.
    structuredOutput: "json_object",
    // Reasoning is disablable, and it is the SAME field on all three vendors —
    // which is a fact about these three, not a rule: it is recorded per vendor
    // because a fourth may spell it differently, and because DeepSeek proves a
    // wrong name is silent. `enable_thinking: false` and
    // `reasoning_effort: "minimal"` both returned 200 here with reasoning still
    // running (226 and 781 reasoning chars), exactly like the junk-key control.
    // Probed 2026-08-25 on deepseek-v4-flash: 205 → 450 output tokens with the
    // answer growing 761 → 1,959 chars, and on deepseek-v4-pro 369 → 293 output
    // tokens at an unchanged answer (1,165 → 1,131 chars). DeepSeek reasons
    // least of the three to begin with, so it is also the one that saves least.
    reasoning: {
      kind: "disablable",
      requestFields: { thinking: { type: "disabled" } },
      refusedBy: {},
      source: "https://api-docs.deepseek.com/guides/reasoning_model",
      evidence:
        "Probed 2026-08-25. flash 205→450 out tok (answer 761→1,959 chars), pro 369→293 out tok " +
        "(answer 1,165→1,131 chars); reasoning_content empty in both. enable_thinking / " +
        "reasoning_effort are ignored by this vendor, like an unknown key.",
    },
    // DeepSeek is the one vendor that does NOT overload 429 for this: its
    // documented codes give an empty balance its own status, 402 "Insufficient
    // Balance — You have run out of balance", while 429 is only "Rate Limit
    // Reached". https://api-docs.deepseek.com/quick_start/error_codes (read
    // 2026-08-16). We had not observed a DeepSeek out-of-credit refusal when
    // this shipped, so the status is paired with the vendor's own documented
    // prose rather than trusted alone.
    isOutOfCreditRefusal: (s) => s.status === 402 || EMPTY_BALANCE_PROSE.test(s.text),
  },
  // https://docs.z.ai/api-reference/llm/chat-completion — read 2026-08-15.
  // Cached input $0.26 vs $1.4 per 1M on glm-5.3; $0.01 vs $0.07 on flashx.
  zai: {
    id: "zai",
    label: "Z.ai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    docsUrl: "https://docs.z.ai",
    // Follows the OpenAI convention: usage.prompt_tokens_details.cached_tokens.
    readCachedTokens: (usage) => usage.prompt_tokens_details?.cached_tokens ?? 0,
    // Cached input is its own catalog row; Z.ai publishes no time-of-day
    // schedule, so its rows carry no regime and the names have no regime
    // segment. Inventing one here would name a row that does not exist.
    pricing: { kind: "priced", cachedInput: true, regime: null },
    // Z.ai is the vendor where this number decides the alias, and it does NOT
    // track the price: GLM-5.1, 5.2 and 5.3 all list at $1.4/$4.4 per 1M while
    // 5.3 serves ONE in-flight request against 5.2's ten. Its rate-limit page
    // is behind the account console rather than the public docs, so the table
    // is copied here verbatim, and confirmed against the live API on the same
    // day: six parallel completions returned 6/6 200 on glm-5.2 and 2/6 on
    // glm-5.3, the other four `429 {"error":{"code":"1302","message":"Rate
    // limit reached for requests"}}`.
    //
    // glm-4.7-flashx (our `glm-flash`) is not listed in that table; the value
    // is recorded only where the vendor publishes one, never inferred from a
    // sibling model.
    concurrency: {
      scope: "per-model",
      limits: { "glm-5.1": 10, "glm-5.2": 10, "glm-5.3": 1, "glm-4.7": 2, "glm-4.6v-flashx": 3 },
      source: "https://z.ai/manage-apikey/rate-limits (account console; login required)",
      observedOn: "2026-08-25",
    },
    // json_schema accepted. Z.ai's reference lists only text/json_object, but
    // the live API answers 200 to the json_schema form — probed 2026-08-25
    // against glm-4.7-flashx. Kept at the stronger form because that is what
    // the vendor actually serves, and downgrading it would silently drop
    // enforcement a caller asked for.
    structuredOutput: "json_schema",
    // Z.ai is the vendor this was measured on and the one it saves most on.
    // `thinking: {type:"disabled"}` on glm-5.2 took a probe from 703 to 389
    // output tokens with the answer intact (1,955 → 1,565 chars — the same
    // three emails, less padding), while a junk key on the identical prompt
    // left reasoning running at 3,431 chars. `reasoning_effort:"minimal"` made
    // it think MORE (4,353 reasoning chars, 1,384 output tokens), which is the
    // clearest possible demonstration that the field name is a per-vendor fact
    // and not a guess.
    //
    // GLM-5.3 REFUSES the field outright and is recorded rather than special-
    // cased: nothing routes to it today (`glm-pro` was moved back to 5.2 after
    // the concurrency incident), and if anything ever does, its refusal must
    // reach the caller as a 400 in Z.ai's own words instead of being quietly
    // dropped into a bill nobody reads.
    reasoning: {
      kind: "disablable",
      requestFields: { thinking: { type: "disabled" } },
      refusedBy: {
        // Verbatim, 2026-08-25: `400 {"error":{"code":"1210","message":"This model always
        // engages in thinking and cannot be disabled; please use low, high, or max"}}`. It also
        // burned the entire 2,000-token cap on reasoning and returned a ZERO-character answer
        // when forced to think, which is the other half of why the alias no longer points at it.
        "glm-5.3":
          'Z.ai 400 code 1210 — "This model always engages in thinking and cannot be disabled; ' +
          'please use low, high, or max" (observed 2026-08-25).',
      },
      source: "https://docs.z.ai/api-reference/llm/chat-completion",
      evidence:
        "Probed 2026-08-25 on glm-5.2: 703→389 out tok (answer 1,955→1,565 chars), reasoning " +
        "1,035→0 chars; on glm-4.7-flashx 1,036→329 out tok (answer 2,091→1,433 chars). An " +
        "unknown key on the same prompt left reasoning at 3,431 chars, and reasoning_effort:" +
        "'minimal' raised it to 4,353.",
    },
    // Z.ai answers an empty balance with a 429 — the same status as a rate
    // limit — and separates the two in the body: code 1113, "Insufficient
    // balance or no resource package. Please recharge." (observed 2026-08-15).
    // So the code is the signal and the status is not.
    isOutOfCreditRefusal: (s) => s.code === "1113" || EMPTY_BALANCE_PROSE.test(s.text),
  },
  // https://platform.kimi.ai/docs/api/chat — read 2026-08-15.
  // Cache hit $0.30 vs $3.00 per 1M on kimi-k3; $0.16 vs $0.95 on kimi-k2.6.
  moonshot: {
    id: "moonshot",
    label: "Moonshot (Kimi)",
    baseUrl: "https://api.moonshot.ai/v1",
    docsUrl: "https://platform.kimi.ai/docs",
    // Moonshot reports it flat on `usage`, not nested. Fall back to the
    // OpenAI-shaped location so a future API alignment does not silently lose
    // the count (and with it the cache discount).
    readCachedTokens: (usage) =>
      usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0,
    // Cached input is its own catalog row (costs-service v0.46.0, live in
    // production 2026-08-16 — verified by resolving all six names against the
    // prod `/v1/platform-prices/{name}`). Moonshot publishes no time-of-day
    // schedule, so its rows carry no regime and the names have no regime
    // segment — the same shape as Z.ai.
    pricing: { kind: "priced", cachedInput: true, regime: null },
    // Moonshot publishes concurrency PER ACCOUNT, by cumulative spend tier, not
    // per model: Tier 0 ($1) 1 concurrency / 3 RPM, Tier 1 ($10) 50 / 200, Tier
    // 2 ($20) 100 / 500, up to Tier 5 ($3,000) 1,000 / 10,000. So a Kimi alias
    // swap cannot change our throughput — only the balance can, which means the
    // number to watch here is the account tier, and Tier 0's single slot is the
    // one state that would put Kimi in GLM-5.3's position. Recorded at the tier
    // this account is on.
    concurrency: {
      scope: "per-account",
      tierLimits: { "tier-0": 1, "tier-1": 50, "tier-2": 100, "tier-3": 200, "tier-4": 400, "tier-5": 1000 },
      note:
        "Tier is set by cumulative recharge ($1 / $10 / $20 / $100 / $1,000 / $3,000), not by model, " +
        "so a Kimi alias swap cannot change our throughput — only the balance can. Which tier THIS " +
        "account sits on is a console fact, not published by the API, so it is deliberately not " +
        "asserted here; Tier 0's single slot is the one state that would put Kimi in GLM-5.3's " +
        "position. OBSERVED 2026-08-25, and it is that state: Moonshot refused a second in-flight " +
        "request with `429 rate_limit_reached_error` saying \"request reached max organization " +
        "concurrency: 1\", i.e. this account is on Tier 0. That is a BALANCE fact and nothing here " +
        "can fix it — a top-up to $10 moves it to 50 — but any Kimi alias serves one request at a " +
        "time until someone does.",
      source: "https://platform.kimi.ai/docs/pricing/limits",
      observedOn: "2026-08-25",
    },
    // json_schema accepted — probed 2026-08-25 against kimi-k2.6 (200).
    structuredOutput: "json_schema",
    // Moonshot reasons the hardest of the three and answers the shortest while
    // doing it: kimi-k2.6 spent 1,173 output tokens on 3,808 chars of reasoning
    // and 1,140 chars of answer. With `thinking: {type:"disabled"}` it spent 452
    // and the ANSWER GOT LONGER (1,866 chars) — the reasoning was not feeding
    // the answer, it was replacing it. `enable_thinking:false` and
    // `reasoning_effort:"low"` are ignored here exactly as they are at DeepSeek
    // (1,418 and 1,310 output tokens, reasoning still running), so the field
    // name matters and the vendor will not tell you when you get it wrong.
    reasoning: {
      kind: "disablable",
      requestFields: { thinking: { type: "disabled" } },
      refusedBy: {},
      source: "https://platform.kimi.ai/docs/api/chat",
      evidence:
        "Probed 2026-08-25 on kimi-k2.6: 1,173→452 out tok, reasoning 3,808→0 chars, answer " +
        "1,140→1,866 chars. enable_thinking / reasoning_effort ignored, like an unknown key.",
    },
    // Moonshot also overloads 429, and names the case in the error TYPE:
    // `exceeded_current_quota_error`, "account ... is suspended due to
    // insufficient balance, please recharge" (observed 2026-08-15). Its
    // rate-limit 429 carries `rate_limit_reached_error` instead.
    isOutOfCreditRefusal: (s) =>
      s.type === "exceeded_current_quota_error" || EMPTY_BALANCE_PROSE.test(s.text),
  },
};

/**
 * Reduce a refused HTTP response to a `VendorRefusalSignal`.
 *
 * Never throws: a vendor that refuses with an HTML error page or a truncated
 * body still has to produce a usable signal, because this runs on the path that
 * is already failing. An unreadable body degrades to status + raw text, which
 * is exactly what the prose predicates read.
 */
export function parseVendorRefusal(status: number, bodyText: string): VendorRefusalSignal {
  let code = "";
  let type = "";
  try {
    const parsed = JSON.parse(bodyText) as {
      code?: unknown;
      type?: unknown;
      error?: { code?: unknown; type?: unknown };
    };
    const err = typeof parsed?.error === "object" && parsed.error !== null ? parsed.error : {};
    const rawCode = err.code ?? parsed?.code;
    const rawType = err.type ?? parsed?.type;
    if (rawCode != null && typeof rawCode !== "object") code = String(rawCode);
    if (rawType != null && typeof rawType !== "object") type = String(rawType);
  } catch {
    // Not JSON. Status and prose still classify it.
  }
  return { status, code, type, text: bodyText.toLowerCase() };
}

/**
 * True when this refusal is the vendor saying its prepaid balance is empty.
 *
 * Out-of-credit is the one vendor failure that stops an entire model tier until
 * a human tops the account up, so it is the one the owner is emailed about. It
 * changes NOTHING about the failure itself — the caller still sees the same
 * error it saw before this existed.
 */
export function isOutOfCreditRefusal(
  vendor: VendorId,
  status: number,
  bodyText: string,
): boolean {
  return vendorConfig(vendor).isOutOfCreditRefusal(parseVendorRefusal(status, bodyText));
}

export const VENDOR_IDS = Object.keys(VENDORS) as VendorId[];

/** True when the resolved provider is one of the direct-vendor OpenAI-compatible paths. */
export function isVendorProvider(provider: string): provider is VendorId {
  return Object.prototype.hasOwnProperty.call(VENDORS, provider);
}

/**
 * Look up a vendor, failing loud on an unknown slug rather than defaulting to
 * one — a request billed against the wrong vendor's catalog name is worse than
 * a 500.
 */
export function vendorConfig(provider: string): VendorConfig {
  const config = VENDORS[provider as VendorId];
  if (!config) {
    throw new VendorProviderError(
      `[vendor] Unknown vendor "${provider}". Known vendors: ${VENDOR_IDS.join(", ")}.`,
    );
  }
  return config;
}

/**
 * Published in-flight limit for a vendor model, or null when the vendor does
 * not publish one for it.
 *
 * Null is a real answer and must NOT be read as "unlimited" or filled in from a
 * sibling model — glm-4.7-flashx has no published row, and guessing it from
 * glm-4.7 would invent a number the vendor never gave us. Only the per-model
 * vendors can answer at all; Moonshot's limit belongs to the account, so it
 * answers null for every model by construction.
 */
export function publishedConcurrency(vendor: VendorId, apiModelId: string): number | null {
  const { concurrency } = vendorConfig(vendor);
  if (concurrency.scope !== "per-model") return null;
  return concurrency.limits[apiModelId] ?? null;
}

/**
 * Read a `Retry-After` header into ms, or null when absent/unusable.
 *
 * Both documented forms are accepted (delay-seconds and an HTTP-date). A value
 * beyond `MAX_RETRY_AFTER_MS` is DISCARDED rather than honoured — the caller
 * falls back to the bounded backoff step, so a vendor asking for a five-minute
 * wait cannot hold the request open for five minutes.
 */
export function parseRetryAfterMs(headerValue: string | null | undefined): number | null {
  if (!headerValue) return null;
  const raw = headerValue.trim();
  let ms: number | null = null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    ms = seconds * 1000;
  } else {
    const at = Date.parse(raw);
    if (Number.isFinite(at)) ms = at - Date.now();
  }

  if (ms == null || ms <= 0) return null;
  return ms > MAX_RETRY_AFTER_MS ? null : ms;
}

export interface VendorCompleteOptions {
  vendor: VendorId;
  apiKey: string;
  /** Vendor model id, e.g. "deepseek-v4-flash", "glm-5.3", "kimi-k3". */
  model: string;
  message: string;
  systemPrompt?: string;
  responseFormat?: "text" | "json";
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Caller's explicit reasoning choice, TRI-STATE on purpose.
   *
   * `true` turns reasoning off, `false` keeps it on, and OMITTED takes the
   * default in `shouldDisableVendorReasoning` — which is what makes the default
   * overridable in both directions. Same field the Gemini path already exposes
   * on `/complete` (`disableThinking`), so a caller learns one knob, not two.
   *
   * On a vendor with no such control this is a documented no-op, exactly like
   * `disableThinking` on Anthropic.
   */
  disableThinking?: boolean;
}

export interface VendorCompleteResult {
  content: string;
  /** TOTAL prompt tokens, cached and fresh — the vendor's own `prompt_tokens`. */
  tokensInput: number;
  tokensOutput: number;
  model: string;
  /** Always 0 — web search is not wired on the direct-vendor paths. Keeps the shape uniform. */
  searchCount: number;
  /** Always empty — see searchCount. */
  sources: Array<{ url: string; title?: string }>;
  /**
   * Prompt tokens the vendor served from ITS cache, a SUBSET of `tokensInput`.
   *
   * This one is billed, not merely logged. All three vendors price a cache hit
   * far below a fresh token, and our dominant workload is a large stable prompt
   * with a small per-lead block — so cache hits are the normal case, not the
   * exception. `/complete` declares `tokensInput - cachedInputTokens` under
   * `<prefix>-tokens-input` and this count under `<prefix>-tokens-cached-input`.
   *
   * (The removed gateway path deliberately did NOT discount these, because
   * Vercel billed implicit-cache tokens at the full input price regardless of
   * what the underlying vendor charged — vercel/ai#13907. Calling the vendor
   * directly is exactly what makes the discount real on our invoice.)
   */
  cachedInputTokens: number;
  /** Which vendor served the request — for logs and cost reconciliation. */
  vendor: VendorId;
}

interface VendorChoice {
  message?: { content?: string | null };
  finish_reason?: string;
}

interface VendorResponseBody {
  id?: string;
  model?: string;
  choices?: VendorChoice[];
  usage?: VendorUsage;
  error?: { message?: string; type?: string; code?: string } | string;
}

/** Walk an error (and any `cause` / AggregateError chain) for a transient connect code. */
function isTransientConnectError(err: unknown, depth = 0): boolean {
  if (!err || depth > 5) return false;
  const e = err as { code?: string; cause?: unknown; errors?: unknown[] };
  if (typeof e.code === "string" && TRANSIENT_CONNECT_CODES.has(e.code)) return true;
  if (Array.isArray(e.errors) && e.errors.some((sub) => isTransientConnectError(sub, depth + 1))) {
    return true;
  }
  return isTransientConnectError(e.cause, depth + 1);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Spread a backoff step by ±25%.
 *
 * The requests that collide on a concurrency limit are the ones that started
 * together — a campaign fanning out — so an unjittered schedule marches them
 * into the same retry instant and they refuse each other again. The jitter is
 * what makes the second attempt land in a free slot rather than the same
 * contended one.
 */
function jittered(ms: number): number {
  return ms * (0.75 + Math.random() * 0.5);
}

/**
 * Build the OpenAI-compatible request body.
 *
 * Deliberately carries NO routing / fallback knobs — no `models` array, no
 * `sort`, no provider `order`. A request that silently resolved to a DIFFERENT
 * model than the alias we priced would declare the wrong cost name, so the
 * model must be the one thing that cannot move under us. `assertModelMatches`
 * below is the second half of that guarantee.
 *
 * The caller's `systemPrompt` is forwarded byte-equal — no preamble, no
 * postamble, no "respond with JSON" nudge (README "Prompt Ownership").
 */
/**
 * True when the caller asked for a machine-readable answer.
 *
 * Either form counts: a `responseSchema` (the vendor enforces a shape) or
 * `responseFormat: "json"` (the vendor's own JSON mode). Both mean the caller
 * is going to `JSON.parse` the content and read fields out of it.
 */
function isStructuredRequest(options: VendorCompleteOptions): boolean {
  return options.responseSchema != null || options.responseFormat === "json";
}

/**
 * Should this request turn the model's reasoning off?
 *
 * The DEFAULT is "yes, when the caller asked for structured output" — and the
 * reason is what the caller does with the answer, not what it costs. A request
 * carrying a `responseSchema` (or `responseFormat: "json"`) is going to be
 * strict-parsed into an object and read field by field; the reasoning is not in
 * the object, is never returned to the caller by either completion route, and
 * is billed as output tokens at the full output rate. Nobody reads it and
 * everybody pays for it.
 *
 * Free-TEXT requests keep the provider-normal behaviour. That is the half of
 * this where reasoning may genuinely be doing work — an explanation, an
 * analysis, a piece of prose whose quality the reasoning shaped — and there is
 * no measurement saying it is safe to take away, so it is left alone. The
 * saving is claimed only where the evidence is.
 *
 * Either way the caller overrides: `disableThinking: false` keeps reasoning on
 * for a structured request, `disableThinking: true` turns it off for a text
 * one. The caller owns the tradeoff; the default is what the callers of this
 * service are all doing today.
 */
export function shouldDisableVendorReasoning(options: VendorCompleteOptions): boolean {
  if (options.disableThinking != null) return options.disableThinking;
  return isStructuredRequest(options);
}

export function buildVendorRequestBody(options: VendorCompleteOptions): Record<string, unknown> {
  const { model, message, systemPrompt, responseFormat, responseSchema, temperature, maxOutputTokens } = options;

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: message });

  const body: Record<string, unknown> = { model, messages, stream: false };

  if (temperature != null) body.temperature = temperature;
  if (maxOutputTokens != null) body.max_tokens = maxOutputTokens;

  // JSON mode via native provider metadata only, in the strongest form THIS
  // vendor implements (`structuredOutput`). Enforcement strength varies by
  // vendor and model, so the request may reach a model that treats it as a
  // hint. That is acceptable and NOT a silent fallback: parseModelJsonOutput
  // still fails loud (502) on output it cannot read.
  //
  // A caller's responseSchema reaching a json_object-only vendor is served as
  // that vendor's own JSON mode rather than refused — the caller asked for
  // THIS model and gets THIS model, which is the whole point of an A/B test.
  // The schema is not sent because the vendor has nowhere to put it, so it
  // stops being enforced provider-side; the strict parse downstream still is.
  if (responseSchema != null) {
    if (vendorConfig(options.vendor).structuredOutput === "json_schema") {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "response", schema: responseSchema },
      };
    } else {
      body.response_format = { type: "json_object" };
    }
  } else if (responseFormat === "json") {
    body.response_format = { type: "json_object" };
  }

  // Reasoning off, in THIS vendor's own words. `requestFields` is merged
  // verbatim — no field name is assumed to carry across vendors, because two of
  // the three accept a wrong one with a 200 and keep reasoning anyway.
  //
  // A vendor with no such control gets nothing added and is documented as
  // unaffected; a MODEL that refuses the field still receives it and still
  // fails loud with the vendor's own message (VendorUnsupportedOptionError →
  // 400, retryable:false). Dropping it for a known-refusing model would hide
  // the one thing worth knowing: that this model cannot do the job cheaply.
  const { reasoning } = vendorConfig(options.vendor);
  if (reasoning.kind === "disablable" && shouldDisableVendorReasoning(options)) {
    Object.assign(body, reasoning.requestFields);
  }

  return body;
}

/**
 * True when a refusal is the vendor rejecting the request's SHAPE.
 *
 * Narrow on purpose. A 400/422 from an OpenAI-compatible chat completion is a
 * malformed or unsupported request by definition — the vendor never started
 * work, so no retry can change the outcome. Everything else (401, 402, 404,
 * 429, every 5xx) stays a plain VendorProviderError: auth and credit are
 * account state, and the rest is genuinely worth trying again.
 */
export function isUnsupportedOptionRefusal(status: number): boolean {
  return status === 400 || status === 422;
}

/**
 * The response echoes which model actually answered. If it is not the model we
 * asked for, the cost prefix we are about to declare no longer describes the
 * spend — fail loud rather than bill the wrong catalog name.
 *
 * A DATED BUILD of the requested model is accepted (`deepseek-v4-pro` served as
 * `deepseek-v4-pro-0813`): our aliases are version-free by convention, the
 * vendor resolves the current build, and it is the same model at the same
 * price. A different model is not, and throws.
 */
export function assertModelMatches(requested: string, returned: string | undefined): void {
  if (!returned) return;
  const normalize = (m: string) => m.trim().toLowerCase();
  const req = normalize(requested);
  const got = normalize(returned);
  if (got === req || got.startsWith(`${req}-`)) return;
  throw new VendorProviderError(
    `[vendor] Model mismatch: requested "${requested}" but the vendor served "${returned}". ` +
      `Refusing to declare cost under the requested model's catalog name.`,
  );
}

/** Extract an in-band error message from a 200-status body, if present. */
function inBandError(body: VendorResponseBody): string | null {
  if (!body.error) return null;
  if (typeof body.error === "string") return body.error;
  return body.error.message ?? JSON.stringify(body.error);
}

export function mapVendorResponse(
  vendor: VendorId,
  requestedModel: string,
  body: VendorResponseBody,
): VendorCompleteResult {
  const errMessage = inBandError(body);
  if (errMessage) {
    throw new VendorProviderError(
      `[vendor:${vendor}] Provider returned an error: ${errMessage}`,
    );
  }

  assertModelMatches(requestedModel, body.model);

  const choice = body.choices?.[0];
  const content = choice?.message?.content;

  // Fail loud on a wholly-empty response rather than returning "" with HTTP 200 —
  // the same contract the Gemini path learned the hard way (incident 2026-06-01).
  if (typeof content !== "string" || content.length === 0) {
    throw new VendorProviderError(
      `[vendor:${vendor}] Empty response from "${requestedModel}" (finish_reason=${choice?.finish_reason ?? "none"}).`,
    );
  }

  if (choice?.finish_reason === "length") {
    console.warn(
      `[chat-service] [vendor:${vendor}] Output truncated (finish_reason=length) for "${requestedModel}".`,
    );
  }

  const usage = body.usage ?? {};
  const tokensInput = usage.prompt_tokens ?? 0;

  // Every vendor reports the cached count as a SUBSET of prompt_tokens. Clamp
  // rather than trust: a cached count above the prompt total would make the
  // fresh-token quantity negative and runs-service would reject the whole
  // declaration, failing a call that actually succeeded.
  const rawCached = vendorConfig(vendor).readCachedTokens(usage);
  const cachedInputTokens = Math.max(0, Math.min(rawCached, tokensInput));

  return {
    content,
    tokensInput,
    tokensOutput: usage.completion_tokens ?? 0,
    model: body.model ?? requestedModel,
    searchCount: 0,
    sources: [],
    cachedInputTokens,
    vendor,
  };
}

/**
 * Non-streaming completion against a vendor's OpenAI-compatible endpoint.
 *
 * Retries ONLY connect-phase failures (a thrown fetch rejection whose cause is
 * a transient socket error). A completed HTTP response — including a 5xx — is a
 * real answer from the vendor and may already have been billed upstream, so it
 * is never replayed. This is intentionally stricter than gemini.ts, which
 * retries 429/5xx status codes.
 *
 * A vendor being down fails loud. There is no cross-vendor fallback: silently
 * answering from a different model would bill spend under a catalog name that
 * does not describe what ran, and hand the caller an answer from a model it did
 * not choose.
 */
export async function completeWithVendor(
  options: VendorCompleteOptions,
): Promise<VendorCompleteResult> {
  const { apiKey, model, vendor } = options;
  const config = vendorConfig(vendor);
  const body = buildVendorRequestBody(options);

  let lastConnectError: unknown = null;
  let connectAttempt = 0;
  let rateLimitAttempt = 0;
  let rateLimitWaitedMs = 0;

  // Two independent budgets, because the two failures are different events. A
  // connect failure never reached the vendor; a 429 reached it and was turned
  // away. Sharing one counter would let a burst of socket resets eat the
  // rate-limit budget (or the reverse) and cut short the retry that had a
  // chance of working.
  for (;;) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VENDOR_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (isTransientConnectError(err) && connectAttempt < MAX_CONNECT_RETRIES) {
        lastConnectError = err;
        console.warn(
          `[chat-service] [vendor:${vendor}] Connect-phase failure for "${model}" ` +
            `(attempt ${connectAttempt + 1}/${MAX_CONNECT_RETRIES + 1}), retrying.`,
        );
        await sleep(RETRY_DELAYS_MS[connectAttempt] ?? 1000);
        connectAttempt++;
        continue;
      }
      throw err instanceof Error ? err : new VendorProviderError(String(err ?? lastConnectError));
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");

      const refusal = parseVendorRefusal(res.status, text);
      const outOfCredit = config.isOutOfCreditRefusal(refusal);

      // Out-of-credit stops the whole model tier until a human tops the account
      // up, so the owner is emailed — once per outage, detached from this
      // request. Everything else about this failure is unchanged: no fallback,
      // no retry, same error to the caller. A rate-limit 429 alerts nothing.
      if (outOfCredit) {
        notifyVendorOutOfCredit({
          vendor,
          vendorLabel: config.label,
          model,
          status: res.status,
          vendorMessage: text.slice(0, 500),
        });
      }

      // A rate limit is the one completed response worth replaying: the vendor
      // turned the request away at the door, so no model ran and nothing was
      // billed — and the slot it was waiting on frees up on its own.
      //
      // Out-of-credit is excluded even though TWO of the three vendors report
      // it with this same 429 (Z.ai code 1113, Moonshot
      // `exceeded_current_quota_error`). An empty balance does not clear by
      // waiting, so retrying it would burn the budget on a certainty and delay
      // the error the owner needs to see.
      if (res.status === 429 && !outOfCredit) {
        if (rateLimitAttempt < MAX_RATE_LIMIT_RETRIES) {
          const wait = parseRetryAfterMs(res.headers?.get?.("retry-after")) ??
            jittered(RATE_LIMIT_BACKOFF_MS[rateLimitAttempt] ?? 7500);
          console.warn(
            `[chat-service] [vendor:${vendor}] Rate limited on "${model}" ` +
              `(attempt ${rateLimitAttempt + 1}/${MAX_RATE_LIMIT_RETRIES + 1}), ` +
              `retrying in ${Math.round(wait)}ms: ${text.slice(0, 200)}`,
          );
          await sleep(wait);
          rateLimitWaitedMs += wait;
          rateLimitAttempt++;
          continue;
        }

        // Still refusing after the whole budget. That is capacity, not a blip,
        // and it must stay visible — so it gets its own error carrying how hard
        // we tried, rather than reading like any other upstream failure.
        const attempts = rateLimitAttempt + 1;
        console.error(
          `[chat-service] [vendor:${vendor}] Still rate limited on "${model}" after ${attempts} attempts ` +
            `over ${Math.round(rateLimitWaitedMs)}ms of backoff. Concurrency published for this model: ` +
            `${publishedConcurrency(vendor, model) ?? "not published"}.`,
        );
        throw new VendorRateLimitError(
          `[vendor:${vendor}] ${config.label} is rate limiting "${model}": still 429 after ${attempts} ` +
            `attempts over ${Math.round(rateLimitWaitedMs)}ms. The vendor is at capacity for this model ` +
            `(published concurrency: ${publishedConcurrency(vendor, model) ?? "not published"}). ` +
            `${text.slice(0, 300)}`,
          attempts,
          rateLimitWaitedMs,
          text,
        );
      }

      // A rejected request SHAPE is a configuration error, not a transient
      // one. Separate class so the route answers 400 with the vendor's own
      // words instead of "LLM call failed. Please try again." — the advice
      // that let a permanently-refused option burn 335 calls looking like
      // flakiness (incident 2026-08-25).
      if (isUnsupportedOptionRefusal(res.status)) {
        // When the request carried the reasoning-off field AND this model is
        // recorded as refusing it, say so in the same breath. The refusal is
        // the information — a model that cannot serve a structured workload
        // without being billed for reasoning is a model to stop routing to,
        // and that only gets acted on if the error names it.
        const reasoningNote =
          config.reasoning.kind === "disablable" &&
          config.reasoning.refusedBy[model] &&
          shouldDisableVendorReasoning(options)
            ? ` This request asked ${config.label} to disable reasoning, which this model refuses: ` +
              `${config.reasoning.refusedBy[model]}`
            : "";
        throw new VendorUnsupportedOptionError(
          `[vendor:${vendor}] ${config.label} rejected the request as sent (${res.status} from ${model}): ` +
            `${text.slice(0, 500)}. This is a request-configuration error — retrying will not help.` +
            `${reasoningNote} Vendor docs: ${config.docsUrl}`,
          res.status,
          text,
        );
      }

      throw new VendorProviderError(
        `[vendor:${vendor}] ${res.status} from ${model}: ${text.slice(0, 500)}`,
      );
    }

    const json = (await res.json()) as VendorResponseBody;
    const result = mapVendorResponse(vendor, model, json);

    // The vendor answered, so its balance is not empty — re-arm the alert.
    markVendorServing(vendor);

    // Reconciliation breadcrumb: the cache split drives what we declare, so log
    // it next to the totals rather than only the totals.
    console.log(
      `[chat-service] [vendor:${vendor}] model="${result.model}" ` +
        `in=${result.tokensInput} cached=${result.cachedInputTokens} out=${result.tokensOutput}`,
    );

    return result;
  }
}

/**
 * Caller-facing message for a key-service resolution failure.
 *
 * The three vendor keys are provisioned independently, so "which one is
 * missing" is the whole content of the error. Name the vendor and the slug the
 * key must be stored under — a generic "failed to resolve API key" sends the
 * reader to the wrong console.
 */
export function keyResolutionErrorMessage(provider: string, scope: "org" | "platform"): string {
  const suffix =
    scope === "platform"
      ? "Store the platform key in key-service under that provider slug."
      : "Ensure the key is configured in key-service under that provider slug.";
  if (isVendorProvider(provider)) {
    const { label, docsUrl } = VENDORS[provider];
    return (
      `Failed to resolve the ${label} API key (key-service provider "${provider}"). ` +
      `${suffix} Vendor docs: ${docsUrl}`
    );
  }
  return `Failed to resolve ${provider} API key. ${suffix}`;
}
