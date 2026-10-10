import Anthropic from "@anthropic-ai/sdk";
import {
  anthropicPromptTokens,
  readAnthropicBilledTokens,
  type AnthropicBilledTokens,
} from "./anthropic-usage.js";
import { OPEN_PAGE_TOOL, PRESENT_CHOICES_TOOL } from "./ui-tools.js";
import { STAFF_REQUEST_REPOS } from "./staff-requests.js";

export const MODEL = "claude-sonnet-4-6";
/** Cost-name prefix used by costs-service: {provider}-{model} */
export const COST_PREFIX = "anthropic-sonnet-4.6";
const MAX_TOKENS = 64_000;

/** Model-specific API timeouts in milliseconds. */
const ANTHROPIC_TIMEOUT_MS: Record<string, number> = {
  // Fable 5.1 reasons on every request and Anthropic's own guidance is that a
  // single request on a hard task can run many minutes — so it gets the longest
  // budget of the four, not the 10-minute fallback.
  "claude-fable-5-1": 20 * 60_000,   // 20 min — Fable
  "claude-opus-5-5": 15 * 60_000,    // 15 min — Opus
  "claude-sonnet-5-5": 10 * 60_000,  // 10 min — Sonnet
  "claude-opus-4-6": 15 * 60_000,    // 15 min — Opus
  "claude-sonnet-4-6": 10 * 60_000,  // 10 min — Sonnet
  "claude-haiku-5-5": 5 * 60_000,    //  5 min — Haiku
  "claude-haiku-4-5": 5 * 60_000,    //  5 min — Haiku
};
const DEFAULT_ANTHROPIC_TIMEOUT_MS = 10 * 60_000; // 10 min fallback

// ---------------------------------------------------------------------------
// Transient-error retry (shared by streaming /chat and non-streaming complete())
// ---------------------------------------------------------------------------

/** Max retries on transient Anthropic errors (overloaded, 429, 5xx). */
export const ANTHROPIC_STREAM_MAX_RETRIES = 2;

/** Base delay for Anthropic retry backoff in ms. */
export const ANTHROPIC_STREAM_RETRY_BASE_MS = 2_000;

/**
 * Check if an Anthropic error is retryable (overloaded, rate-limited, or server error).
 * For streaming, the SDK throws `new APIError(undefined, parsedBody, ...)` mid-stream with
 * `status === undefined` — the retryable signal lives in the SSE payload `error.type`.
 */
export function isRetryableAnthropicError(err: unknown): boolean {
  if (!(err instanceof Anthropic.APIError)) return false;
  // During streaming, the SDK throws `new APIError(undefined, parsedBody, ...)` directly.
  // The `error` property is the raw SSE payload: { type: "error", error: { type: "overloaded_error", ... } }
  const errorBody = err.error as { type?: string; error?: { type?: string } } | undefined;
  if (errorBody?.error?.type === "overloaded_error") return true;
  // Standard retryable HTTP statuses (non-streaming or future SDK changes)
  if (typeof err.status === "number" && [429, 500, 503, 529].includes(err.status)) return true;
  return false;
}

/**
 * Extract retry-after delay from an Anthropic error's response headers.
 * Returns the delay in ms, or null if the header is missing.
 */
export function getRetryAfterMs(err: unknown): number | null {
  if (!(err instanceof Anthropic.APIError)) return null;
  const headers = err.headers as Headers | undefined;
  if (!headers) return null;
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** Backoff delay for retry attempt N: respects retry-after, else exponential + jitter. */
function anthropicRetryDelayMs(err: unknown, attempt: number): number {
  const retryAfter = getRetryAfterMs(err);
  return retryAfter ?? (ANTHROPIC_STREAM_RETRY_BASE_MS * 2 ** attempt + Math.random() * 500);
}

/**
 * Normalize a caller-supplied JSON Schema for Anthropic's strict structured-output
 * dialect before sending it via `output_config.format`.
 *
 * Anthropic's `json_schema` enforcement REQUIRES every `type: "object"` node to
 * carry an explicit `additionalProperties: false`. A permissive schema that omits
 * it returns HTTP 400 (`output_config.format.schema: For 'object' type,
 * 'additionalProperties' must be explicitly set to false`) and — because /complete
 * has no fallback parsing — kills the chat turn. Standard JSON-Schema-7 / Zod output
 * does not emit the key, so we stamp it onto every object node here.
 *
 * This is the mirror image of `sanitizeGeminiSchema` (which STRIPS the key, since
 * Gemini's OpenAPI-3.0 subset rejects it). Schema normalization for a provider's
 * dialect — NOT prompt enrichment; the caller's prompt is untouched.
 *
 * Walks `properties`, `items`, `anyOf`/`allOf`/`oneOf`, and `$defs`/`definitions`.
 * Preserves an `additionalProperties` value the caller set explicitly (no clobber).
 * Returns a new object; the caller's schema is not mutated.
 */
export function prepareAnthropicSchema<T>(schema: T): T {
  if (Array.isArray(schema)) {
    return schema.map((item) => prepareAnthropicSchema(item)) as unknown as T;
  }
  if (schema === null || typeof schema !== "object") {
    return schema;
  }
  const source = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = prepareAnthropicSchema(value);
  }
  if (out.type === "object" && !("additionalProperties" in out)) {
    out.additionalProperties = false;
  }
  return out as unknown as T;
}

// ---------------------------------------------------------------------------
// Provider + model alias → versioned API model ID + cost prefix
// Callers specify version-free aliases (e.g. "sonnet"); the service resolves
// the latest versioned model ID internally.
// ---------------------------------------------------------------------------

export type Provider = "anthropic" | "google" | "deepseek" | "zai" | "moonshot" | "openai";
export type ModelAlias =
  | "haiku"
  | "sonnet"
  | "opus"
  | "fable"
  | "flash-lite"
  | "flash"
  | "flash-pro"
  | "pro"
  | "deepseek-flash"
  | "deepseek-pro"
  | "glm-flash"
  | "glm-pro"
  | "kimi-flash"
  | "kimi-pro"
  | "gpt-pro"
  | "gpt-sol"
  | "gpt-terra";

/**
 * How capable the model behind an alias is, in three levels.
 *
 * This is a DECISION recorded per alias, never a rule applied to its name. The
 * naming pattern this file uses elsewhere (`<family>-flash` cheap, `<family>-pro`
 * strong) describes most of the map and is wrong about the rest, so a consumer
 * that split on the string would get those wrong silently:
 *
 *   • `flash-pro` contains "pro" and resolves to a Flash model — cheap.
 *   • `deepseek-pro` is a deprecated synonym pointing at V4.1 Flash — cheap.
 *   • `gpt-pro` and `glm-pro` share a suffix at 7x the output price apart —
 *     frontier and strong respectively.
 *
 * The levels:
 *   • `cheap`    — the small/fast tier a vendor sells for volume.
 *   • `strong`   — the vendor's main workhorse flagship.
 *   • `frontier` — the premium tier ABOVE that flagship, priced there.
 *
 * Read by features-service to rank the workflows a campaign can run: the tier
 * of the model writing the email decides the outcome, so a campaign selling a
 * reply and one selling a click want different tiers.
 */
export type CapabilityTier = "cheap" | "strong" | "frontier";

interface ResolvedModel {
  /** Versioned model ID sent to the provider's API */
  apiModelId: string;
  /** Cost-name prefix for costs-service */
  costPrefix: string;
  /** Provider key used for key-service resolution */
  provider: Provider;
  /**
   * Capability tier of the model this alias resolves to. REQUIRED — a new
   * alias does not compile until someone decides its tier, which is the point:
   * there is no default to fall back to and no string rule to infer it from.
   */
  capabilityTier: CapabilityTier;
}

const MODEL_MAP: Record<string, Record<string, ResolvedModel>> = {
  anthropic: {
    // `haiku` → Claude Haiku 5.5 since 2026-10-09 (was Haiku 4.5, which nothing
    // may route to any more — owner rule). $0.10 / $0.50 per 1M under a 100k
    // prompt, $0.50 / $2.50 over it: the first Anthropic model priced by prompt
    // length, see ANTHROPIC_LONG_CONTEXT_THRESHOLDS in anthropic-usage.ts.
    // Probed live with the platform key the same day: plain, json_schema
    // output_config, tools, prompt caching (5m write then read) and the full
    // /chat stream shape (adaptive thinking + compaction + context edits) each
    // → 200; `temperature` → 400 like the other 5.5 models. Before the move the
    // alias served 2 calls in 30 days.
    haiku: { apiModelId: "claude-haiku-5-5", costPrefix: "anthropic-haiku-5.5", provider: "anthropic", capabilityTier: "cheap" },
    // `sonnet` / `opus` are version-free aliases, so they follow the current
    // generation: repointed 2026-09-29 from Sonnet 4.6 / Opus 4.6 to Claude
    // Sonnet 5.5 ($2 / $10 per 1M, cache hit $0.20) and Claude Opus 5.5
    // ($4 / $20 per 1M, cache hit $0.20) — both CHEAPER than the 4.6 models
    // they replace. The public onboarding moves onto `sonnet`.
    //
    // Probed live against api.anthropic.com with the platform key the same day,
    // using the exact request shape `/complete` builds:
    //   • plain, `output_config.format` json_schema, and web_search_20250305
    //     each → 200 (structured output returns valid JSON).
    //   • `temperature: 0.3` → 400 "`temperature` is deprecated for this model"
    //     on BOTH — hence ANTHROPIC_SAMPLING_UNSUPPORTED below.
    //   • thinking cannot be disabled on either (`{type:"disabled"}` is a 400),
    //     so `disableThinking` lowers `output_config.effort` to `low` instead —
    //     see ANTHROPIC_EFFORT_FLOOR. Opus 5.5 defaults to effort `medium`,
    //     Sonnet 5.5 to `high`.
    // Before the move, `opus` served 11 runs in 30 days and `sonnet` none; no
    // chat config row names either. The 4.6 cost prefixes stay priced so past
    // spend keeps resolving (SUPPORTED_MODELS keeps mapping them).
    sonnet: { apiModelId: "claude-sonnet-5-5", costPrefix: "anthropic-sonnet-5.5", provider: "anthropic", capabilityTier: "strong" },
    opus: { apiModelId: "claude-opus-5-5", costPrefix: "anthropic-opus-5.5", provider: "anthropic", capabilityTier: "frontier" },
    // Claude Fable 5.1 — Anthropic's most capable widely released model, a tier
    // ABOVE Opus and priced there ($10 / $50 per 1M against Opus 4.6's rates).
    // Added 2026-09-09 for a cold-email template A/B; no existing alias moves.
    //
    // Three API facts about this model that the other three Anthropic aliases
    // do not share, all of them 400s rather than degradations:
    //   • Thinking is ALWAYS ON and cannot be configured. `/complete` never
    //     sends a `thinking` block, so this path is already correct — but it
    //     means `disableThinking` stays the documented no-op it is on every
    //     Anthropic model, and cannot become anything else here.
    //   • Sampling parameters are REMOVED — temperature / top_p / top_k each
    //     return 400. See `anthropicRejectsSampling` below; a caller sending
    //     `temperature` is refused before any spend rather than after.
    //   • Forced tool use and assistant prefill are removed. Neither is on the
    //     `/complete` path, which sends no tools and no prefill.
    fable: { apiModelId: "claude-fable-5-1", costPrefix: "anthropic-fable-5.1", provider: "anthropic", capabilityTier: "frontier" },
  },
  google: {
    "flash-lite": { apiModelId: "gemini-3.1-flash-lite", costPrefix: "google-flash-lite-3.1", provider: "google", capabilityTier: "cheap" },
    // "flash" alias → Gemini 3.5 Flash-Lite (GA, cheaper than the retired Flash-3 preview). 2026-07-24.
    "flash": { apiModelId: "gemini-3.5-flash-lite", costPrefix: "google-flash-lite-3.5", provider: "google", capabilityTier: "cheap" },
    // "flash-pro" alias → Gemini 3.8 Flash (GA mid-tier). Same list price as the 3.7 Flash it
    // replaces ($1.50/$7.50 per MTok from 2027-01-01, both on the same promo until then), with
    // upgraded long-horizon / agentic quality. Verified before the swap on all three axes the
    // 3.6→3.7 upgrade collapsed into one: price (identical, per Google's pricing page read
    // 2026-09-05), thinking floor (both reject "minimal", so `disableThinking` still resolves —
    // the 3.7 swap shipped a guessed floor and 400'd every disableThinking call for 10 days),
    // and a live-API probe. DIS-130; 3.5→3.6 2026-07-24, 3.6→3.7 2026-08-14, 3.7→3.8 2026-09-05.
    //
    // capabilityTier is "cheap" and the alias name says "pro": the alias is named
    // for where it sits among the Gemini aliases (above `flash`), while the tier
    // describes the MODEL, which is a Flash. Do not "correct" this to "strong",
    // and do not derive any tier from an alias string.
    "flash-pro": { apiModelId: "gemini-3.8-flash", costPrefix: "google-flash-3.8", provider: "google", capabilityTier: "cheap" },
    "pro": { apiModelId: "gemini-3.1-pro-preview", costPrefix: "google-pro-3.1", provider: "google", capabilityTier: "strong" },
  },
  // ---------------------------------------------------------------------
  // Direct-vendor models — one OpenAI-compatible adapter, three vendors.
  //
  // Each vendor is its own `provider` (and its own key-service slug), served by
  // the SAME client (src/lib/openai-compatible.ts). Two tiers per vendor,
  // named on one pattern: `<family>-flash` = the cheap tier, `<family>-pro` =
  // the strong tier. The two DeepSeek aliases predate the direct path and are
  // unchanged from the caller's side — only the transport underneath moved
  // (2026-08-15), so `deepseek-flash` / `deepseek-pro` keep working verbatim.
  //
  // EVERY alias here costs THREE costs-service catalog rows —
  // `<costPrefix>-tokens-input`, `-tokens-output` and `-tokens-cached-input` —
  // which must exist in PRODUCTION before the alias ships, or runs-service 422s
  // and the call fails loud. resolveModel throws on any alias absent from this
  // map, so a vendor's full catalog never becomes OUR catalog: a model is
  // unreachable until someone deliberately adds it here AND to costs-service.
  //
  // costPrefix follows the costs-service catalog's own shape (verified against
  // its seed, v0.44.0): the vendor's model id, prefixed with the vendor slug
  // UNLESS the id already names the vendor. So `glm-5.2` becomes `zai-glm-5.2`
  // while `deepseek-v4.1-flash` stays bare. These strings are byte-equal to the
  // catalog rows — a prefix the catalog does not carry is 422-rejected at
  // declaration and fails the request.
  //
  // The convention describes the SHAPE, not a derivation: costs-service owns
  // these names and this map conforms to what it actually seeded. DeepSeek's
  // V4.1 Flash is the case that proves it — the wire id is `deepseek-flash`
  // (the vendor dropped the version from the id) while the catalog row is
  // `deepseek-v4.1-flash`, which keeps the generation legible next to the
  // frozen `deepseek-v4-flash` and `deepseek-v4-pro` rows beside it. So
  // apiModelId and costPrefix DIFFER here on purpose; do not "fix" one to
  // match the other. Read the catalog before changing either:
  //   git -C ~/conductor/repos/costs-service grep 'name: "' origin/main -- src/db/seed.ts
  // ---------------------------------------------------------------------
  // Both DeepSeek aliases resolve to V4.1 Flash as of 2026-09-10, because the
  // vendor collapsed its catalog to one model and renamed the id underneath us.
  //
  // https://api-docs.deepseek.com/quick_start/pricing — re-read 2026-09-10.
  // `GET /v1/models` that day listed exactly two ids, `deepseek-flash` and
  // `deepseek-v4-pro`; `deepseek-v4-flash` was gone from the listing. It still
  // ACCEPTED a request and answered `model: "deepseek-flash"`, which is the
  // shape assertModelMatches is built to refuse — so the `deepseek-flash` alias
  // was 502-ing every call from the moment V4.1 Flash shipped (04:00 UTC that
  // day), with instantly-service's reply classification and warmup messages as
  // the live casualties. The guard did its job: it will not declare spend under
  // the name of a model that did not answer.
  //
  // The V4 Pro half is dated rather than broken. DeepSeek is discontinuing that
  // service at 12:00 Beijing on 2026-09-14 (04:00 UTC), after which requests to
  // `deepseek-v4-pro` are routed to V4.1 Flash and billed at the Flash price —
  // i.e. exactly the same silent substitution, four days later, and it would
  // fail exactly the same way. Pointing the alias at the surviving model now
  // makes that explicit and correctly priced instead of waiting to break.
  //
  // `deepseek-pro` is therefore a DEPRECATED SYNONYM, kept rather than deleted:
  // removing an alias is a breaking request-contract change and apollo-service
  // and content-generation-service both still send it. Retiring the name is its
  // own deliberate ship, coordinated with those two.
  deepseek: {
    // DeepSeek V4.1 Flash, released 2026-09-10. The vendor's announcement:
    // "V4.1 Flash has comprehensively surpassed V4 Pro across all key metrics,
    // including performance, cost, speed, and task completion time."
    //
    // It is a NEW model, not a re-price of V4 Flash — peak cache-miss input is
    // $0.3/1M against V4 Flash's $0.44/1M — so it carries its own catalog rows
    // and its own cost prefix. Reaching it was gated on those rows being live
    // in production; the four V4 Flash / V4 Pro prefixes stay priced in the
    // catalog so spend already declared against them keeps resolving.
    //
    // All three capability axes were re-probed against the live API on
    // 2026-09-10 rather than inherited: `response_format: {type:"json_schema"}`
    // is still refused (`400 "This response_format type is unavailable now"`)
    // while `json_object` answers 200; `thinking: {"type":"disabled"}` still
    // silences reasoning (311 → 0 reasoning chars, 87 → 32 output tokens) while
    // `reasoning_effort: "minimal"` is still ignored; and the usage payload
    // still reports the cache split under `prompt_cache_hit_tokens`. So the
    // vendor descriptor below is unchanged — but it was CHECKED, not assumed.
    "deepseek-flash": {
      apiModelId: "deepseek-flash",
      costPrefix: "deepseek-v4.1-flash",
      provider: "deepseek",
      capabilityTier: "cheap",
    },
    "deepseek-pro": {
      apiModelId: "deepseek-flash",
      costPrefix: "deepseek-v4.1-flash",
      provider: "deepseek",
      capabilityTier: "cheap",
    },
  },
  zai: {
    // https://docs.z.ai/guides/overview/pricing — read 2026-08-15.
    // GLM-5.3-Flash. Repointed from glm-4.7-flashx on 2026-08-31.
    //
    // This one is a deliberate PRICE INCREASE, which is worth stating plainly
    // because every other alias move here has been neutral or cheaper:
    // glm-4.7-flashx lists at $0.07 / $0.01 cached / $0.40 per 1M against
    // GLM-5.3-Flash's $0.15 / $0.03 / $0.50. Roughly 2x on input, 1.25x on
    // output, on a tier where the absolute numbers are small enough that the
    // difference is noise next to `glm-pro`'s $1.4 / $4.4.
    //
    // Bought against three things: FIFTY published in-flight requests (the most
    // of any model we reach, against NO published limit at all for
    // glm-4.7-flashx — `publishedConcurrency` returns null there, which is an
    // honest "not published", not a high number), two generations of model, and
    // an exit from a model Z.ai has dropped from its own `/models` listing.
    //
    // That listing absence is the part worth watching: glm-4.7-flashx still
    // serves normally (probed 2026-08-31, a full answer at 1,508 output
    // tokens), so nothing is broken today — but a model the vendor no longer
    // lists is a model to be off before it stops answering, not after.
    //
    // Takes `reasoning_effort` like the rest of the 5.3 family, NOT `thinking`
    // — see the `perModel` entry in openai-compatible.ts.
    "glm-flash": {
      apiModelId: "glm-5.3-flash",
      costPrefix: "zai-glm-5.3-flash",
      provider: "zai",
      capabilityTier: "cheap",
    },
    // GLM-5.3. Z.ai's flagship tier, at the concurrency we can actually run it
    // at — which is a different sentence today than it was a week ago.
    //
    // This alias went 5.2 → 5.3 on 2026-08-20, back to 5.2 on 2026-08-25, and
    // to 5.3 again on 2026-08-31. Worth reading the whole arc before moving it
    // a fourth time, because the two moves failed for opposite reasons:
    //
    //   The 2026-08-20 swap was justified on PRICE ALONE — identical list price
    //   ($1.4 / $0.26 cached / $4.4 per 1M), therefore "drop-in". Z.ai caps
    //   requests IN FLIGHT per model, and on that axis the models were not
    //   interchangeable at all: 5.2 served ten, 5.3 served ONE. Three cold-email
    //   workflows sharing that slot produced 127 rate-limit refusals in five
    //   hours and killed about half their runs — and a run that dies at the LLM
    //   has already paid for its lead enrichment, so roughly two thirds of what
    //   those workflows spent bought no email.
    //
    //   The 2026-08-31 move is justified on the two axes that failed before,
    //   both re-measured against the live API rather than inferred: Z.ai raised
    //   5.3 to FIFTEEN in-flight requests (12/12 parallel completions returned
    //   200, against 2/6 six days earlier), and the reasoning control that 5.3
    //   refuses under `thinking` works under `reasoning_effort` — see the
    //   `perModel` entry in openai-compatible.ts. Structured output costs 514
    //   output tokens against 5.2's 531, at the same price.
    //
    // What did NOT change is the rule the first swap broke: price is one axis
    // of three. A model is reachable here when its price, its published
    // concurrency AND its reasoning control have each been checked, and a
    // regression test fails the build if an alias lands on a one-slot model.
    "glm-pro": {
      apiModelId: "glm-5.3",
      costPrefix: "zai-glm-5.3",
      provider: "zai",
      capabilityTier: "strong",
    },
  },
  moonshot: {
    // https://platform.kimi.ai/docs/pricing/chat — read 2026-08-15.
    "kimi-flash": {
      apiModelId: "kimi-k2.6",
      costPrefix: "moonshot-kimi-k2.6",
      provider: "moonshot",
      capabilityTier: "cheap",
    },
    "kimi-pro": {
      apiModelId: "kimi-k3",
      costPrefix: "moonshot-kimi-k3",
      provider: "moonshot",
      capabilityTier: "strong",
    },
  },
  openai: {
    // https://developers.openai.com/api/docs/models/gpt-6-astra — read
    // 2026-09-09. GPT-6 Astra, OpenAI's flagship: 1,050,000-token context,
    // 128k max output, $10 / $1 cached / $50 per 1M. The most expensive output
    // rate of any model this service reaches, which is why the reasoning floor
    // in openai-compatible.ts matters more here than anywhere else.
    //
    // `gpt-pro` follows the naming every direct-vendor alias uses — the family,
    // then the tier — so a caller reads it the same way as `glm-pro` and
    // `kimi-pro`. There is deliberately no `gpt-flash`: an alias costs three
    // catalog rows and exists only when someone wants it, so the vendor's
    // catalog never becomes ours by default.
    "gpt-pro": {
      apiModelId: "gpt-6-astra",
      costPrefix: "openai-gpt-6-astra",
      provider: "openai",
      capabilityTier: "frontier",
    },
    // Added 2026-09-29 so the onboarding's Sonnet 5.5 can be compared against
    // OpenAI's same-price models. Both ids read off OpenAI's live /v1/models
    // the same day, which lists gpt-6-astra, gpt-6-sol and gpt-6-luna for GPT-6
    // and has NO gpt-6-terra — the newest Terra is gpt-5.6-terra. So
    // `gpt-terra` is "the latest Terra", exactly the version-free meaning every
    // other alias has, and it moves when OpenAI ships a GPT-6 Terra.
    //
    //   gpt-6-sol     $2 / $0.20 cached / $10 per 1M  — Sonnet 5.5's price
    //   gpt-5.6-terra $2 / $0.20 cached / $12 per 1M
    //
    // Both "strong": same price band as Sonnet 5.5, well below Astra's $10/$50.
    // Capabilities were probed live, not inherited from Astra — they differ on
    // reasoning (see the `perModel` entry in openai-compatible.ts).
    "gpt-sol": {
      apiModelId: "gpt-6-sol",
      costPrefix: "openai-gpt-6-sol",
      provider: "openai",
      capabilityTier: "strong",
    },
    "gpt-terra": {
      apiModelId: "gpt-5.6-terra",
      costPrefix: "openai-gpt-5.6-terra",
      provider: "openai",
      capabilityTier: "strong",
    },
  },
};

/** Valid model aliases per provider — used for Zod validation. */
export const PROVIDER_MODELS: Record<Provider, readonly ModelAlias[]> = {
  anthropic: ["haiku", "sonnet", "opus", "fable"],
  google: ["flash-lite", "flash", "flash-pro", "pro"],
  deepseek: ["deepseek-flash", "deepseek-pro"],
  zai: ["glm-flash", "glm-pro"],
  moonshot: ["kimi-flash", "kimi-pro"],
  openai: ["gpt-pro", "gpt-sol", "gpt-terra"],
};

/**
 * Resolve a (provider, model alias) pair to the versioned API model ID,
 * cost prefix, and provider string.
 * Throws if the combination is invalid.
 */
export function resolveModel(provider: Provider, modelAlias: ModelAlias): ResolvedModel {
  const providerMap = MODEL_MAP[provider];
  if (!providerMap) {
    throw new Error(
      `Unknown provider: ${provider}. Accepted providers: ${Object.keys(MODEL_MAP).join(", ")}`,
    );
  }
  const resolved = providerMap[modelAlias];
  if (!resolved) {
    // Name the accepted set. An alias that is real but sent under the wrong
    // provider is the common mistake, so say where it does live.
    const elsewhere = (Object.keys(MODEL_MAP) as Provider[]).find(
      (p) => p !== provider && MODEL_MAP[p][modelAlias],
    );
    throw new Error(
      `Unknown model "${modelAlias}" for provider "${provider}". ` +
        `Accepted models for "${provider}": ${Object.keys(providerMap).join(", ")}.` +
        (elsewhere ? ` "${modelAlias}" belongs to provider "${elsewhere}".` : ""),
    );
  }
  return resolved;
}

/**
 * The capability tier recorded for an alias.
 *
 * Throws through `resolveModel` on an alias this service cannot resolve — an
 * unknown alias has no tier and must not be given one. There is no default.
 */
export function capabilityTierFor(provider: Provider, modelAlias: ModelAlias): CapabilityTier {
  return resolveModel(provider, modelAlias).capabilityTier;
}

export interface ModelCatalogueEntry {
  provider: Provider;
  model: ModelAlias;
  capabilityTier: CapabilityTier;
}

/**
 * Every alias this service can resolve, with its tier — the whole catalogue in
 * one value, for a consumer that needs to know the tiers before it has a model
 * in hand (features-service ranking workflows by the model each one names).
 *
 * Built by walking `PROVIDER_MODELS` through `resolveModel`, so an alias the
 * validation list advertises but `MODEL_MAP` does not carry throws here rather
 * than being quietly skipped.
 */
export function modelCatalogue(): ModelCatalogueEntry[] {
  return (Object.keys(PROVIDER_MODELS) as Provider[]).flatMap((provider) =>
    PROVIDER_MODELS[provider].map((model) => ({
      provider,
      model,
      capabilityTier: capabilityTierFor(provider, model),
    })),
  );
}

// ---------------------------------------------------------------------------
// Anthropic sampling support — per MODEL data, never inferred from the family
// ---------------------------------------------------------------------------

/**
 * Anthropic model ids that REJECT the sampling parameters.
 *
 * `temperature`, `top_p` and `top_k` were removed on the always-thinking
 * models: Fable 5 / 5.1, Opus 5.5 / 5 / 4.8 / 4.7 and Sonnet 5.5 / 5 each answer
 * 400 when one is sent. Only the models reachable from this service are listed
 * (Fable 5.1, Sonnet 5.5, Opus 5.5) — the set records what we actually serve, exactly like
 * `GEMINI_3_THINKING_FLOOR`, and a model is added here when its alias is.
 *
 * Recorded rather than worked around, and it is a real behaviour change to be
 * aware of when reading a caller's request: `temperature` is a live field on
 * POST /complete that six existing aliases honour, so the first caller to
 * A/B a template against Fable with its existing body would otherwise get an
 * Anthropic 400 whose text says nothing about which alias caused it.
 *
 * Note the failure this does NOT hide: the parameter is not silently dropped.
 * Dropping it would answer 200 from a model sampling differently from what the
 * caller asked for, which is the same class of quiet wrongness as serving a
 * fallback model — see the `refusedBy` note in openai-compatible.ts.
 *
 * Source: Anthropic's model-migration guidance for the 4.7+ family, read
 * 2026-09-09, and confirmed against the live API the same day — the identical
 * request that returns 200 without it answers
 * `400 invalid_request_error: "\`temperature\` is deprecated for this model."`
 * with it.
 */
const ANTHROPIC_SAMPLING_UNSUPPORTED = new Set([
  "claude-fable-5-1",
  // Probed live 2026-09-29: temperature 0.3 → 400 on both; only the default (1) passes.
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  // Probed live 2026-10-09: temperature 0.3 → 400 "`temperature` is deprecated for this model."
  "claude-haiku-5-5",
]);

/**
 * The effort `disableThinking: true` lowers an Anthropic model to — per MODEL,
 * never inferred from the family.
 *
 * Sonnet 5.5 and Opus 5.5 cannot turn thinking off (`{type: "disabled"}` is a
 * 400), and `/complete` never sends a `thinking` block, so they run adaptive
 * thinking at their default effort (`high` on Sonnet 5.5, `medium` on Opus
 * 5.5). Thinking is billed as output tokens nobody reads on a structured call,
 * so the knob keeps the meaning it has on Gemini 3 and GPT-6 Astra: MINIMIZE,
 * not zero — `output_config.effort: "low"`, accepted by both alongside
 * `output_config.format` (probed live 2026-09-29, 200 with valid JSON).
 *
 * A model absent from this table keeps `disableThinking` as the no-op it has
 * always been on Anthropic: Haiku 4.5 never thinks on this path, and Fable 5.1
 * is deliberately left unchanged so its existing callers see no difference.
 */
const ANTHROPIC_EFFORT_FLOOR: Record<string, "low"> = {
  "claude-sonnet-5-5": "low",
  "claude-opus-5-5": "low",
};

/** The effort `disableThinking` lowers this model to, or null when it is a no-op. */
export function anthropicEffortFloor(apiModelId: string): "low" | null {
  return ANTHROPIC_EFFORT_FLOOR[apiModelId] ?? null;
}

/**
 * A caller sent a sampling parameter to a model that refuses it.
 *
 * Its own class so the completion routes can answer 400 (a request-shape error
 * that will be refused identically forever) rather than 502 ("please try
 * again"), which is the same distinction `VendorUnsupportedOptionError` draws
 * on the direct-vendor paths.
 */
export class AnthropicUnsupportedOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnthropicUnsupportedOptionError";
  }
}

/** True when this Anthropic model rejects `temperature` / `top_p` / `top_k`. */
export function anthropicRejectsSampling(apiModelId: string): boolean {
  return ANTHROPIC_SAMPLING_UNSUPPORTED.has(apiModelId);
}

/**
 * Fail loud when a caller pairs a sampling parameter with a model that refuses
 * it — before anything is fetched, held or spent.
 *
 * A no-op for every model that accepts sampling, and for a request that sends
 * none.
 */
export function assertAnthropicSamplingSupported(
  apiModelId: string,
  temperature: number | null | undefined,
): void {
  if (temperature == null || !anthropicRejectsSampling(apiModelId)) return;
  throw new AnthropicUnsupportedOptionError(
    `Model "${apiModelId}" does not accept the sampling parameters (temperature, top_p, top_k) — ` +
      `Anthropic removed them on its always-thinking models and answers 400 when one is sent. ` +
      `Re-send this request without "temperature", or use an alias whose model accepts it ` +
      `(a Gemini alias — every Anthropic alias is now a 5.x model that refuses it). Retrying as sent will not help.`,
  );
}

/**
 * @deprecated — kept for backward compat during migration. Use resolveModel instead.
 */
export const SUPPORTED_MODELS: Record<string, string> = {
  "claude-sonnet-4-6": "anthropic-sonnet-4.6",
  "claude-haiku-4-5": "anthropic-haiku-4.5",
  "claude-haiku-5-5": "anthropic-haiku-5.5",
  "claude-opus-4-6": "anthropic-opus-4.6",
  "claude-fable-5-1": "anthropic-fable-5.1",
  "claude-sonnet-5-5": "anthropic-sonnet-5.5",
  "claude-opus-5-5": "anthropic-opus-5.5",
  "gemini-3.1-flash-lite": "google-flash-lite-3.1",
  "gemini-3.5-flash-lite": "google-flash-lite-3.5",
  "gemini-3-flash-preview": "google-flash-3",
  "gemini-3.5-flash": "google-flash-3.5",
  "gemini-3.6-flash": "google-flash-3.6",
  "gemini-3.7-flash": "google-flash-3.7",
  "gemini-3.8-flash": "google-flash-3.8",
  "gemini-3.1-pro-preview": "google-pro-3.1",
  "gemini-2.5-pro": "google-pro-2.5",
  "gemini-2.5-flash": "google-flash-2.5",
  // Direct-vendor models: the cost prefix IS the vendor model id.
  "deepseek-flash": "deepseek-v4.1-flash",
  // The two retired DeepSeek ids stay mapped. Nothing SENDS them any more, but
  // this table is a reverse lookup from a model id to the prefix its spend was
  // declared under, and the fallback for an unknown id is the Anthropic default
  // — so deleting a row here would silently re-attribute a historical DeepSeek
  // model to `anthropic-sonnet-4.6` rather than fail.
  "deepseek-v4-flash": "deepseek-v4-flash",
  "deepseek-v4-pro": "deepseek-v4-pro",
  "glm-4.7-flashx": "zai-glm-4.7-flashx",
  "glm-5.3-flash": "zai-glm-5.3-flash",
  "glm-5.2": "zai-glm-5.2",
  "glm-5.3": "zai-glm-5.3",
  "kimi-k2.6": "moonshot-kimi-k2.6",
  "kimi-k3": "moonshot-kimi-k3",
  "gpt-6-astra": "openai-gpt-6-astra",
  "gpt-6-sol": "openai-gpt-6-sol",
  "gpt-5.6-terra": "openai-gpt-5.6-terra",
};

/** Resolve the cost prefix for a given model ID (falls back to default). */
export function costPrefixForModel(model: string): string {
  return SUPPORTED_MODELS[model] ?? COST_PREFIX;
}

// ---------------------------------------------------------------------------
// Tool definitions (Anthropic JSON Schema format)
// ---------------------------------------------------------------------------

export const REQUEST_USER_INPUT_TOOL: Anthropic.Tool = {
  name: "request_user_input",
  description:
    "Ask the user for structured input via a frontend widget. ONLY use this when you genuinely need information that you do not already have — check your context and conversation history first. NEVER use this for confirmations, yes/no questions, or to echo back values the user already provided. If the user confirms an action (e.g. says 'yes' or 'go ahead'), execute the action directly using the appropriate tool instead of sending another form.",
  input_schema: {
    type: "object" as const,
    properties: {
      input_type: {
        type: "string",
        description: "The type of input widget to render: url, text, or email",
      },
      label: {
        type: "string",
        description: "The label/question shown above the input field",
      },
      placeholder: {
        type: "string",
        description: "Placeholder text inside the input field",
      },
      field: {
        type: "string",
        description:
          "A key identifying what this input is for, e.g. brand_url",
      },
      value: {
        type: "string",
        description:
          "Optional pre-filled value for the input field. When you already have a suggested value (e.g. a description you generated), set this so the user only has to confirm. Omit to leave the field empty.",
      },
    },
    required: ["input_type", "label", "field"],
  },
};

export const CREATE_WORKFLOW_TOOL: Anthropic.Tool = {
  name: "create_workflow",
  description:
    "Create a brand-new workflow dynasty from a natural-language description. Uses an LLM on workflow-service to generate a valid DAG, validates it, and deploys it. Use this ONLY when no existing workflow is being modified — e.g. the user is starting from scratch. If an existing workflow is being changed in any way, use upgrade_workflow (fixing a bug or repairing incorrect/broken behavior — even when the fix adds/removes/rewires nodes — or clarifying metadata) or fork_workflow (introducing NEW behavior/scope/intent/audience; requires explicit user confirmation) instead.",
  input_schema: {
    type: "object" as const,
    properties: {
      description: {
        type: "string",
        description:
          "Natural-language description of the desired workflow. Be specific about steps, services, and data flow. Minimum 10 characters.",
      },
      featureSlug: {
        type: "string",
        description:
          "Feature slug from features-service (e.g. 'cold-email-outreach'). Required — used to build the workflow slug.",
      },
      hints: {
        type: "object",
        description:
          "Optional hints to guide generation. Can include: services (array of service names to scope to), nodeTypes (suggested node types), expectedInputs (expected flow_input field names like 'campaignId').",
      },
      style: {
        type: "object",
        description:
          "Optional style configuration. When provided, the workflow is generated in the style of the specified human or brand, and the signatureName uses the style name with auto-versioning (e.g. 'hormozi-v1').",
        properties: {
          type: {
            type: "string",
            enum: ["human", "brand"],
            description:
              "Style source type. 'human' for an industry expert, 'brand' for a company/organization.",
          },
          humanId: {
            type: "string",
            description: "Human ID from human-service. Required when type is 'human'.",
          },
          brandId: {
            type: "string",
            description: "Brand ID from brand-service. Required when type is 'brand'.",
          },
          name: {
            type: "string",
            description:
              "Display name of the human or brand (e.g. 'Hormozi'). Used to build the signatureName.",
          },
        },
        required: ["type", "name"],
      },
    },
    required: ["description", "featureSlug"],
  },
};

export const UPGRADE_WORKFLOW_TOOL: Anthropic.Tool = {
  name: "upgrade_workflow",
  description:
    "Re-generate the DAG of an existing workflow while keeping the SAME dynasty/lineage. Returns the workflow in the same dynasty (possibly as a new version row when the regenerated DAG signature differs from the previous one).\n\n" +
    "HARD RULE — DO NOT VIOLATE EVEN IF THE USER ASKS YOU TO: the discriminator between upgrade_workflow and fork_workflow is INTENT, not whether the DAG topology changes. upgrade_workflow is the correct tool whenever you are (a) fixing a bug or repairing incorrect / broken / non-functional behavior in the existing workflow — EVEN IF the fix changes the DAG topology (adds, removes, or rewires nodes/edges) — or (b) clarifying metadata that is factually wrong or imprecise. Example: a workflow that runs but passes the wrong URL into a node, where the fix adds a node to fetch the correct value, is an UPGRADE — it repairs incorrect behavior within the same dynasty. Only introducing NEW behavior, scope, intent, or audience is a fork. Upgrade keeps the same lineage; fork starts a new one. A structural / topology change (adding, removing, or rewiring nodes) does NOT by itself require a fork.\n\n" +
    "HARD RULE — DO NOT VIOLATE EVEN IF THE USER ASKS YOU TO: for any surgical fix on a working DAG — `$ref` path corrections, edge wiring, missing/wrong field on a single node, output-key rename, template-version bump — call get_workflow_details first, modify the DAG in memory, and pass the COMPLETE corrected DAG as `dag`. workflow-service applies that DAG verbatim with no LLM regen. Passing `description` only triggers a full LLM DAG regeneration which routinely drifts: template versions downgrade, nodes get deleted, fields disappear, working bits regress. `description`-only is reserved for cases where you genuinely do not have the DAG (e.g. the user gave a fuzzy natural-language change request and no get_workflow_details was called).\n\n" +
    "At least one of `dag` / `description` is required; you may pass both (description then replaces the stored description on the resulting row).",
  input_schema: {
    type: "object" as const,
    properties: {
      workflowDynastySlug: {
        type: "string",
        description:
          "Stable dynasty slug of the workflow to upgrade (e.g. 'cold-email-outreach-nova'). Constant across all versions of the dynasty — workflow-service resolves it to the currently-active row, so you do NOT need to track which version is active after prior upgrades. Use the `workflowDynastySlug` field returned by get_workflow_details — NOT the versioned `workflowSlug` (e.g. `...-v3`) and NOT the UUID.",
      },
      description: {
        type: "string",
        description:
          "Natural-language description of the upgrade. Must describe the bug being fixed, the incorrect/broken behavior being repaired (topology changes such as adding/removing/rewiring a node are fine — they stay in the same dynasty), the technical defect being repaired, or the metadata being clarified — not a new behavior. Minimum 10 characters. Required when `dag` is not supplied. Avoid description-only for surgical fixes (see HARD RULE in the tool description) — it triggers full LLM regen and routinely drifts.",
      },
      hints: {
        type: "object",
        description:
          "Optional hints to guide regeneration. Ignored when `dag` is provided. Must be an object, NOT an array of strings.",
        properties: {
          services: {
            type: "array",
            items: { type: "string" },
            description:
              "Scope generation to these service names (e.g. ['apollo', 'instantly']). Reduces prompt size and improves accuracy.",
          },
          nodeTypes: {
            type: "array",
            items: { type: "string" },
            description:
              "Suggested node types for the LLM to use (e.g. ['http.call', 'script']).",
          },
          expectedInputs: {
            type: "array",
            items: { type: "string" },
            description:
              "Expected flow_input field names the regenerated workflow should consume (e.g. ['campaignId', 'email']).",
          },
        },
      },
      dag: {
        type: "object",
        description:
          "Full corrected DAG (nodes + edges). When supplied, workflow-service skips LLM regeneration and applies this DAG verbatim — REQUIRED for surgical fixes (broken $ref paths, miswired edges, wrong field on one node, template-version bump). Must be the COMPLETE DAG (call get_workflow_details first, modify, pass the full result). Partial DAGs are not supported. Every node must carry its FULL `config` for its type — e.g. a `script` node requires a non-empty `config.code` (inline JS string). Omitting a required config field fails validation (e.g. `nodes[<id>].config.code missing required config field \"code\"`); never emit a node with an empty or partial config.",
      },
    },
    required: ["workflowDynastySlug"],
  },
};

export const FORK_WORKFLOW_TOOL: Anthropic.Tool = {
  name: "fork_workflow",
  description:
    "Fork a workflow into a NEW dynasty/lineage by submitting a new DAG. Use this ONLY to introduce NEW behavior, NEW scope, NEW intent, or a NEW audience. A structural / topology change (adding, removing, or rewiring nodes) does NOT by itself justify a fork — if the change repairs incorrect or broken behavior, it is a bug fix and MUST use upgrade_workflow instead, even when it changes topology.\n\n" +
    "HARD RULE — DO NOT VIOLATE EVEN IF THE USER ASKS YOU TO: a fork creates a NEW production dynasty and changes which workflow future campaigns run — this is effectively irreversible. NEVER call fork_workflow without explicit user confirmation in the conversation that they want a fork (a new dynasty). If the user asked for an upgrade, NEVER fork. If you believe a change genuinely requires a fork, STOP and ask the user first — do not fork silently.\n\n" +
    "The original workflow stays active under its own lineage; this creates a new one. If the submitted DAG has the same signature as the source, no fork happens (returns _action: 'updated') — that's expected, not an error.\n\n" +
    "Always call get_workflow_details first to read the current DAG, modify it, and pass the COMPLETE updated DAG — partial DAGs are not supported.",
  input_schema: {
    type: "object" as const,
    properties: {
      workflowId: {
        type: "string",
        description:
          "UUID of the source workflow to fork from. If available in context, use it directly — do NOT ask the user for it.",
      },
      dag: {
        type: "object",
        description:
          "Full DAG definition with nodes and edges. Must include the complete DAG — partial updates are not supported. Use get_workflow_details first to read the current DAG, then modify and pass the full result. Every node must carry its FULL `config` for its type — e.g. a `script` node requires a non-empty `config.code` (inline JS string); omitting a required config field fails validation.",
      },
    },
    required: ["workflowId", "dag"],
  },
};

export const VALIDATE_WORKFLOW_TOOL: Anthropic.Tool = {
  name: "validate_workflow",
  description:
    "Validate a workflow's DAG structure. Returns whether the workflow is valid and any errors found. Use this when the user asks to check or validate a workflow.",
  input_schema: {
    type: "object" as const,
    properties: {
      workflowId: {
        type: "string",
        description:
          "UUID of the workflow to validate. If available in context, use it directly — do NOT ask the user for it.",
      },
    },
    required: ["workflowId"],
  },
};

export const GET_PROMPT_TEMPLATE_TOOL: Anthropic.Tool = {
  name: "get_prompt_template",
  description:
    "Retrieve a stored prompt template by type from the content-generation service. Use this when the user asks to see, review, or check a prompt template (e.g. cold-email, follow-up).",
  input_schema: {
    type: "object" as const,
    properties: {
      type: {
        type: "string",
        description:
          "The prompt type to look up (e.g. 'cold-email', 'follow-up', 'sales-email')",
      },
    },
    required: ["type"],
  },
};

export const UPDATE_PROMPT_TEMPLATE_TOOL: Anthropic.Tool = {
  name: "update_prompt_template",
  description:
    "Create a new version of an existing prompt template. The original is never modified — a new version is created automatically (e.g. 'cold-email' → 'cold-email-v2'). Use this when the user wants to update, improve, or modify a prompt template.",
  input_schema: {
    type: "object" as const,
    properties: {
      sourceType: {
        type: "string",
        description:
          "The type of the existing prompt to version from (e.g. 'cold-email')",
      },
      prompt: {
        type: "string",
        description:
          "The new prompt template text with {{variable}} placeholders. Must NOT contain company-specific data — only {{variables}}.",
      },
      variables: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "Variable name as referenced in the prompt body via {{name}}.",
            },
            description: {
              type: "string",
              description:
                "What the caller should put for this variable. The caller decides the JSON shape per name (string, array, object) — multibrand is the default, so brand-related variables typically receive arrays or objects, not scalars.",
            },
          },
          required: ["name", "description"],
        },
        description:
          "Inputs the template expects, one entry per {{variable}}. Each entry is an object { name, description } (e.g. [{ name: 'leadFirstName', description: \"The lead's first name\" }]).",
      },
    },
    required: ["sourceType", "prompt", "variables"],
  },
};

// ---------------------------------------------------------------------------
// API Registry progressive disclosure tools
// ---------------------------------------------------------------------------

export const LIST_SERVICES_TOOL: Anthropic.Tool = {
  name: "list_services",
  description:
    "List all available microservices with their name, description, and endpoint count. START HERE for service discovery. Then use list_service_endpoints to drill into a specific service, and call_api to invoke an endpoint.",
  input_schema: {
    type: "object" as const,
    properties: {},
  },
};

export const LIST_SERVICE_ENDPOINTS_TOOL: Anthropic.Tool = {
  name: "list_service_endpoints",
  description:
    "List all endpoints for a specific service (method, path, summary). Use after list_services to explore a service. Then use call_api to invoke a specific endpoint.",
  input_schema: {
    type: "object" as const,
    properties: {
      service: {
        type: "string",
        description:
          "Service name from list_services (e.g. 'brand', 'features', 'workflow')",
      },
    },
    required: ["service"],
  },
};

// call_api tool removed — security risk (unrestricted admin-key access to all services)

// ---------------------------------------------------------------------------
// Key-service read tools
// ---------------------------------------------------------------------------

export const LIST_ORG_KEYS_TOOL: Anthropic.Tool = {
  name: "list_org_keys",
  description:
    "List all API keys configured for the current organization. Returns provider names and masked keys (never the actual secret). Use this to check if an org has the required keys configured before running a workflow.",
  input_schema: {
    type: "object" as const,
    properties: {},
  },
};

export const GET_KEY_SOURCE_TOOL: Anthropic.Tool = {
  name: "get_key_source",
  description:
    "Get the key source preference for a specific provider. Returns whether the org uses its own key ('org') or the platform key ('platform'). If no explicit preference is set, returns 'platform' with isDefault=true.",
  input_schema: {
    type: "object" as const,
    properties: {
      provider: {
        type: "string",
        description:
          "Provider name (e.g. 'anthropic', 'openai', 'stripe', 'instantly')",
      },
    },
    required: ["provider"],
  },
};

export const LIST_KEY_SOURCES_TOOL: Anthropic.Tool = {
  name: "list_key_sources",
  description:
    "List all key source preferences for the current org. Shows which providers use org keys vs platform keys. Providers not listed default to 'platform'.",
  input_schema: {
    type: "object" as const,
    properties: {},
  },
};

export const CHECK_PROVIDER_REQUIREMENTS_TOOL: Anthropic.Tool = {
  name: "check_provider_requirements",
  description:
    "Query which third-party API providers are needed to call a set of service endpoints. Given a list of endpoints (service + method + path), returns which providers each endpoint requires. Use this to determine what keys the org needs before executing a workflow or calling multiple services.",
  input_schema: {
    type: "object" as const,
    properties: {
      endpoints: {
        type: "array",
        items: {
          type: "object",
          properties: {
            service: { type: "string", description: "Service name (e.g. 'chat')" },
            method: { type: "string", description: "HTTP method (e.g. 'POST')" },
            path: { type: "string", description: "Endpoint path (e.g. '/complete')" },
          },
          required: ["service", "method", "path"],
        },
        description: "List of endpoints to check requirements for",
      },
    },
    required: ["endpoints"],
  },
};

export const GET_WORKFLOW_DETAILS_TOOL: Anthropic.Tool = {
  name: "get_workflow_details",
  description:
    "Fetch the full details of a workflow including its DAG, metadata, and status. Use this to inspect the current state of a workflow, especially before calling fork_workflow (to read the current DAG before modifying it).",
  input_schema: {
    type: "object" as const,
    properties: {
      workflowId: {
        type: "string",
        description:
          "UUID of the workflow to fetch. If available in context, use it directly — do NOT ask the user for it.",
      },
    },
    required: ["workflowId"],
  },
};

export const GET_WORKFLOW_REQUIRED_PROVIDERS_TOOL: Anthropic.Tool = {
  name: "get_workflow_required_providers",
  description:
    "Get the BYOK (Bring Your Own Key) providers required to execute a workflow. Returns which external API keys the user needs to configure before running the workflow (e.g. Stripe, Anthropic). Use this proactively to warn users about missing keys before they try to execute.",
  input_schema: {
    type: "object" as const,
    properties: {
      workflowId: {
        type: "string",
        description:
          "UUID of the workflow. If available in context, use it directly — do NOT ask the user for it.",
      },
    },
    required: ["workflowId"],
  },
};

export const LIST_WORKFLOWS_TOOL: Anthropic.Tool = {
  name: "list_workflows",
  description:
    "List existing workflows with optional filters. Use this when the user asks to see their workflows, find a specific workflow, or check if a workflow already exists for a given purpose.",
  input_schema: {
    type: "object" as const,
    properties: {
      featureSlug: {
        type: "string",
        description: "Filter by feature slug (e.g. 'cold-email-outreach')",
      },
      category: {
        type: "string",
        enum: ["sales", "pr", "outlets", "journalists"],
        description: "Filter by category (optional)",
      },
      channel: {
        type: "string",
        enum: ["email", "database"],
        description: "Filter by channel (optional)",
      },
      audienceType: {
        type: "string",
        enum: ["cold-outreach", "discovery"],
        description: "Filter by audience type (optional)",
      },
      tag: {
        type: "string",
        description: "Filter workflows that contain this tag (optional)",
      },
      status: {
        type: "string",
        description: "Filter by status. Defaults to 'active'. Use 'all' to include deprecated workflows (optional)",
      },
      brandId: {
        type: "string",
        description: "Filter by brand ID (optional)",
      },
      humanId: {
        type: "string",
        description: "Filter by human ID (optional)",
      },
      campaignId: {
        type: "string",
        description: "Filter by campaign ID (optional)",
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Feature-creator tools (available only when context.type === "feature-creator")
// ---------------------------------------------------------------------------

const featureInputItems = {
  type: "object" as const,
  properties: {
    key: { type: "string", description: "Machine-readable input key (e.g. 'targetCompanyUrl')" },
    label: { type: "string", description: "Human-readable label (e.g. 'Target Company URL')" },
    type: { type: "string", enum: ["text", "textarea", "number", "select"], description: "Input field type" },
    placeholder: { type: "string", description: "Placeholder text shown in the input (e.g. 'https://example.com')" },
    description: { type: "string", description: "What this input is for" },
    extractKey: { type: "string", description: "Key used to extract this value from enrichment data (e.g. 'company_url')" },
    options: { type: "array", items: { type: "string" }, description: "Options for select-type inputs (only when type is 'select')" },
  },
  required: ["key", "label", "type", "placeholder", "description", "extractKey"],
};

const featureOutputItems = {
  type: "object" as const,
  properties: {
    key: { type: "string", description: "Stats registry key (e.g. 'emailsSent'). Must reference a valid key from GET /stats/registry." },
    displayOrder: { type: "integer", description: "Order in which this output appears in the UI (0-based)" },
    defaultSort: { type: "boolean", description: "Whether this output is the default sort column (optional)" },
    sortDirection: { type: "string", enum: ["asc", "desc"], description: "Sort direction when this is the default sort column (optional)" },
  },
  required: ["key", "displayOrder"],
};

export const CREATE_FEATURE_TOOL: Anthropic.Tool = {
  name: "create_feature",
  description:
    "Create a new feature definition in the features catalogue. Use this when the user has finished designing a feature and wants to save it. Always confirm the feature details with the user before calling this tool. Returns 409 if the slug or name already exists.",
  input_schema: {
    type: "object" as const,
    properties: {
      slug: {
        type: "string",
        description:
          "URL-friendly identifier for the feature (e.g. 'cold-email-outreach'). Use lowercase kebab-case. Optional — auto-generated from name if omitted.",
      },
      name: {
        type: "string",
        description: "Machine-readable feature name (e.g. 'Cold Email Outreach'). This becomes the unique identifier — for forked features it may include a version suffix (e.g. 'Cold Email Outreach v2'). The human-readable displayName is derived from this automatically.",
      },
      description: {
        type: "string",
        description: "Brief description of what the feature does",
      },
      icon: {
        type: "string",
        description: "Icon identifier for the feature (e.g. 'mail', 'linkedin', 'phone')",
      },
      category: {
        type: "string",
        description: "Feature category (e.g. 'sales', 'pr', 'marketing')",
      },
      channel: {
        type: "string",
        description: "Communication channel (e.g. 'email', 'linkedin', 'phone')",
      },
      audienceType: {
        type: "string",
        description: "Target audience type (e.g. 'cold-outreach', 'warm-leads', 'existing-customers')",
      },
      implemented: {
        type: "boolean",
        description: "Whether this feature is implemented and ready for use (default: true)",
      },
      displayOrder: {
        type: "integer",
        description: "Display order in the feature catalogue (default: 0)",
      },
      status: {
        type: "string",
        enum: ["active", "draft", "deprecated"],
        description: "Feature lifecycle status (default: 'active')",
      },
      inputs: {
        type: "array",
        items: featureInputItems,
        description: "Input fields the user must provide to run this feature (min 1)",
      },
      outputs: {
        type: "array",
        items: featureOutputItems,
        description: "Output metrics the feature produces (min 1)",
      },
      charts: {
        type: "array",
        description: "Chart definitions for the feature dashboard. At least one chart required. Two types: funnel-bar (sequential conversion steps, min 2 steps) and breakdown-bar (categorical segments, min 2 segments).",
        items: {
          oneOf: [
            {
              type: "object",
              properties: {
                key: { type: "string", description: "Unique chart key (e.g. 'outreach-funnel')" },
                type: { type: "string", enum: ["funnel-bar"], description: "Funnel bar chart — shows conversion through sequential steps" },
                title: { type: "string", description: "Chart title (e.g. 'Outreach Funnel')" },
                displayOrder: { type: "integer", description: "Order in which the chart appears (0-based)" },
                steps: {
                  type: "array",
                  description: "Funnel steps — each key must reference an output key. Min 2 steps.",
                  minItems: 2,
                  items: {
                    type: "object",
                    properties: { key: { type: "string", description: "Output key this step represents" } },
                    required: ["key"],
                  },
                },
              },
              required: ["key", "type", "title", "displayOrder", "steps"],
            },
            {
              type: "object",
              properties: {
                key: { type: "string", description: "Unique chart key (e.g. 'reply-sentiment')" },
                type: { type: "string", enum: ["breakdown-bar"], description: "Breakdown bar chart — shows categorical distribution" },
                title: { type: "string", description: "Chart title (e.g. 'Reply Sentiment')" },
                displayOrder: { type: "integer", description: "Order in which the chart appears (0-based)" },
                segments: {
                  type: "array",
                  description: "Breakdown segments — each key must reference an output key. Min 2 segments.",
                  minItems: 2,
                  items: {
                    type: "object",
                    properties: {
                      key: { type: "string", description: "Output key this segment represents" },
                      color: { type: "string", enum: ["green", "blue", "red", "gray", "orange"], description: "Segment color" },
                      sentiment: { type: "string", enum: ["positive", "neutral", "negative"], description: "Sentiment category" },
                    },
                    required: ["key", "color", "sentiment"],
                  },
                },
              },
              required: ["key", "type", "title", "displayOrder", "segments"],
            },
          ],
        },
      },
      entities: {
        type: "array",
        description: "Entity types shown in campaign detail sidebar (e.g. ['leads', 'companies', 'emails']). At least one required.",
        items: { type: "string" },
        minItems: 1,
      },
    },
    required: ["name", "description", "icon", "category", "channel", "audienceType", "inputs", "outputs", "charts", "entities"],
  },
};

export const UPDATE_FEATURE_TOOL: Anthropic.Tool = {
  name: "update_feature",
  description:
    "Update an existing feature definition by slug (fork-on-write). Only provided fields are modified — omit fields you don't want to change. If only metadata changes (same signature), the feature is updated in-place. If inputs or outputs change (different signature), a NEW feature is created (forked) with a version suffix, the original is deprecated, and the fork inherits the original's displayName. The response includes a 'forked' boolean indicating which happened.",
  input_schema: {
    type: "object" as const,
    properties: {
      slug: {
        type: "string",
        description: "The slug of the feature to update.",
      },
      name: { type: "string", description: "New feature name (optional)" },
      description: { type: "string", description: "New feature description (optional)" },
      icon: { type: "string", description: "New icon identifier (optional)" },
      category: { type: "string", description: "New category (optional)" },
      channel: { type: "string", description: "New channel (optional)" },
      audienceType: { type: "string", description: "New audience type (optional)" },
      implemented: { type: "boolean", description: "Whether this feature is implemented (optional)" },
      displayOrder: { type: "integer", description: "New display order (optional)" },
      status: { type: "string", enum: ["active", "draft", "deprecated"], description: "New status (optional)" },
      inputs: {
        type: "array",
        items: featureInputItems,
        description: "New input fields (replaces all existing inputs)",
      },
      outputs: {
        type: "array",
        items: featureOutputItems,
        description: "New output fields (replaces all existing outputs)",
      },
      charts: {
        type: "array",
        description: "New chart definitions (replaces all existing charts). Two types: funnel-bar and breakdown-bar.",
        items: {
          oneOf: [
            {
              type: "object",
              properties: {
                key: { type: "string" },
                type: { type: "string", enum: ["funnel-bar"] },
                title: { type: "string" },
                displayOrder: { type: "integer" },
                steps: {
                  type: "array",
                  minItems: 2,
                  items: {
                    type: "object",
                    properties: { key: { type: "string" } },
                    required: ["key"],
                  },
                },
              },
              required: ["key", "type", "title", "displayOrder", "steps"],
            },
            {
              type: "object",
              properties: {
                key: { type: "string" },
                type: { type: "string", enum: ["breakdown-bar"] },
                title: { type: "string" },
                displayOrder: { type: "integer" },
                segments: {
                  type: "array",
                  minItems: 2,
                  items: {
                    type: "object",
                    properties: {
                      key: { type: "string" },
                      color: { type: "string", enum: ["green", "blue", "red", "gray", "orange"] },
                      sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
                    },
                    required: ["key", "color", "sentiment"],
                  },
                },
              },
              required: ["key", "type", "title", "displayOrder", "segments"],
            },
          ],
        },
      },
      entities: {
        type: "array",
        description: "New entity types (replaces all existing entities)",
        items: { type: "string" },
      },
    },
    required: ["slug"],
  },
};

export const LIST_FEATURES_TOOL: Anthropic.Tool = {
  name: "list_features",
  description:
    "List features from the catalogue with optional filters. Use this to browse existing features, check for duplicates before creating, or find features by category/channel. The dashboard also sends features in context, but this tool fetches the latest from the database.",
  input_schema: {
    type: "object" as const,
    properties: {
      category: { type: "string", description: "Filter by category (e.g. 'sales', 'pr')" },
      channel: { type: "string", description: "Filter by channel (e.g. 'email', 'linkedin')" },
      audienceType: { type: "string", description: "Filter by audience type" },
      status: { type: "string", description: "Filter by status (e.g. 'active', 'draft')" },
      implemented: { type: "string", description: "Filter by implementation status ('true' or 'false')" },
    },
  },
};

export const GET_FEATURE_TOOL: Anthropic.Tool = {
  name: "get_feature",
  description:
    "Get full details of a single feature by its slug. Use this to inspect inputs, outputs, and metadata of an existing feature.",
  input_schema: {
    type: "object" as const,
    properties: {
      slug: {
        type: "string",
        description: "The feature slug to look up. If available in context, use it directly.",
      },
    },
    required: ["slug"],
  },
};

export const GET_FEATURE_INPUTS_TOOL: Anthropic.Tool = {
  name: "get_feature_inputs",
  description:
    "Get the input field definitions for a feature by slug. Returns the list of inputs the user must provide to run this feature. Lighter than get_feature — use when you only need the input schema.",
  input_schema: {
    type: "object" as const,
    properties: {
      slug: {
        type: "string",
        description: "The feature slug to look up inputs for.",
      },
    },
    required: ["slug"],
  },
};

export const PREFILL_FEATURE_TOOL: Anthropic.Tool = {
  name: "prefill_feature",
  description:
    "Pre-fill input values for a feature using the org's brand data. Returns a map of input key → suggested text value (or null if extraction failed). Use this to auto-populate form fields before the user reviews and submits.",
  input_schema: {
    type: "object" as const,
    properties: {
      slug: {
        type: "string",
        description: "The feature slug to pre-fill inputs for.",
      },
    },
    required: ["slug"],
  },
};

export const GET_FEATURE_STATS_TOOL: Anthropic.Tool = {
  name: "get_feature_stats",
  description:
    "Get computed stats for a feature — cost, run counts, campaign counts, and per-output metrics. Optionally group by workflowSlug, brandId, or campaignId. System stats (cost, runs, campaigns, dates) are always included.",
  input_schema: {
    type: "object" as const,
    properties: {
      slug: {
        type: "string",
        description: "The feature slug to get stats for.",
      },
      groupBy: {
        type: "string",
        enum: ["workflowSlug", "brandId", "campaignId"],
        description: "Group stats by this dimension (optional).",
      },
      brandId: {
        type: "string",
        description: "Filter stats to a specific brand (optional).",
      },
      campaignId: {
        type: "string",
        description: "Filter stats to a specific campaign (optional).",
      },
      workflowSlug: {
        type: "string",
        description: "Filter stats to a specific workflow (optional).",
      },
    },
    required: ["slug"],
  },
};

// ---------------------------------------------------------------------------
// Campaign-prefill tools
// ---------------------------------------------------------------------------

export const UPDATE_CAMPAIGN_FIELDS_TOOL: Anthropic.Tool = {
  name: "update_campaign_fields",
  description:
    "Update campaign form fields. Returns the fields object as-is so the frontend can apply the values to the form. Use this to pre-fill or modify campaign creation fields based on the conversation.",
  input_schema: {
    type: "object" as const,
    properties: {
      fields: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          "Key-value map of campaign form fields to update. Keys are field names, values are the new string values.",
      },
    },
    required: ["fields"],
  },
};

export const EXTRACT_BRAND_FIELDS_TOOL: Anthropic.Tool = {
  name: "extract_brand_fields",
  description:
    "Extract arbitrary fields from the brand's website using AI. Uses the brand(s) from the x-brand-id header (no brandId parameter needed). Wraps brand-service extract-fields endpoint. Results are cached 30 days per field — safe to call repeatedly.",
  input_schema: {
    type: "object" as const,
    properties: {
      fields: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "Machine-readable key for the field (e.g. 'industry', 'target_audience').",
            },
            description: {
              type: "string",
              description: "Human-readable description of what to extract (e.g. 'The brand\\'s primary industry vertical').",
            },
          },
          required: ["key", "description"],
        },
        description: "List of fields to extract. Each field has a key and a description.",
      },
    },
    required: ["fields"],
  },
};

export const BROWSE_URL_TOOL: Anthropic.Tool = {
  name: "browse_url",
  description:
    "Fetch and read the content of any public URL. Returns the page text as markdown, plus the meta description. Use this to visit competitor pages, reference articles, product pages, or any URL the user mentions. Read-only — does not modify anything.",
  input_schema: {
    type: "object" as const,
    properties: {
      url: {
        type: "string",
        description: "The URL to visit and read (must be a valid http or https URL).",
      },
    },
    required: ["url"],
  },
};

// ---------------------------------------------------------------------------
// Persona-editor tools (persona-editor config) — act on the brand from
// context.brandId. Personas are immutable except status; no hard delete.
// ---------------------------------------------------------------------------

export const LIST_PERSONAS_TOOL: Anthropic.Tool = {
  name: "list_personas",
  description:
    "List the customer personas for the current brand (the brand from context.brandId — no brandId parameter needed). Optionally filter by lifecycle status. Read-only — never modifies anything. Use this to summarize personas, and to look up a persona's id before duplicating it or changing its status.",
  input_schema: {
    type: "object" as const,
    properties: {
      status: {
        type: "string",
        enum: ["active", "paused", "archived"],
        description:
          "Optional. Filter to personas with this lifecycle status. Omit to list all statuses.",
      },
    },
  },
};

export const CREATE_PERSONA_TOOL: Anthropic.Tool = {
  name: "create_persona",
  description:
    "Create a NEW customer persona for the current brand. Personas are IMMUTABLE except for their status, so 'editing' a persona means creating a new one (and optionally archiving the old one with set_persona_status). Names are UNIQUE PER BRAND, case-insensitive, across active + paused + archived. If the result is { created: false, reason: \"name_taken\" }, tell the user the name is taken and ask for a different name — do NOT retry the same name. The new persona starts active.",
  input_schema: {
    type: "object" as const,
    properties: {
      name: {
        type: "string",
        description: "The persona name. Must be unique for the brand (case-insensitive).",
      },
      filters: {
        type: "array",
        description:
          "Targeting filters for the persona. Each entry is an attribute and its allowed values.",
        items: {
          type: "object",
          properties: {
            attribute: {
              type: "string",
              description: "Targeting attribute, e.g. 'jobTitle', 'industry', 'companySize', 'seniority'.",
            },
            values: {
              type: "array",
              items: { type: "string" },
              description: "Allowed values for this attribute.",
            },
          },
          required: ["attribute", "values"],
        },
      },
    },
    required: ["name", "filters"],
  },
};

export const DUPLICATE_PERSONA_TOOL: Anthropic.Tool = {
  name: "duplicate_persona",
  description:
    "Duplicate an existing persona of the current brand, copying its filters into a new persona. Look up the persona id with list_personas first. 'name' is optional — when omitted or already taken it is auto-uniquified server-side (e.g. 'Founders (copy)'), so duplication never fails on a name clash.",
  input_schema: {
    type: "object" as const,
    properties: {
      personaId: {
        type: "string",
        description: "The id of the persona to duplicate (from list_personas).",
      },
      name: {
        type: "string",
        description: "Optional name for the copy. Auto-uniquified if omitted or already taken.",
      },
    },
    required: ["personaId"],
  },
};

export const SET_PERSONA_STATUS_TOOL: Anthropic.Tool = {
  name: "set_persona_status",
  description:
    "Change a persona's lifecycle status — the ONLY mutable field on a persona. Map the user's intent: PAUSE → paused, RESUME / REACTIVATE / RESTORE → active, ARCHIVE → archived. Archiving NEVER deletes the persona (there is no hard delete); it stays retrievable under 'archived' and can be restored by setting it back to active. Look up the persona id with list_personas first.",
  input_schema: {
    type: "object" as const,
    properties: {
      personaId: {
        type: "string",
        description: "The id of the persona to update (from list_personas).",
      },
      status: {
        type: "string",
        enum: ["active", "paused", "archived"],
        description: "The new lifecycle status.",
      },
    },
    required: ["personaId", "status"],
  },
};

// ---------------------------------------------------------------------------
// Brand-profile-editor tools (brand-profile-editor config) — act on the brand
// from context.brandId. The profile is versioned + immutable: each save is a
// NEW version, prior versions are never mutated.
// ---------------------------------------------------------------------------

export const GET_BRAND_PROFILE_TOOL: Anthropic.Tool = {
  name: "get_brand_profile",
  description:
    "Get the current brand profile (the latest saved version's fields) plus the list of saved versions for the current brand (from context.brandId — no brandId parameter needed). Read-only. ALWAYS call this before save_brand_profile_version so you edit from the current field values.",
  input_schema: {
    type: "object" as const,
    properties: {},
  },
};

export const SAVE_BRAND_PROFILE_VERSION_TOOL: Anthropic.Tool = {
  name: "save_brand_profile_version",
  description:
    "Save a NEW immutable version of the current brand's profile. Each save creates a new version (v1 → v2 → …); prior versions are NEVER mutated. Supply ONLY the fields you want to change as `changes` — the tool reads the current version, applies your changes on top, and saves the full merged result, so unchanged fields are preserved automatically. Call get_brand_profile first to see current values.",
  input_schema: {
    type: "object" as const,
    properties: {
      changes: {
        type: "array",
        description: "The field changes to apply on top of the current profile.",
        items: {
          type: "object",
          properties: {
            field: {
              type: "string",
              description: "The profile field name, e.g. 'valueProposition', 'differentiators', 'tone'.",
            },
            operation: {
              type: "string",
              enum: ["set", "setList", "add", "remove"],
              description:
                "'set' replaces a free-text field with `value`; 'setList' replaces a list field with `values`; 'add' appends `value` to a list field; 'remove' deletes `value` from a list field.",
            },
            value: {
              type: "string",
              description: "The text (set) or single list item (add / remove). Required for set, add, remove.",
            },
            values: {
              type: "array",
              items: { type: "string" },
              description: "The full list of items. Required for setList.",
            },
          },
          required: ["field", "operation"],
        },
      },
    },
    required: ["changes"],
  },
};

export const REFRESH_BRAND_PROFILE_FROM_WEBSITE_TOOL: Anthropic.Tool = {
  name: "refresh_brand_profile_from_website",
  description:
    "Refresh the current brand's profile from the latest/current website and save a NEW immutable version. Use this when the user asks to update, refresh, sync, regenerate, or save the brand profile from the latest/current website (including French requests like 'mets à jour avec mon dernier site web'). This tool reads the current profile, forces fresh website field extraction using context.fieldDefinitions when available, saves the full merged profile as a new version, and returns the new version plus changed fields. Do NOT call this for read-only questions or opinions.",
  input_schema: {
    type: "object" as const,
    properties: {
      fields: {
        type: "array",
        description:
          "Optional field definitions to extract if context.fieldDefinitions is unavailable. Each field needs a key and description.",
        items: {
          type: "object",
          properties: {
            key: {
              type: "string",
              description: "Machine-readable brand profile field key.",
            },
            description: {
              type: "string",
              description: "What to extract from the current website for this field.",
            },
            type: {
              type: "string",
              description: "Optional field type hint, e.g. text or list.",
            },
          },
          required: ["key", "description"],
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Audience-editor tools (audience-editor config) — act on the brand from
// context.brandId, scoped to the caller's org by the forwarded identity. An
// audience is a saved filter-set; creation is suggest -> activate (no raw
// create tool — /suggest persists candidates the model then activates).
// ---------------------------------------------------------------------------

export const LIST_AUDIENCES_TOOL: Anthropic.Tool = {
  name: "list_audiences",
  description:
    "List the customer audiences for the current brand (the brand from context.brandId — no brandId parameter needed). Optionally filter by lifecycle status. Read-only — never modifies anything. Use this to summarize audiences, and to look up an audience's id before renaming it, changing its status, or refreshing its counts.",
  input_schema: {
    type: "object" as const,
    properties: {
      status: {
        type: "string",
        enum: ["suggested", "active", "paused", "archived"],
        description:
          "Optional. Filter to audiences with this lifecycle status. Omit to list all statuses. 'suggested' audiences are inactive candidates awaiting activation.",
      },
    },
  },
};

export const SUGGEST_AUDIENCES_TOOL: Anthropic.Tool = {
  name: "suggest_audiences",
  description:
    "Propose candidate audiences for the current brand from a natural-language description (e.g. 'heads of marketing at Series A SaaS in the US'). Each returned candidate is persisted at status 'suggested', which is INVISIBLE to the customer: no product surface lists a 'suggested' audience, so nothing exists for them until it is activated. HARD RULE — DO NOT VIOLATE EVEN IF THE USER ASKS YOU TO: never tell the user an audience has been created, added, or saved on the strength of this tool alone. Present the candidates (name, who they target, count), and turn a chosen one into a real audience the customer can see by calling set_audience_status with its audienceId and status 'active' — only then report it as created. Never activate on your own initiative: activation happens on the user's explicit request. The text drives the granularity — say 'split by country' etc. in the prompt to get one candidate per segment.",
  input_schema: {
    type: "object" as const,
    properties: {
      nlPrompt: {
        type: "string",
        description:
          "Natural-language description of the audience(s) to target. Express any segmentation intent (e.g. 'founders in FR and DE separately') directly in this text.",
      },
    },
    required: ["nlPrompt"],
  },
};

export const SET_AUDIENCE_STATUS_TOOL: Anthropic.Tool = {
  name: "set_audience_status",
  description:
    "Change an audience's lifecycle status. Map the user's intent: ACTIVATE a suggested candidate / RESUME / REACTIVATE / RESTORE → active, PAUSE → paused, ARCHIVE → archived. Activating a 'suggested' candidate (status 'active') is how a candidate becomes a real, live audience. Archiving NEVER deletes the audience; it can always be restored by setting it back to active. Look up the audience id with list_audiences (or use the audienceId returned by suggest_audiences).",
  input_schema: {
    type: "object" as const,
    properties: {
      audienceId: {
        type: "string",
        description:
          "The id of the audience to update (from list_audiences, or the audienceId of a suggest_audiences candidate).",
      },
      status: {
        type: "string",
        enum: ["active", "paused", "archived"],
        description: "The new lifecycle status.",
      },
    },
    required: ["audienceId", "status"],
  },
};

export const RENAME_AUDIENCE_TOOL: Anthropic.Tool = {
  name: "rename_audience",
  description:
    "Rename an audience of the current brand. Only the name is editable — an audience's targeting filters are immutable. Look up the audience id with list_audiences first.",
  input_schema: {
    type: "object" as const,
    properties: {
      audienceId: {
        type: "string",
        description: "The id of the audience to rename (from list_audiences).",
      },
      name: {
        type: "string",
        description: "The new audience name.",
      },
    },
    required: ["audienceId", "name"],
  },
};

export const REFRESH_AUDIENCE_COUNT_TOOL: Anthropic.Tool = {
  name: "refresh_audience_count",
  description:
    "Re-snapshot an audience's match counts (apollo + apify) using the free live dry-run. Use this when the user asks to refresh, recompute, or update the size/count of an audience. Returns the updated audience with fresh apolloCount / apifyCount. Look up the audience id with list_audiences first.",
  input_schema: {
    type: "object" as const,
    properties: {
      audienceId: {
        type: "string",
        description: "The id of the audience to refresh (from list_audiences).",
      },
    },
    required: ["audienceId"],
  },
};

export const GENERATE_AUDIENCE_AVATAR_TOOL: Anthropic.Tool = {
  name: "generate_audience_avatar",
  description:
    "(Re)generate an audience's avatar image. Use this when the user asks to create, regenerate, or change the avatar / picture / image of an audience. Pass an optional `prompt` to steer the image; omit it to derive the image from the audience's own descriptors. Returns the updated audience with its new avatarUrl. Look up the audience id with list_audiences first.",
  input_schema: {
    type: "object" as const,
    properties: {
      audienceId: {
        type: "string",
        description:
          "The id of the audience whose avatar to (re)generate (from list_audiences).",
      },
      prompt: {
        type: "string",
        description:
          "Optional natural-language steer for the generated image. Omit to derive the image from the audience's descriptors.",
      },
    },
    required: ["audienceId"],
  },
};

// ---------------------------------------------------------------------------
// Qualification-editor tools (qualification-editor config) — act on ONE offer
// (context.brandId + context.offerId), scoped to the caller's org by the
// forwarded identity. lead-service owns the checks. A check's question is
// immutable: there is deliberately NO edit-question tool — a reword is
// archive_qualification_check + create_qualification_check.
// ---------------------------------------------------------------------------

export const LIST_QUALIFICATION_CHECKS_TOOL: Anthropic.Tool = {
  name: "list_qualification_checks",
  description:
    "List every check of the current offer (the offer from context.offerId, no parameter needed), on or off, with its role (Hard filter or Bonus), whether it is on, its cost per lead in USD and its pass rate so far (null when no company was checked yet). Read-only, free. Use it to summarize, and to look up a check's checkId before turning it on/off, changing its role, or archiving it.",
  input_schema: { type: "object" as const, properties: {} },
};

export const LIST_QUALIFICATION_SOURCES_TOOL: Anthropic.Tool = {
  name: "list_qualification_sources",
  description:
    "List the sources a new check can read to answer its question (company data we already hold, the homepage text, a homepage screenshot, job postings, recent LinkedIn company posts), each with its cost per lead in USD. Read-only, free. Use it to pick the source for create_qualification_check and to tell the user what a new check will cost per lead.",
  input_schema: { type: "object" as const, properties: {} },
};

export const SUGGEST_QUALIFICATION_CHECKS_TOOL: Anthropic.Tool = {
  name: "suggest_qualification_checks",
  description:
    "Ask for AI-suggested checks for the current offer: up to 8 yes/no signals that a company needs the offer. SPENDS the customer's credit. Every suggestion is saved turned OFF, so nothing changes in who is reached until the user turns one on. Suggestions from an earlier run that nobody touched are replaced; ones that repeat a kept check are skipped (listed in `skipped`). HARD RULE — DO NOT VIOLATE EVEN IF THE USER ASKS YOU TO: before calling it, say in one plain line that it uses credit, then call it. Never call it twice in a row for the same request.",
  input_schema: { type: "object" as const, properties: {} },
};

export const CREATE_QUALIFICATION_CHECK_TOOL: Anthropic.Tool = {
  name: "create_qualification_check",
  description:
    "Create a new check on the current offer from what the user describes. The question must be ONE yes/no question about the prospect's company, kept close to the user's own words. Pick the source that can answer it (see list_qualification_sources). role: 'hard_filter' = a company that fails is skipped; 'bonus' = a plus handed to the email writer, never required. on: true only if the user wants it applied now; otherwise false. A check's wording can never be changed after creation.",
  input_schema: {
    type: "object" as const,
    properties: {
      question: {
        type: "string",
        description: "One yes/no question about the prospect's company.",
      },
      source: {
        type: "string",
        enum: [
          "company_data",
          "homepage_text",
          "homepage_screenshot",
          "job_postings",
          "linkedin_company_posts",
        ],
        description: "What the check reads to answer the question.",
      },
      role: {
        type: "string",
        enum: ["hard_filter", "bonus"],
        description: "'hard_filter' (Hard filter: failing companies are skipped) or 'bonus' (Bonus: a plus, never required).",
      },
      on: {
        type: "boolean",
        description: "Whether the check applies right away.",
      },
    },
    required: ["question", "source", "role", "on"],
  },
};

export const UPDATE_QUALIFICATION_CHECK_TOOL: Anthropic.Tool = {
  name: "update_qualification_check",
  description:
    "Turn a check of the current offer on or off, and/or switch its role between Hard filter ('hard_filter') and Bonus ('bonus'). It can NOT change the question: to reword a check, archive it with archive_qualification_check and create a new one. Pass at least one of `on` / `role`. Look up the checkId with list_qualification_checks.",
  input_schema: {
    type: "object" as const,
    properties: {
      checkId: {
        type: "string",
        description: "The checkId from list_qualification_checks (or a just-created/suggested check).",
      },
      on: { type: "boolean", description: "Turn the check on (true) or off (false)." },
      role: {
        type: "string",
        enum: ["hard_filter", "bonus"],
        description: "New role.",
      },
    },
    required: ["checkId"],
  },
};

export const ARCHIVE_QUALIFICATION_CHECK_TOOL: Anthropic.Tool = {
  name: "archive_qualification_check",
  description:
    "Archive a check of the current offer: it disappears from the list and stops applying; answers it already gave are kept. Use it when the user wants a check gone, and as the first half of a reword (archive, then create_qualification_check with the new wording). Look up the checkId with list_qualification_checks.",
  input_schema: {
    type: "object" as const,
    properties: {
      checkId: {
        type: "string",
        description: "The checkId from list_qualification_checks.",
      },
    },
    required: ["checkId"],
  },
};

// ---------------------------------------------------------------------------
// Funnel tools — the end-to-end "operate the platform" surface a dashboard user
// drives: create a brand from a URL (onboarding-equivalent), launch a campaign,
// set the daily budget, and pause/resume a brand. These let a chat agent (e.g.
// the WhatsApp "Distribute.you" assistant) take an org from nothing to a running,
// managed campaign. Every call routes through api-service with the caller's
// forwarded identity, so the underlying operation is metered against the caller's
// org by the downstream service (chat-service adds no cost of its own here).
//
// Unlike the brand-scoped editor tools (which act on a single context.brandId),
// these take the brandId / brandUrl explicitly, so they work in a brand-less
// onboarding session where the agent creates or selects the brand mid-conversation.
// ---------------------------------------------------------------------------

export const CREATE_BRAND_FROM_URL_TOOL: Anthropic.Tool = {
  name: "create_brand_from_url",
  description:
    "Create (or upsert) a brand from its website URL — the onboarding step. Give the brand's homepage URL; the platform scrapes it and provisions the brand, returning its brandId. This is the first step to set up a new brand from scratch. If the org already has this brand, it is upserted (not duplicated). Use list_brands first if you are unsure whether the brand already exists. Save the returned brandId to set its daily budget, pause/resume it, or reference it later.",
  input_schema: {
    type: "object" as const,
    properties: {
      url: {
        type: "string",
        description: "The brand's website URL (e.g. 'https://acme.com').",
      },
    },
    required: ["url"],
  },
};

export const LIST_BRANDS_TOOL: Anthropic.Tool = {
  name: "list_brands",
  description:
    "List every brand in the caller's org, with each brand's id, name, and URL. Read-only. Use it to find an existing brand's id/URL before launching a campaign, setting a budget, or pausing/resuming it — and to check whether a brand already exists before creating one.",
  input_schema: {
    type: "object" as const,
    properties: {},
  },
};

export const LAUNCH_CAMPAIGN_TOOL: Anthropic.Tool = {
  name: "launch_campaign",
  description:
    "Launch a new campaign for a brand — this is how the brand starts running. Requires: a campaign `name`; `brandUrls` (one or more brand website URLs — the first is the primary brand; use the URL from create_brand_from_url or list_brands); `featureInputs` (the free-form inputs the chosen feature needs — discover the required keys with get_feature_inputs); and a feature + a workflow to run. Prefer the stable dynasty slugs: pass `featureDynastySlug` (from list_features) and `workflowDynastySlug` (from list_workflows) so the latest version is used automatically. Optionally cap spend with `maxBudgetDailyUsd` / `maxBudgetTotalUsd`, limit `maxLeads`, or set an `endDate`. On success the campaign is created and starts; report the campaign name and status to the user.",
  input_schema: {
    type: "object" as const,
    properties: {
      name: { type: "string", description: "Campaign name." },
      brandUrls: {
        type: "array",
        items: { type: "string" },
        description:
          "Brand website URLs. The first URL is the primary brand; additional URLs are secondary brands.",
      },
      featureInputs: {
        type: "object",
        description:
          "The feature's free-form inputs (key → value). Discover the expected keys with get_feature_inputs for the chosen feature.",
      },
      featureDynastySlug: {
        type: "string",
        description:
          "Stable feature dynasty slug (from list_features), e.g. 'pr-cold-email-outreach'. Resolves to the latest version. Preferred. Provide this OR featureSlug.",
      },
      featureSlug: {
        type: "string",
        description:
          "Exact versioned feature slug — use only to pin a specific version. Provide this OR featureDynastySlug.",
      },
      workflowDynastySlug: {
        type: "string",
        description:
          "Stable workflow dynasty slug (from list_workflows), e.g. 'sales-email-cold-outreach-sienna'. Resolves to the latest version. Preferred. Provide this OR workflowSlug.",
      },
      workflowSlug: {
        type: "string",
        description:
          "Exact versioned workflow slug — use only to pin a specific version. Provide this OR workflowDynastySlug.",
      },
      maxBudgetDailyUsd: {
        type: "string",
        description: "Optional max daily budget in USD (e.g. '20').",
      },
      maxBudgetTotalUsd: {
        type: "string",
        description: "Optional max total budget in USD (e.g. '500').",
      },
      maxLeads: {
        type: "integer",
        description: "Optional cap on the number of leads to contact.",
      },
      endDate: {
        type: "string",
        description: "Optional campaign end date (ISO date string).",
      },
    },
    required: ["name", "brandUrls", "featureInputs"],
  },
};

export const LIST_CAMPAIGNS_TOOL: Anthropic.Tool = {
  name: "list_campaigns",
  description:
    "THE account's campaigns, as the Campaigns page shows them. A campaign IS a sales funnel campaign: name, type (proactive | reactive), status, budget in words ('Max $10/day', 'Up to $1/day', 'Not funded (no max budget)'), volume, what it spent this period, and its steps (sources, cold email, AI booking...). " +
    "Use it for ANY question about campaigns, what runs, or each campaign's budget. Count and name only campaigns, never their steps (a step is part of a campaign, not a campaign). Quote budget and spent as written. Read-only.",
  input_schema: {
    type: "object" as const,
    properties: {
      brandId: { type: "string", description: "Filter to this brand's campaigns." },
      status: { type: "string", enum: ["ongoing", "stopped"], description: "Omit for both." },
      offerId: { type: "string" },
      staffUnits: { type: "boolean", description: "STAFF ONLY: the per-step unit detail instead (never for a customer)." },
    },
  },
};

export const STOP_CAMPAIGN_TOOL: Anthropic.Tool = {
  name: "stop_campaign",
  description:
    "Stop a running campaign. Look up the campaign id with list_campaigns first. This halts the campaign's execution. To pause a whole brand's activity instead of a single campaign, use set_brand_pause.",
  input_schema: {
    type: "object" as const,
    properties: {
      campaignId: {
        type: "string",
        description: "The id of the campaign to stop (from list_campaigns).",
      },
    },
    required: ["campaignId"],
  },
};

export const GET_DAILY_BUDGET_TOOL: Anthropic.Tool = {
  name: "get_daily_budget",
  description:
    "Read a brand's current daily budget (its per-day spend ceiling, in cents; null means unset). Read-only. Look up the brand id with list_brands (or use the id from create_brand_from_url).",
  input_schema: {
    type: "object" as const,
    properties: {
      brandId: {
        type: "string",
        description: "The brand id (from list_brands or create_brand_from_url).",
      },
    },
    required: ["brandId"],
  },
};

export const SET_DAILY_BUDGET_TOOL: Anthropic.Tool = {
  name: "set_daily_budget",
  description:
    "Set a brand's daily budget — its per-day spend ceiling. `dailyBudgetCents` is IN CENTS (e.g. $20/day = 2000). Convert the user's dollar amount to cents yourself. Setting 0 pauses spend. Look up the brand id with list_brands (or use the id from create_brand_from_url). Confirm the new budget in dollars to the user after it succeeds.",
  input_schema: {
    type: "object" as const,
    properties: {
      brandId: {
        type: "string",
        description: "The brand id (from list_brands or create_brand_from_url).",
      },
      dailyBudgetCents: {
        type: "integer",
        description:
          "The daily spend ceiling in CENTS (e.g. $25/day = 2500). 0 = pause spend.",
      },
    },
    required: ["brandId", "dailyBudgetCents"],
  },
};

export const GET_BRAND_PAUSE_TOOL: Anthropic.Tool = {
  name: "get_brand_pause",
  description:
    "Read whether a brand is currently paused. Read-only. Look up the brand id with list_brands (or use the id from create_brand_from_url).",
  input_schema: {
    type: "object" as const,
    properties: {
      brandId: {
        type: "string",
        description: "The brand id (from list_brands or create_brand_from_url).",
      },
    },
    required: ["brandId"],
  },
};

export const SET_BRAND_PAUSE_TOOL: Anthropic.Tool = {
  name: "set_brand_pause",
  description:
    "Pause or resume a brand's activity. Pass `paused: true` to PAUSE the brand (halt all its campaigns) or `paused: false` to RESUME it. Map the user's intent: 'pause'/'stop my brand'/'hold' → true; 'resume'/'restart'/'unpause'/'go live again' → false. Look up the brand id with list_brands (or use the id from create_brand_from_url). Confirm the new state to the user after it succeeds.",
  input_schema: {
    type: "object" as const,
    properties: {
      brandId: {
        type: "string",
        description: "The brand id (from list_brands or create_brand_from_url).",
      },
      paused: {
        type: "boolean",
        description: "true to pause the brand, false to resume it.",
      },
    },
    required: ["brandId", "paused"],
  },
};

// ---------------------------------------------------------------------------
// Account-awareness READ tools (src/lib/account-client.ts). Read-only, served
// figures only: the model quotes what these return and never computes a stat.
// ---------------------------------------------------------------------------

const BRAND_ID_PROP = {
  type: "string",
  description: "The brand id (from list_brands).",
};
const OFFER_ID_PROP = {
  type: "string",
  description: "The offer id (from list_offers).",
};
const WINDOW_PROP = {
  type: "string",
  enum: ["today", "last_7_days", "last_30_days"],
  description: "Time window, counted in UTC days ending now.",
};

export const LIST_OFFERS_TOOL: Anthropic.Tool = {
  name: "list_offers",
  description:
    "List a brand's offers (what it sells, each run by its own campaigns), with each offer's id, name and status. Read-only. Use the offer id with get_offer_performance and list_replies_to_handle.",
  input_schema: { type: "object" as const, properties: { brandId: BRAND_ID_PROP }, required: ["brandId"] },
};

export const GET_BILLING_ACCOUNT_TOOL: Anthropic.Tool = {
  name: "get_billing_account",
  description:
    "Read the org's billing account: current balance, credits added, usage so far and payment mode. Read-only. Quote the figures exactly as returned (amounts are in cents where the field name says so).",
  input_schema: { type: "object" as const, properties: {} },
};

export const GET_ORG_USAGE_TOOL: Anthropic.Tool = {
  name: "get_org_usage",
  description:
    "Read everything the org has been billed to date, in total and by kind of work (setting up brands, finding contacts, writing, replies). Read-only.",
  input_schema: { type: "object" as const, properties: {} },
};

export const GET_SPEND_BY_CAMPAIGN_TOOL: Anthropic.Tool = {
  name: "get_spend_by_campaign",
  description:
    "Read what a brand spent per campaign over a window (today, last 7 days or last 30 days): run count and cost per campaign. Read-only. Use list_campaigns to name the campaigns.",
  input_schema: {
    type: "object" as const,
    properties: { brandId: BRAND_ID_PROP, window: WINDOW_PROP },
    required: ["brandId", "window"],
  },
};

export const GET_OFFER_PERFORMANCE_TOOL: Anthropic.Tool = {
  name: "get_offer_performance",
  description:
    "Read an offer's results the way the dashboard shows them: spend, emails sent, replies and the return on spend. Without windowDays it covers the offer since it started; with windowDays (1-365) it adds a block for the last N days. Read-only.",
  input_schema: {
    type: "object" as const,
    properties: {
      brandId: BRAND_ID_PROP,
      offerId: OFFER_ID_PROP,
      windowDays: { type: "integer", description: "Optional: also return the last N days (1-365)." },
    },
    required: ["brandId", "offerId"],
  },
};

export const LIST_REPLIES_TO_HANDLE_TOOL: Anthropic.Tool = {
  name: "list_replies_to_handle",
  description:
    "List the people who replied with interest to an offer and that nobody has handled yet, most recent first, with the total count. These are the conversations waiting for the user. Read-only.",
  input_schema: {
    type: "object" as const,
    properties: {
      brandId: BRAND_ID_PROP,
      offerId: OFFER_ID_PROP,
      limit: { type: "integer", description: "How many people to return (1-20, default 5). The total is always returned." },
    },
    required: ["brandId", "offerId"],
  },
};

export const LIST_RECENT_RUNS_TOOL: Anthropic.Tool = {
  name: "list_recent_runs",
  description:
    "List a brand's most recent runs (the work the platform did: each run's task, status, campaign, start time and cost), newest first. Optionally only within a window. Read-only.",
  input_schema: {
    type: "object" as const,
    properties: {
      brandId: BRAND_ID_PROP,
      window: WINDOW_PROP,
      limit: { type: "integer", description: "How many runs (1-50, default 20)." },
    },
    required: ["brandId"],
  },
};

// ---------------------------------------------------------------------------
// Copilot tools (src/lib/copilot-client.ts, skills.ts, staff-requests.ts):
// the skill tree, one read per platform entity, the data writes, the
// propose → confirm switch-on gate, and the staff escalation.
// ---------------------------------------------------------------------------

const BRAND_OFFER_PROPS = { brandId: BRAND_ID_PROP, offerId: OFFER_ID_PROP };
const BRAND_OFFER_REQUIRED = ["brandId", "offerId"];

export const READ_SKILL_TOOL: Anthropic.Tool = {
  name: "read_skill",
  description:
    "Load one skill (a page of platform knowledge) by slug, as listed in the Skills section of your instructions. Returns its markdown and its sub-skills. Load the skill of a topic BEFORE acting on it (campaigns, channels, legs, triggers, sales paths, sources, budget, staff requests…). Free, read-only.",
  input_schema: {
    type: "object" as const,
    properties: { slug: { type: "string", description: "Skill slug, e.g. \"campaigns\"." } },
    required: ["slug"],
  },
};


export const GET_LEG_RATES_TOOL: Anthropic.Tool = {
  name: "get_leg_rates",
  description: "Read a brand's conversion rate per leg. Read-only.",
  input_schema: { type: "object" as const, properties: { brandId: BRAND_ID_PROP }, required: ["brandId"] },
};

export const LIST_SALES_PATHS_TOOL: Anthropic.Tool = {
  name: "list_sales_paths",
  description:
    "List every sales path of an offer (a chain of legs from first contact to paid client), ranked by return on spend, with each leg's channel, rate and the cost per paying client. Read-only.",
  input_schema: { type: "object" as const, properties: BRAND_OFFER_PROPS, required: BRAND_OFFER_REQUIRED },
};

export const GET_TRIGGER_EVENTS_TOOL: Anthropic.Tool = {
  name: "get_trigger_events",
  description:
    "Read an offer's trigger activity per trigger type: how many fired, ran, or were skipped and why (campaign off, unfunded…). Read-only.",
  input_schema: { type: "object" as const, properties: BRAND_OFFER_PROPS, required: BRAND_OFFER_REQUIRED },
};

export const LIST_SOURCING_ORIGINS_TOOL: Anthropic.Tool = {
  name: "list_sourcing_origins",
  description:
    "List where leads can come from (e.g. Apollo cold filters, Apollo buying signals, LinkedIn engagement signals, CRM contacts). Read-only.",
  input_schema: { type: "object" as const, properties: {} },
};

export const GET_OFFER_SOURCING_TOOL: Anthropic.Tool = {
  name: "get_offer_sourcing",
  description: "Read an offer's lead sources with leads found, cost and return per source. Read-only.",
  input_schema: { type: "object" as const, properties: BRAND_OFFER_PROPS, required: BRAND_OFFER_REQUIRED },
};

export const GET_CAMPAIGN_BUDGETS_TOOL: Anthropic.Tool = {
  name: "get_campaign_budgets",
  description: "RETIRED for answers: the old per-step ceilings. A campaign's budget is its funnel caps: list_campaigns. Read-only.",
  input_schema: { type: "object" as const, properties: BRAND_OFFER_PROPS, required: BRAND_OFFER_REQUIRED },
};

export const GET_CAMPAIGN_TOOL: Anthropic.Tool = {
  name: "get_campaign",
  description: "Read one campaign: its offer, leg, channel, status and caps. Read-only.",
  input_schema: {
    type: "object" as const,
    properties: { campaignId: { type: "string", description: "Campaign id (from list_campaigns)." } },
    required: ["campaignId"],
  },
};

export const LIST_CONNECTED_ACCOUNTS_TOOL: Anthropic.Tool = {
  name: "list_connected_accounts",
  description:
    "List the org's connected accounts: Google mailboxes, WhatsApp/Telegram/Discord links, GoHighLevel, PostHog, Stripe. Pass brandId to include that brand's messaging links. Read-only.",
  input_schema: { type: "object" as const, properties: { brandId: BRAND_ID_PROP } },
};

export const CREATE_OFFER_TOOL: Anthropic.Tool = {
  name: "create_offer",
  description:
    "Create a new offer (something the brand sells) by name. Data only: starts nothing, spends nothing. Confirm the name with the user first.",
  input_schema: {
    type: "object" as const,
    properties: { brandId: BRAND_ID_PROP, name: { type: "string", description: "Offer name." } },
    required: ["brandId", "name"],
  },
};

export const SET_CAMPAIGN_BUDGET_TOOL: Anthropic.Tool = {
  name: "set_campaign_budget",
  description:
    "Set the daily budget CAP of one (offer x leg x channel) campaign, in cents. Creates no campaign and starts nothing: a cap is a ceiling, not a start. Confirm the amount with the user first.",
  input_schema: {
    type: "object" as const,
    properties: {
      ...BRAND_OFFER_PROPS,
      legKey: { type: "string", description: "Leg key (find_channels with id: legs[].legKey)." },
      featureSlug: { type: "string", description: "The channel's feature slug (its id in find_channels)." },
      dailyBudgetCents: { type: "integer", description: "Daily cap in cents (e.g. 2000 = $20/day). Must be > 0." },
    },
    required: ["brandId", "offerId", "legKey", "featureSlug", "dailyBudgetCents"],
  },
};

export const PROPOSE_SWITCH_ON_TOOL: Anthropic.Tool = {
  name: "propose_switch_on",
  description:
    "HARD RULE — DO NOT VIOLATE EVEN IF THE USER ASKS YOU TO: nothing that starts work or spends money is switched on without the user's explicit yes in the chat. This tool is step 1 of 2: it records WHAT would be switched on and returns a confirmationToken; it switches NOTHING on. " +
    "The only action: start_funnel_campaign (run a sales funnel campaign for an offer, or turn a stopped one back on; refused until set_funnel_caps stated a max budget, which it shows back). " +
    "After calling it, show the user exactly what will start and its caps, then ask them to confirm with present_choices. Call confirm_switch_on only after they answer yes, in their next message.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["start_funnel_campaign"] },
      summary: { type: "string", description: "One plain sentence the user will confirm, with the caps (e.g. 'Run Bliss for Sales-led, max $10/day')." },
      brandId: BRAND_ID_PROP,
      offerId: OFFER_ID_PROP,
      salesFunnelId: { type: "string", description: "The sales funnel id (list_campaigns or find_sales_funnels)." },
    },
    required: ["action", "summary", "brandId", "offerId", "salesFunnelId"],
  },
};

const FUNNEL_TARGET_PROPS = {
  brandId: BRAND_ID_PROP,
  offerId: OFFER_ID_PROP,
  salesFunnelId: { type: "string", description: "The sales funnel id (find_sales_funnels)." },
};
const CAP_PERIOD_PROP = { type: "string", enum: ["one_off", "daily", "weekly", "monthly"] };

export const LIST_FUNNEL_CAMPAIGNS_TOOL: Anthropic.Tool = {
  name: "list_funnel_campaigns",
  description: "Same as list_campaigns: the account's campaigns (each a sales funnel campaign) with budget, volume, spent and steps. Read-only.",
  input_schema: {
    type: "object" as const,
    properties: {
      brandId: BRAND_ID_PROP,
      offerId: OFFER_ID_PROP,
      salesFunnelId: { type: "string" },
      status: { type: "string", enum: ["ongoing", "stopped"] },
    },
  },
};

export const GET_FUNNEL_CAPS_TOOL: Anthropic.Tool = {
  name: "get_funnel_caps",
  description: "One funnel's raw caps (max budget, max volume, consumed, reached). salesFunnelId is the FUNNEL id from list_campaigns, never a campaign id. For 'the budget of each campaign', list_campaigns already says it in words. Read-only.",
  input_schema: { type: "object" as const, properties: FUNNEL_TARGET_PROPS, required: ["brandId", "offerId", "salesFunnelId"] },
};

export const SET_FUNNEL_CAPS_TOOL: Anthropic.Tool = {
  name: "set_funnel_caps",
  description:
    "State a funnel's MAX BUDGET and MAX VOLUME, both ASKED from the user first (never invent them). Starts nothing. No max budget = the funnel is held unfunded, so maxBudget is required; maxVolume is required too (null only if the user wants no volume cap). A Proactive funnel: 'Max budget' / 'Max volume' (first contacts). A Reactive funnel: asked as 'Up to $X' / 'Up to N prospects handled' (billing counts what its reactive pipes handle).",
  input_schema: {
    type: "object" as const,
    properties: {
      ...FUNNEL_TARGET_PROPS,
      maxBudget: {
        type: "object",
        properties: { amountCents: { type: "integer", description: "In cents." }, period: CAP_PERIOD_PROP },
        required: ["amountCents", "period"],
      },
      maxVolume: {
        type: "object",
        description: "Or null for no volume cap (only if the user said so).",
        properties: { count: { type: "integer", description: "First contacts (proactive funnel) or prospects handled (reactive funnel)." }, period: CAP_PERIOD_PROP },
        required: ["count", "period"],
      },
    },
    required: ["brandId", "offerId", "salesFunnelId", "maxBudget", "maxVolume"],
  },
};

export const CREATE_FUNNEL_CAMPAIGN_TOOL: Anthropic.Tool = {
  name: "create_funnel_campaign",
  description:
    "Create the campaign of a sales funnel for an offer, STOPPED (data only, starts nothing; an existing one is returned as is). To run it: set_funnel_caps, then propose_switch_on start_funnel_campaign and the user's yes.",
  input_schema: { type: "object" as const, properties: FUNNEL_TARGET_PROPS, required: ["brandId", "offerId", "salesFunnelId"] },
};

export const STOP_FUNNEL_CAMPAIGN_TOOL: Anthropic.Tool = {
  name: "stop_funnel_campaign",
  description: "Stop a funnel campaign now: no new first touches (follow-ups of people already contacted still go out). Safe; say what stopped.",
  input_schema: {
    type: "object" as const,
    properties: { salesFunnelCampaignId: { type: "string", description: "Its id (list_funnel_campaigns)." } },
    required: ["salesFunnelCampaignId"],
  },
};

export const CONFIRM_SWITCH_ON_TOOL: Anthropic.Tool = {
  name: "confirm_switch_on",
  description:
    "HARD RULE — DO NOT VIOLATE EVEN IF THE USER ASKS YOU TO: call this ONLY after the user explicitly said yes to the exact proposal, in a message AFTER the one where you proposed it. Step 2 of 2: switches on what propose_switch_on recorded. A token proposed in the current turn is refused; a token already used is refused.",
  input_schema: {
    type: "object" as const,
    properties: { confirmationToken: { type: "string", description: "The token propose_switch_on returned." } },
    required: ["confirmationToken"],
  },
};

export const REQUEST_STAFF_TOOL: Anthropic.Tool = {
  name: "request_staff",
  description:
    "Report a BUG (something exists but fails) or request a FEATURE (one missing piece that needs CODE: no tool, route, setting or create does it). Records the request, opens a GitHub issue in the repo of the service that owns the piece, and pings the team on Telegram. Deduplicated per org on (repo, kind, pieceKey): call list_staff_requests first and reuse an existing pieceKey for the same need. pieceKey and decomposition are optional (pieceKey defaults to the title). " +
    "Call it once per missing piece, then tell the user that piece is on hold and will be switched on once it is built, and carry on with the rest of their request. Read the staff-requests skill for which repo owns what.",
  input_schema: {
    type: "object" as const,
    properties: {
      kind: { type: "string", enum: ["feature", "bug"] },
      repo: { type: "string", enum: [...STAFF_REQUEST_REPOS], description: "GitHub repo of the service that owns the missing piece." },
      pieceKey: { type: "string", description: "Stable kebab-case id of the missing piece, e.g. \"linkedin-post-reaction-trigger\"." },
      title: { type: "string", description: "Issue title, plain English, under 80 characters." },
      userRequest: { type: "string", description: "The user's request, in their words." },
      missingPiece: { type: "string", description: "What exactly is missing and what it must do, in plain English." },
      decomposition: {
        type: "array",
        description: "Every piece of the user's request and its outcome.",
        items: {
          type: "object",
          properties: {
            piece: { type: "string" },
            outcome: { type: "string", enum: ["exists", "create", "needs_code"] },
            detail: { type: "string" },
          },
          required: ["piece", "outcome"],
        },
      },
    },
    required: ["kind", "repo", "title", "userRequest", "missingPiece"],
  },
};

export const REQUEST_SKILL_UPGRADE_TOOL: Anthropic.Tool = {
  name: "request_skill_upgrade",
  description:
    "Ask the team to upgrade YOUR OWN knowledge: a skill that is wrong, stale or missing something you needed (skillSlug), or a service's documentation that misled you (repo). Opens a GitHub issue with your proposed text (chat-service for a skill, the service's repo for its docs) and pings the team. Use it whenever a skill or doc made you hesitate, guess or fail; then carry on. Never tell the user about it unless they ask.",
  input_schema: {
    type: "object" as const,
    properties: {
      skillSlug: { type: "string", description: "The skill to upgrade (a slug from the skill index). Or send repo instead." },
      repo: { type: "string", enum: [...STAFF_REQUEST_REPOS], description: "The service whose docs (openapi descriptions, README) are wrong. Or send skillSlug instead." },
      title: { type: "string", description: "Short title, under 80 characters." },
      problem: { type: "string", description: "What is wrong or missing, and what it made you do." },
      proposedChange: { type: "string", description: "The text you propose, ready to paste (markdown)." },
      userRequest: { type: "string", description: "Optional: the user's words that exposed the gap." },
    },
    required: ["title", "problem", "proposedChange"],
  },
};

export const CONTACT_HUMAN_TOOL: Anthropic.Tool = {
  name: "contact_human",
  description:
    "Put the user in touch with a person of the distribute.you team NOW: sends their message to the founder's phone (Telegram). Use it when the user asks for a human, is upset, or needs a decision you cannot make (pricing, refund, a deal). One ping per org every 10 minutes; a repeat inside that window is recorded, not re-sent. Then tell the user a person has their message and will reply.",
  input_schema: {
    type: "object" as const,
    properties: {
      reason: { type: "string", description: "Why they need a person, under 80 characters." },
      message: { type: "string", description: "What the user wants to say, in their words, with any detail the person needs to reply." },
      urgency: { type: "string", enum: ["normal", "urgent"], description: "urgent only when money or a live client is at stake." },
    },
    required: ["reason", "message"],
  },
};

// --- Agent catalogue (features-service /internal/catalogue): walk a request level by level ---

const CATALOGUE_PAGE_PROPS = {
  q: { type: "string", description: "Optional text search on name and line." },
  limit: { type: "integer", description: "Rows per page, 1 to 25 (default 10). Keep it small." },
  id: { type: "string", description: "Optional: read ONE object in detail instead of a list." },
};

const INCLUDE_NOT_RUNNABLE_PROP = {
  includeNotRunnable: {
    type: "boolean",
    description: "STAFF ONLY: also list what we do not run today. Never for a customer request.",
  },
};

const CATALOGUE_ROW_NOTE =
  "Lists ONLY what we run today (a channel we do not run, like LinkedIn posting, is not listed; reading one by id answers weRunItToday: false). Each row: id, name, icon, one line, cost (figure AND unit, e.g. '$2.73 per website visit', '(estimated)' when it is one: quote it as written, never move a cost to another unit, never call an estimate measured), return (e.g. '0.91x (estimated)': quote the basis too), costUsd, roi, status, type (sales funnels: proactive reaches out, reactive answers a trigger) (measured = fleet evidence; learning = not enough history, cost and roi null; customer_time = the customer's own team). Quote figures exactly. Read-only, free.";

const idList = (description: string) => ({ type: "array", items: { type: "string" }, description });

export const FIND_STEPS_TOOL: Anthropic.Tool = {
  name: "find_steps",
  description:
    "Level 1 of organizing a request: the STEPS a lead can reach (Lead found, Website visit, Positive reply, Meeting booked, Paid client…), each with its value in USD. Start here to find the step the user's ask produces. " +
    CATALOGUE_ROW_NOTE,
  input_schema: { type: "object" as const, properties: CATALOGUE_PAGE_PROPS },
};

export const FIND_SALES_PATHS_TOOL: Anthropic.Tool = {
  name: "find_sales_paths",
  description:
    "Level 2: SALES PATHS, chains of steps from first contact to Paid client (no channel yet), ranked by return. Filter with containsSteps (step ids from find_steps). " +
    CATALOGUE_ROW_NOTE,
  input_schema: {
    type: "object" as const,
    properties: { containsSteps: idList("Step ids (or labels) the path must contain."), ...CATALOGUE_PAGE_PROPS, ...INCLUDE_NOT_RUNNABLE_PROP },
  },
};

export const FIND_CHANNELS_TOOL: Anthropic.Tool = {
  name: "find_channels",
  description:
    "Level 3: CHANNELS (cold email, LinkedIn posting, WhatsApp…) that can work the legs of the chosen paths. Filter with forPaths (sales path ids) or legKeys. " +
    CATALOGUE_ROW_NOTE,
  input_schema: {
    type: "object" as const,
    properties: {
      forPaths: idList("Sales path ids from find_sales_paths."),
      legKeys: idList("Leg keys (e.g. lead_found_to_conversation)."),
      ...CATALOGUE_PAGE_PROPS,
      ...INCLUDE_NOT_RUNNABLE_PROP,
    },
  },
};

export const FIND_PIPES_TOOL: Anthropic.Tool = {
  name: "find_pipes",
  description:
    "Level 4: PIPES, one channel working one leg (proactive = own budget, reactive = runs on a trigger), with cost per outcome. Filter with paths and/or channels. Internal word: never say \"pipe\" to the user unless they ask. " +
    CATALOGUE_ROW_NOTE,
  input_schema: {
    type: "object" as const,
    properties: {
      paths: idList("Sales path ids."),
      channels: idList("Channel ids (slugs) from find_channels."),
      legKeys: idList("Leg keys."),
      ...CATALOGUE_PAGE_PROPS,
      ...INCLUDE_NOT_RUNNABLE_PROP,
    },
  },
};

export const FIND_SALES_FUNNELS_TOOL: Anthropic.Tool = {
  name: "find_sales_funnels",
  description:
    "Level 5: SALES FUNNELS, a sales path with one pipe per leg: the thing you PROPOSE to the user (name, cost per paying client, ROI). Filter with paths and/or containsChannels. Read one with id for its legs, rates and pipes. " +
    CATALOGUE_ROW_NOTE,
  input_schema: {
    type: "object" as const,
    properties: {
      paths: idList("Sales path ids."),
      containsChannels: idList("Channel ids the funnel must use."),
      ...CATALOGUE_PAGE_PROPS,
      ...INCLUDE_NOT_RUNNABLE_PROP,
    },
  },
};

export const FIND_WORKFLOWS_TOOL: Anthropic.Tool = {
  name: "find_workflows",
  description:
    "Level 6 (optional, the platform picks the best one by itself): the WORKFLOWS that run one pipe, ranked. Only when the user wants to choose how a step runs. " +
    CATALOGUE_ROW_NOTE,
  input_schema: {
    type: "object" as const,
    properties: { pipe: { type: "string", description: "The pipe id (`<channel slug>|<leg key>`)." }, ...CATALOGUE_PAGE_PROPS },
    required: ["pipe"],
  },
};

const CATALOGUE_USER_REQUEST_PROP = {
  type: "string",
  description: "The user's request, in their words (carried into any staff request this create files).",
};

const CATALOGUE_CREATE_RULE =
  "Creates DATA only: starts nothing, spends nothing. Check with the find tool first: never create what exists. Confirm the name and what it does with the user first.";

export const CREATE_STEP_TOOL: Anthropic.Tool = {
  name: "create_step",
  description: "Create a NEW step (a stage a lead can reach that the catalogue lacks, e.g. \"Followed on LinkedIn\"). " + CATALOGUE_CREATE_RULE,
  input_schema: {
    type: "object" as const,
    properties: {
      key: { type: "string", description: "snake_case id, e.g. linkedin_follow." },
      label: { type: "string", description: "Short name, e.g. \"LinkedIn follow\"." },
      description: { type: "string" },
      shortDescription: { type: "string", description: "One line, under 80 characters." },
      icon: { type: "string", description: "Phosphor icon name, kebab-case." },
      towardStep: { type: "string", description: "The existing step it leads to (e.g. conversation)." },
      towardRatePct: { type: "number", description: "Share of people at this step who reach towardStep, in (0, 100]." },
      producedBy: { type: "string", description: "Optional: what produces this step." },
    },
    required: ["key", "label", "description", "shortDescription", "icon", "towardStep", "towardRatePct"],
  },
};

export const CREATE_PIPE_TOOL: Anthropic.Tool = {
  name: "create_pipe",
  description:
    "Create a NEW pipe: a channel working one leg (fromStep -> toStep). Proactive: no trigger. Reactive: exactly one triggerId (list_trigger_types). " +
    CATALOGUE_CREATE_RULE +
    " A new pipe is a DRAFT until staff publishes it: the tool files that request itself and returns created_on_hold. A reactive pipe on a trigger nothing fires is not created: the tool files the detector request and returns on_hold. Say it is on hold with the team, never call request_staff again for it.",
  input_schema: {
    type: "object" as const,
    properties: {
      channelSlug: { type: "string" },
      fromStep: { type: "string", description: "Step id, or omit for a pipe that starts from nothing." },
      toStep: { type: "string" },
      mode: { type: "string", enum: ["proactive", "reactive"] },
      triggerId: { type: "string", description: "Reactive only." },
      conversionRatePct: { type: "number", description: "Only when the tool says no rate is known for this leg." },
      userRequest: CATALOGUE_USER_REQUEST_PROP,
    },
    required: ["channelSlug", "toStep", "mode", "userRequest"],
  },
};

export const CREATE_SALES_PATH_TOOL: Anthropic.Tool = {
  name: "create_sales_path",
  description:
    "Create a NEW sales path: leg keys in order, from an entry leg to Paid client, each performed by some pipe. Returns created:false when it already exists. " + CATALOGUE_CREATE_RULE,
  input_schema: {
    type: "object" as const,
    properties: { legKeys: idList("Leg keys in order, e.g. [\"lead_found_to_conversation\", \"conversation_to_paid_client\"].") },
    required: ["legKeys"],
  },
};

export const CREATE_SALES_FUNNEL_TOOL: Anthropic.Tool = {
  name: "create_sales_funnel",
  description:
    "Create a NEW sales funnel: one entry per leg of a sales path, in order: a pipe id, or the bare leg key of a leg no channel performs (the customer's team). Returns created:false when it exists. " +
    CATALOGUE_CREATE_RULE +
    " A funnel using a draft pipe is on hold until staff publishes it (filed for you).",
  input_schema: {
    type: "object" as const,
    properties: { pipeIds: idList("One per leg, in order."), userRequest: CATALOGUE_USER_REQUEST_PROP },
    required: ["pipeIds", "userRequest"],
  },
};

// --- Infra discovery by depth (api-registry /discover, /call) ---

export const DISCOVER_SERVICES_TOOL: Anthropic.Tool = {
  name: "discover_services",
  description:
    "Infra level 1: every platform service, one line each, with its endpoint count. Start here to build or understand something new. Read-only, free.",
  input_schema: {
    type: "object" as const,
    properties: { q: { type: "string", description: "Optional text search." }, limit: { type: "integer", description: "1 to 50." } },
  },
};

export const DISCOVER_SERVICE_ENDPOINTS_TOOL: Anthropic.Tool = {
  name: "discover_service_endpoints",
  description:
    "Infra level 2: one service's endpoints, one line each, with average cost, duration and success rate from real runs. Read-only, free.",
  input_schema: {
    type: "object" as const,
    properties: {
      service: { type: "string", description: "Service name from discover_services (e.g. \"features\")." },
      q: { type: "string", description: "Optional text search." },
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      limit: { type: "integer", description: "1 to 50." },
    },
    required: ["service"],
  },
};

export const DISCOVER_ENDPOINT_TOOL: Anthropic.Tool = {
  name: "discover_endpoint",
  description: "Infra level 3: one endpoint's full doc (params, body, response), its run stats, and how to test-run it. Read-only, free.",
  input_schema: {
    type: "object" as const,
    properties: {
      service: { type: "string" },
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      path: { type: "string", description: "The path exactly as discover_service_endpoints listed it." },
    },
    required: ["service", "method", "path"],
  },
};

export const TEST_ENDPOINT_TOOL: Anthropic.Tool = {
  name: "test_endpoint",
  description:
    "Infra level 4: test-run ONE read endpoint (GET) as this account, to see real data before building on it. Only /orgs/, /public/ and /v1/ routes; never internal, admin or staff ones. Any cost is billed to this account: say so if the endpoint shows a cost. Large bodies are cut to keep the chat small. A write the user needs is a feature request (request_staff), never a test run.",
  input_schema: {
    type: "object" as const,
    properties: {
      service: { type: "string" },
      path: { type: "string", description: "Concrete path with its ids filled in (no {placeholders})." },
      query: { type: "string", description: "Optional query string without the \"?\", e.g. \"limit=5&status=active\"." },
    },
    required: ["service", "path"],
  },
};

export const LIST_STAFF_REQUESTS_TOOL: Anthropic.Tool = {
  name: "list_staff_requests",
  description: "List the requests this org already escalated to the team (piece, repo, issue link, how many times asked). Read-only.",
  input_schema: { type: "object" as const, properties: {} },
};

// --- Copilot declarations: channels, legs, trigger types, sales paths (features-service) ---

const USER_REQUEST_PROP = {
  type: "string",
  description: "The user's request, in their words (carried into any staff request this declaration files).",
};

const DECLARATION_HOLD_RULE =
  "A declaration lands UNPUBLISHED (invisible to clients) until staff publishes it: the tool files the staff request itself and returns status declared_on_hold with onHold[]. Tell the user that piece is on hold with the team, then carry on. Never call request_staff again for a piece listed in onHold.";

export const LIST_DECLARED_CHANNELS_TOOL: Anthropic.Tool = {
  name: "list_declared_channels",
  description:
    "Every channel of the platform, coded AND declared, each with published / visibleToClients and its legs (mode, trigger, price source). Pass slug for one channel. Read this before declaring a channel or a leg: never declare what exists. Read-only.",
  input_schema: {
    type: "object" as const,
    properties: { slug: { type: "string", description: "Optional: one channel's slug." } },
  },
};

export const DECLARE_CHANNEL_TOOL: Anthropic.Tool = {
  name: "declare_channel",
  description:
    "Create a NEW channel as data (a way to reach leads the catalogue does not have). Creates no leg: declare its legs next with declare_leg. Starts nothing, spends nothing. Confirm the name and what it does with the user first. " +
    DECLARATION_HOLD_RULE,
  input_schema: {
    type: "object" as const,
    properties: {
      slug: { type: "string", description: "kebab-case id, unique (e.g. \"linkedin-voice-note\")." },
      name: { type: "string", description: "Plain name shown to clients." },
      description: { type: "string" },
      shortDescription: { type: "string", description: "One line." },
      icon: { type: "string", description: "Icon name (e.g. \"mic\")." },
      channelType: { type: "string", enum: ["sourcing", "outbound", "conversion", "paid", "earned", "pr"] },
      operatedBy: { type: "string", enum: ["platform", "customer"], description: "Who runs it. A customer-operated channel must be performedBy person." },
      performedBy: { type: "string", enum: ["software", "person"] },
      dailyOperatingCostCents: { type: "integer", description: "What one day of running it costs, in cents (0 if none)." },
      minimumCommitmentDays: { type: "integer" },
      maxDaysToFirstProduction: { type: "integer", description: "Days before it produces a first result." },
      userRequest: USER_REQUEST_PROP,
    },
    required: [
      "slug",
      "name",
      "description",
      "shortDescription",
      "icon",
      "channelType",
      "operatedBy",
      "performedBy",
      "dailyOperatingCostCents",
      "minimumCommitmentDays",
      "maxDaysToFirstProduction",
      "userRequest",
    ],
  },
};

export const LIST_DECLARED_LEGS_TOOL: Anthropic.Tool = {
  name: "list_declared_legs",
  description: "Every leg of every channel (coded and declared), with published / visibleToClients, mode and trigger. Pass channelSlug for one channel. Read-only.",
  input_schema: {
    type: "object" as const,
    properties: { channelSlug: { type: "string", description: "Optional: one channel's slug." } },
  },
};

export const DECLARE_LEG_TOOL: Anthropic.Tool = {
  name: "declare_leg",
  description:
    "Add a leg (one move of a lead from one sales step to the next) to a channel, declared or coded. Proactive legs name no trigger; a reactive leg names exactly one trigger (list_trigger_types). Starts nothing. " +
    "If nothing fires that trigger today, the leg is NOT created: the tool files a staff request to build the detector and returns status on_hold (not an error) — tell the user that piece waits on the team and carry on. " +
    DECLARATION_HOLD_RULE,
  input_schema: {
    type: "object" as const,
    properties: {
      channelSlug: { type: "string", description: "The channel that performs the leg." },
      fromStep: { type: "string", description: "Step the lead is at (e.g. \"lead_found\", \"positive_reply\"). Omit for the entry leg." },
      toStep: { type: "string", description: "Step the leg moves the lead to (e.g. \"positive_reply\", \"meeting_booked\", \"paid\")." },
      mode: { type: "string", enum: ["proactive", "reactive"] },
      triggerId: { type: "string", description: "Reactive only: the trigger type id that runs it." },
      userRequest: USER_REQUEST_PROP,
    },
    required: ["channelSlug", "toStep", "mode", "userRequest"],
  },
};

export const LIST_TRIGGER_TYPES_TOOL: Anthropic.Tool = {
  name: "list_trigger_types",
  description:
    "Every trigger type (coded and declared): kind (event | delay | poll), params, and coded = something fires it today. Only a coded trigger can run a reactive leg. Pass triggerId for one. Read-only.",
  input_schema: {
    type: "object" as const,
    properties: { triggerId: { type: "string", description: "Optional: one trigger type id." } },
  },
};

export const DECLARE_TRIGGER_TYPE_TOOL: Anthropic.Tool = {
  name: "declare_trigger_type",
  description:
    "Declare a NEW trigger type (an event that should run a reactive leg). kind event = a service detects something on a lead; delay = N days after a step if nothing happened (params {afterStep, days}); poll = a new item appeared at a source (params {source, everyMinutes >= 5}). " +
    "A declared trigger is NOT coded until a detector for it runs: the tool files the staff request for that detector itself and returns status declared_on_hold. Check list_trigger_types first: never declare one that exists.",
  input_schema: {
    type: "object" as const,
    properties: {
      id: { type: "string", description: "snake_case id (e.g. \"no_reply_after_3_days\")." },
      label: { type: "string" },
      description: { type: "string" },
      icon: { type: "string" },
      kind: { type: "string", enum: ["event", "delay", "poll"] },
      fromStep: { type: "string", description: "event: the step the lead is at when it fires." },
      firedBy: { type: "string", description: "event: the service that detects it, if known." },
      params: { type: "object", description: "delay: {afterStep, days}. poll: {source, everyMinutes}." },
      userRequest: USER_REQUEST_PROP,
    },
    required: ["id", "label", "description", "icon", "kind", "userRequest"],
  },
};

export const LIST_DECLARED_SALES_PATHS_TOOL: Anthropic.Tool = {
  name: "list_declared_sales_paths",
  description:
    "The sales paths declared at run time (chains of channel legs), each with its name and visibleToClients. Pass combinationKey for one. For an offer's ranked paths use list_sales_paths. Read-only.",
  input_schema: {
    type: "object" as const,
    properties: { combinationKey: { type: "string", description: "Optional: one path's combinationKey." } },
  },
};

export const DECLARE_SALES_PATH_TOOL: Anthropic.Tool = {
  name: "declare_sales_path",
  description:
    "Declare a NEW sales path: 1 to 12 channel legs in order, starting at the entry step, each leg starting where the previous ended, ending at paid, no loop. Every leg must exist (declare it first). Ticks nothing and starts nothing. " +
    "A path is visible to clients once all its legs and channels are published; the tool files the publish requests for the ones that are not. " +
    DECLARATION_HOLD_RULE,
  input_schema: {
    type: "object" as const,
    properties: {
      legs: {
        type: "array",
        description: "The legs in order.",
        items: {
          type: "object",
          properties: { channelSlug: { type: "string" }, legKey: { type: "string" } },
          required: ["channelSlug", "legKey"],
        },
      },
      userRequest: USER_REQUEST_PROP,
    },
    required: ["legs", "userRequest"],
  },
};

// ---------------------------------------------------------------------------
// Tool registry — every tool the service knows how to execute.
// Clients choose which subset to enable via allowedTools in their config.
// ---------------------------------------------------------------------------

/**
 * Declaration tools build what we do not run yet: staff only, on an explicit
 * ask. The `staffBuild` flag is checked server-side (catalogue-client
 * assertStaffBuild) together with the requester being staff.
 */
function withStaffBuild(tool: Anthropic.Tool): Anthropic.Tool {
  const schema = tool.input_schema as { properties?: Record<string, unknown>; required?: string[] };
  return {
    ...tool,
    description: `STAFF ONLY, on an explicit ask to build something we do not run yet (set staffBuild: true). Never for a customer request: we only offer what we run today. ${tool.description ?? ""}`,
    input_schema: {
      ...tool.input_schema,
      properties: {
        ...(schema.properties ?? {}),
        staffBuild: { type: "boolean", description: "true only when a staff member explicitly asked to build this." },
      },
    } as Anthropic.Tool["input_schema"],
  };
}

export const TOOL_REGISTRY: Record<string, Anthropic.Tool> = {
  request_user_input: REQUEST_USER_INPUT_TOOL,
  create_workflow: CREATE_WORKFLOW_TOOL,
  upgrade_workflow: UPGRADE_WORKFLOW_TOOL,
  fork_workflow: FORK_WORKFLOW_TOOL,
  validate_workflow: VALIDATE_WORKFLOW_TOOL,
  get_prompt_template: GET_PROMPT_TEMPLATE_TOOL,
  update_prompt_template: UPDATE_PROMPT_TEMPLATE_TOOL,
  get_workflow_details: GET_WORKFLOW_DETAILS_TOOL,
  get_workflow_required_providers: GET_WORKFLOW_REQUIRED_PROVIDERS_TOOL,
  list_workflows: LIST_WORKFLOWS_TOOL,
  list_services: LIST_SERVICES_TOOL,
  list_service_endpoints: LIST_SERVICE_ENDPOINTS_TOOL,
  list_org_keys: LIST_ORG_KEYS_TOOL,
  get_key_source: GET_KEY_SOURCE_TOOL,
  list_key_sources: LIST_KEY_SOURCES_TOOL,
  check_provider_requirements: CHECK_PROVIDER_REQUIREMENTS_TOOL,
  create_feature: CREATE_FEATURE_TOOL,
  update_feature: UPDATE_FEATURE_TOOL,
  list_features: LIST_FEATURES_TOOL,
  get_feature: GET_FEATURE_TOOL,
  get_feature_inputs: GET_FEATURE_INPUTS_TOOL,
  prefill_feature: PREFILL_FEATURE_TOOL,
  get_feature_stats: GET_FEATURE_STATS_TOOL,
  update_campaign_fields: UPDATE_CAMPAIGN_FIELDS_TOOL,
  extract_brand_fields: EXTRACT_BRAND_FIELDS_TOOL,
  browse_url: BROWSE_URL_TOOL,
  list_personas: LIST_PERSONAS_TOOL,
  create_persona: CREATE_PERSONA_TOOL,
  duplicate_persona: DUPLICATE_PERSONA_TOOL,
  set_persona_status: SET_PERSONA_STATUS_TOOL,
  get_brand_profile: GET_BRAND_PROFILE_TOOL,
  save_brand_profile_version: SAVE_BRAND_PROFILE_VERSION_TOOL,
  refresh_brand_profile_from_website: REFRESH_BRAND_PROFILE_FROM_WEBSITE_TOOL,
  list_audiences: LIST_AUDIENCES_TOOL,
  suggest_audiences: SUGGEST_AUDIENCES_TOOL,
  set_audience_status: SET_AUDIENCE_STATUS_TOOL,
  rename_audience: RENAME_AUDIENCE_TOOL,
  refresh_audience_count: REFRESH_AUDIENCE_COUNT_TOOL,
  generate_audience_avatar: GENERATE_AUDIENCE_AVATAR_TOOL,
  list_qualification_checks: LIST_QUALIFICATION_CHECKS_TOOL,
  list_qualification_sources: LIST_QUALIFICATION_SOURCES_TOOL,
  suggest_qualification_checks: SUGGEST_QUALIFICATION_CHECKS_TOOL,
  create_qualification_check: CREATE_QUALIFICATION_CHECK_TOOL,
  update_qualification_check: UPDATE_QUALIFICATION_CHECK_TOOL,
  archive_qualification_check: ARCHIVE_QUALIFICATION_CHECK_TOOL,
  create_brand_from_url: CREATE_BRAND_FROM_URL_TOOL,
  list_brands: LIST_BRANDS_TOOL,
  launch_campaign: LAUNCH_CAMPAIGN_TOOL,
  list_campaigns: LIST_CAMPAIGNS_TOOL,
  stop_campaign: STOP_CAMPAIGN_TOOL,
  get_daily_budget: GET_DAILY_BUDGET_TOOL,
  set_daily_budget: SET_DAILY_BUDGET_TOOL,
  get_brand_pause: GET_BRAND_PAUSE_TOOL,
  set_brand_pause: SET_BRAND_PAUSE_TOOL,
  list_offers: LIST_OFFERS_TOOL,
  get_billing_account: GET_BILLING_ACCOUNT_TOOL,
  get_org_usage: GET_ORG_USAGE_TOOL,
  get_spend_by_campaign: GET_SPEND_BY_CAMPAIGN_TOOL,
  get_offer_performance: GET_OFFER_PERFORMANCE_TOOL,
  list_replies_to_handle: LIST_REPLIES_TO_HANDLE_TOOL,
  list_recent_runs: LIST_RECENT_RUNS_TOOL,
  present_choices: PRESENT_CHOICES_TOOL,
  open_page: OPEN_PAGE_TOOL,
  read_skill: READ_SKILL_TOOL,
  get_leg_rates: GET_LEG_RATES_TOOL,
  list_sales_paths: LIST_SALES_PATHS_TOOL,
  get_trigger_events: GET_TRIGGER_EVENTS_TOOL,
  list_sourcing_origins: LIST_SOURCING_ORIGINS_TOOL,
  get_offer_sourcing: GET_OFFER_SOURCING_TOOL,
  get_campaign_budgets: GET_CAMPAIGN_BUDGETS_TOOL,
  get_campaign: GET_CAMPAIGN_TOOL,
  list_connected_accounts: LIST_CONNECTED_ACCOUNTS_TOOL,
  create_offer: CREATE_OFFER_TOOL,
  set_campaign_budget: SET_CAMPAIGN_BUDGET_TOOL,
  propose_switch_on: PROPOSE_SWITCH_ON_TOOL,
  confirm_switch_on: CONFIRM_SWITCH_ON_TOOL,
  list_funnel_campaigns: LIST_FUNNEL_CAMPAIGNS_TOOL,
  get_funnel_caps: GET_FUNNEL_CAPS_TOOL,
  set_funnel_caps: SET_FUNNEL_CAPS_TOOL,
  create_funnel_campaign: CREATE_FUNNEL_CAMPAIGN_TOOL,
  stop_funnel_campaign: STOP_FUNNEL_CAMPAIGN_TOOL,
  request_staff: REQUEST_STAFF_TOOL,
  request_skill_upgrade: REQUEST_SKILL_UPGRADE_TOOL,
  contact_human: CONTACT_HUMAN_TOOL,
  list_staff_requests: LIST_STAFF_REQUESTS_TOOL,
  find_steps: FIND_STEPS_TOOL,
  find_sales_paths: FIND_SALES_PATHS_TOOL,
  find_channels: FIND_CHANNELS_TOOL,
  find_pipes: FIND_PIPES_TOOL,
  find_sales_funnels: FIND_SALES_FUNNELS_TOOL,
  find_workflows: FIND_WORKFLOWS_TOOL,
  create_step: CREATE_STEP_TOOL,
  create_pipe: CREATE_PIPE_TOOL,
  create_sales_path: CREATE_SALES_PATH_TOOL,
  create_sales_funnel: CREATE_SALES_FUNNEL_TOOL,
  discover_services: DISCOVER_SERVICES_TOOL,
  discover_service_endpoints: DISCOVER_SERVICE_ENDPOINTS_TOOL,
  discover_endpoint: DISCOVER_ENDPOINT_TOOL,
  test_endpoint: TEST_ENDPOINT_TOOL,
  list_declared_channels: withStaffBuild(LIST_DECLARED_CHANNELS_TOOL),
  declare_channel: withStaffBuild(DECLARE_CHANNEL_TOOL),
  list_declared_legs: withStaffBuild(LIST_DECLARED_LEGS_TOOL),
  declare_leg: withStaffBuild(DECLARE_LEG_TOOL),
  list_trigger_types: withStaffBuild(LIST_TRIGGER_TYPES_TOOL),
  declare_trigger_type: withStaffBuild(DECLARE_TRIGGER_TYPE_TOOL),
  list_declared_sales_paths: withStaffBuild(LIST_DECLARED_SALES_PATHS_TOOL),
  declare_sales_path: withStaffBuild(DECLARE_SALES_PATH_TOOL),
};

/** All tool names available for use in allowedTools config. */
export const AVAILABLE_TOOL_NAMES = Object.keys(TOOL_REGISTRY);

/**
 * Resolve a list of tool names to their Anthropic tool definitions.
 * Ignores unknown names (logs a warning).
 */
export function resolveToolSet(allowedTools: string[]): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [];
  for (const name of allowedTools) {
    const tool = TOOL_REGISTRY[name];
    if (tool) {
      tools.push(tool);
    } else {
      console.warn(`[chat-service] Unknown tool in allowedTools: "${name}" — skipping`);
    }
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FunctionCall {
  name: string;
  args: Record<string, unknown>;
}

export interface UsageMetadata {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

export function buildSystemPrompt(
  basePrompt: string,
  context?: Record<string, unknown>,
  campaignContext?: Record<string, unknown> | null,
): string {
  let prompt = basePrompt;

  if (campaignContext && Object.keys(campaignContext).length > 0) {
    prompt += [
      `\n\n---\n## Campaign Context`,
      `The user launched this campaign with the following inputs. Use them to inform your responses, suggestions, and any content you generate.`,
      JSON.stringify(campaignContext, null, 2),
    ].join("\n");
  }

  if (context && Object.keys(context).length > 0) {
    prompt += [
      `\n\n---\n## Additional Context (this request only)`,
      JSON.stringify(context, null, 2),
    ].join("\n");
  }

  return prompt;
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export interface AnthropicOptions {
  apiKey: string;
  systemPrompt: string;
}

export function createAnthropicClient({ apiKey, systemPrompt }: AnthropicOptions) {
  const client = new Anthropic({ apiKey });

  return {
    model: MODEL,

    /**
     * Create a streaming request to Claude with compaction and context management.
     * Returns a MessageStream that is async-iterable and provides .finalMessage().
     */
    createStream(
      messages: Anthropic.MessageParam[],
      tools?: Anthropic.Tool[],
      signal?: AbortSignal,
      opts?: {
        /** Versioned model id (the chat config's resolved alias). Defaults to MODEL. */
        model?: string;
        /**
         * Turn on prompt caching (5-minute TTL). Pass true ONLY for a model whose
         * cache rows are priced (`anthropicCachePriced`); the usage reader throws
         * on cache tokens for any other model.
         */
        cache?: boolean;
      },
    ) {
      const cache = opts?.cache === true;
      // Build params with beta context management for compaction
      const params = {
        model: opts?.model ?? MODEL,
        max_tokens: MAX_TOKENS,
        // Caching, when on, uses two of the four breakpoints: an explicit one on
        // the system block (tools render before system, so this caches tools +
        // system — the prefix every turn of every chat on this config shares),
        // and top-level automatic caching for the growing conversation tail, so
        // turn N+1 reads turn N's whole prefix. Context editing (clear_tool_uses
        // above 50k, compaction above 100k) rewrites history and misses the tail
        // cache once when it fires; the system breakpoint survives it.
        system: [
          {
            type: "text" as const,
            text: systemPrompt,
            ...(cache ? { cache_control: { type: "ephemeral" as const } } : {}),
          },
        ],
        ...(cache ? { cache_control: { type: "ephemeral" as const } } : {}),
        messages,
        tools: tools && tools.length > 0 ? tools : undefined,
        // A thinking block is signed against the conversation prefix it was
        // made in. Compaction (above 100k) and history trimming REWRITE that
        // prefix, after which the API 400s the whole turn ("The block is bound
        // to a different conversation", prod 2026-10-10). drop_block makes the
        // API drop such a stale block instead (thinking-binding-controls beta).
        thinking: {
          type: "adaptive" as const,
          block_binding: { prefix_mismatch_behavior: "drop_block" as const },
        },
        // Beta: context management for automatic compaction
        context_management: {
          edits: [
            {
              type: "clear_thinking_20251015",
              keep: { type: "thinking_turns", value: 2 },
            },
            {
              type: "compact_20260112",
              trigger: { type: "input_tokens", value: 100_000 },
              pause_after_compaction: false,
            },
            {
              type: "clear_tool_uses_20250919",
              trigger: { type: "input_tokens", value: 50_000 },
              keep: { type: "tool_uses", value: 5 },
              exclude_tools: ["request_user_input", "present_choices", "open_page"],
              clear_tool_inputs: false,
            },
          ],
        },
      };

      return client.messages.stream(
        params as unknown as Anthropic.MessageCreateParamsStreaming,
        {
          signal,
          headers: {
            "anthropic-beta": "compact-2026-01-12,context-management-2025-06-27,thinking-binding-controls-2026-08-01",
          },
        },
      );
    },

    /**
     * Non-streaming completion — single request/response.
     * Used by POST /complete for service-to-service calls.
     */
    async complete(
      message: string,
      options?: {
        responseFormat?: "json";
        /**
         * Optional JSON Schema enforced server-side by Anthropic via
         * `output_config.format = { type: "json_schema", schema }`.
         * Must be a strict schema: `additionalProperties: false` and an
         * explicit `properties` map. Permissive schemas return 400.
         */
        responseSchema?: Record<string, unknown>;
        temperature?: number;
        model?: string;
        imageUrl?: string;
        /**
         * Optional output cap. Defaults to MAX_TOKENS (64k). A caller that
         * declares a smaller budget (POST /complete `maxTokens`) caps generation
         * here too. Anthropic's API requires `max_tokens`, so this only ever
         * lowers it from the default, never removes it.
         */
        maxTokens?: number;
        /**
         * Opt-in native server-side web search. When true, attaches Anthropic's
         * `web_search_20250305` tool so Claude answers from live web results.
         * Default (false/undefined) is byte-identical to a non-grounded call.
         * See POST /complete `webSearch`.
         */
        webSearch?: boolean;
        /**
         * Minimize thinking. On a model listed in ANTHROPIC_EFFORT_FLOOR this
         * sends `output_config.effort` at that floor; elsewhere a no-op.
         */
        disableThinking?: boolean;
        /**
         * Cache the system prompt (+ tools) with a 5-minute breakpoint. Pass
         * true ONLY for a model whose cache rows are priced
         * (`anthropicCachePriced`). The user message is never cached: it is the
         * per-call part, so a breakpoint after it would be a write nobody reads.
         */
        cache?: boolean;
      },
    ): Promise<{
      content: string;
      /** Every prompt token, cached or not (input + cache read + cache write). */
      tokensInput: number;
      tokensOutput: number;
      /** The four billed dimensions — declare costs from this, never from tokensInput. */
      billed: AnthropicBilledTokens;
      model: string;
      /** Number of server-side web searches Claude ran (0 when off). */
      searchCount: number;
      /** Citation/result source URLs surfaced by web_search (empty when off). */
      sources: Array<{ url: string; title?: string }>;
    }> {
      const effectiveModel = options?.model ?? MODEL;

      // Last line of defence on a request shape this model refuses. The
      // completion routes check the same thing earlier so the caller gets a 400
      // before a cost is held; this makes it unreachable from any other caller.
      assertAnthropicSamplingSupported(effectiveModel, options?.temperature);

      // Build user content — multimodal when imageUrl is provided
      let userContent: Anthropic.MessageCreateParamsNonStreaming["messages"][0]["content"];
      if (options?.imageUrl) {
        userContent = [
          {
            type: "image",
            source: { type: "url", url: options.imageUrl },
          },
          { type: "text", text: message },
        ];
      } else {
        userContent = message;
      }

      // Structured-output enforcement: if the caller supplies `responseSchema`,
      // pass it via `output_config.format` so Anthropic guarantees valid JSON of
      // that shape. Without a schema, do NOT pass `output_config` (Anthropic
      // rejects permissive schemas with 400). Callers requiring JSON mode on
      // Anthropic must supply `responseSchema`; the route handlers reject
      // `responseFormat:"json"` without a schema upfront.
      const effort = options?.disableThinking === true ? anthropicEffortFloor(effectiveModel) : null;
      const outputConfig = {
        ...(options?.responseSchema != null
          ? {
              format: {
                type: "json_schema",
                // Anthropic strict mode requires `additionalProperties: false`
                // on every object node — stamp it on before sending (mirror of
                // the Gemini sanitizer, which strips it). See prepareAnthropicSchema.
                schema: prepareAnthropicSchema(options.responseSchema),
              },
            }
          : {}),
        ...(effort != null ? { effort } : {}),
      };
      const params = {
        model: effectiveModel,
        max_tokens: Math.min(options?.maxTokens ?? MAX_TOKENS, MAX_TOKENS),
        // Forwarded byte-equal either way; the cache marker is request metadata.
        system: options?.cache === true
          ? [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
          : systemPrompt,
        messages: [{ role: "user", content: userContent }],
        ...(options?.temperature != null ? { temperature: options.temperature } : {}),
        ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
        // Native server-side web search. Attached only when requested, keeping
        // non-grounded calls byte-identical. max_uses caps billable searches.
        // Capped to 1 by default for cost control (each search = 1 billable
        // web_search_request at $10/1k). A future `maxSearches` request param
        // will make this caller-tunable (tracked in Linear). Do NOT bump back
        // to a higher fixed value without a cost review — see README Cost.
        ...(options?.webSearch
          ? {
              tools: [
                { type: "web_search_20250305", name: "web_search", max_uses: 1 },
              ],
            }
          : {}),
      };

      const timeoutMs = ANTHROPIC_TIMEOUT_MS[effectiveModel] ?? DEFAULT_ANTHROPIC_TIMEOUT_MS;
      // Use streaming transport. Anthropic SDK rejects non-streaming requests
      // when max_tokens implies >10 min runtime ("Streaming is required..."),
      // so we stream under the hood and assemble the final Message.
      //
      // Retry transient errors (overloaded, 429, 5xx) up to ANTHROPIC_STREAM_MAX_RETRIES
      // with exponential backoff. complete() is non-streaming from the caller's view —
      // finalMessage() resolves the entire response atomically, so no partial tokens are
      // emitted and the whole call is always safe to retry. The SDK's own maxRetries does
      // NOT cover the overloaded_error event Anthropic pushes mid-stream after a 200 OK
      // (the stack surfaces in MessageStream._createMessage → Stream.iterator), which is
      // exactly the failure mode this loop catches.
      let response: Anthropic.Message;
      for (let attempt = 0; ; attempt++) {
        try {
          const stream = client.messages.stream(
            params as unknown as Anthropic.MessageStreamParams,
            { timeout: timeoutMs },
          );
          response = await stream.finalMessage();
          break;
        } catch (err) {
          if (isRetryableAnthropicError(err) && attempt < ANTHROPIC_STREAM_MAX_RETRIES) {
            const delay = anthropicRetryDelayMs(err, attempt);
            console.warn(
              `[anthropic] complete() retry ${attempt + 1}/${ANTHROPIC_STREAM_MAX_RETRIES} ` +
                `after ${Math.round(delay)}ms | model=${effectiveModel} | ` +
                `error=${err instanceof Error ? err.message : String(err)}`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          throw err; // Non-retryable or retries exhausted — propagate (route maps to 502)
        }
      }

      if (response.stop_reason === "max_tokens") {
        console.warn(
          `[anthropic] max_tokens hit | model=${effectiveModel}` +
          ` | tokensInput=${response.usage.input_tokens}` +
          ` | tokensOutput=${response.usage.output_tokens}` +
          ` | responseFormat=${options?.responseFormat ?? "text"}` +
          ` — returning partial content`,
        );
      }

      // Extract text from content blocks
      const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === "text",
      );
      const content = textBlocks.map((b) => b.text).join("");

      // Native web-search accounting. The Anthropic SDK types lag the
      // server-tool fields, so read them structurally. searchCount is the
      // billable unit (one per `web_search_requests`); sources are the cited
      // and returned result URLs (deduped) surfaced for the caller's answer.
      const usage = response.usage as unknown as {
        server_tool_use?: { web_search_requests?: number };
      };
      const searchCount = usage.server_tool_use?.web_search_requests ?? 0;
      const sources: Array<{ url: string; title?: string }> = [];
      const seenUrls = new Set<string>();
      const addSource = (url: unknown, title: unknown) => {
        if (typeof url !== "string" || url.length === 0 || seenUrls.has(url)) return;
        seenUrls.add(url);
        sources.push({ url, title: typeof title === "string" ? title : undefined });
      };
      for (const block of response.content as unknown as Array<Record<string, unknown>>) {
        if (block.type === "text" && Array.isArray(block.citations)) {
          for (const c of block.citations as Array<Record<string, unknown>>) {
            if (c?.type === "web_search_result_location") addSource(c.url, c.title);
          }
        } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const r of block.content as Array<Record<string, unknown>>) {
            if (r?.type === "web_search_result") addSource(r.url, r.title);
          }
        }
      }

      const billed = readAnthropicBilledTokens(response.usage);
      return {
        content,
        tokensInput: anthropicPromptTokens(billed),
        tokensOutput: billed.tokensOutput,
        billed,
        model: effectiveModel,
        searchCount,
        sources,
      };
    },
  };
}
