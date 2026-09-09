// ---------------------------------------------------------------------------
// Claude Fable 5.1 (`fable`) and GPT-6 Astra (`gpt-pro`)
//
// Two aliases added together on 2026-09-09 so a cold-email template could be
// A/B'd against two frontier models this service could not previously reach.
// They arrive by different routes — Fable on the existing native Anthropic
// client, Astra on the shared OpenAI-compatible adapter as its fourth vendor —
// and each carries a request-shape fact that no alias before it did:
//
//   fable    rejects `temperature` (Anthropic removed the sampling parameters
//            on its always-thinking models), so a caller re-running an existing
//            request body against it must be refused for free, not after a
//            cost hold and an opaque provider 400.
//   gpt-pro  refuses `max_tokens` (OpenAI made it incompatible with its
//            reasoning models) and has no reasoning-off, only a `low` floor.
//
// Everything else this file asserts is the same standard the other aliases are
// held to: the cost prefix is byte-equal to the catalog row, no existing alias
// moves, and the request contract accepts exactly the pairs that resolve.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  resolveModel,
  costPrefixForModel,
  PROVIDER_MODELS,
  anthropicRejectsSampling,
  assertAnthropicSamplingSupported,
  AnthropicUnsupportedOptionError,
  type Provider,
  type ModelAlias,
} from "../../src/lib/anthropic.js";
import {
  VENDORS,
  VENDOR_IDS,
  buildVendorRequestBody,
  publishedConcurrency,
  isOutOfCreditRefusal,
  vendorConfig,
} from "../../src/lib/openai-compatible.js";
import { buildLlmCostNames } from "../../src/lib/cost-names.js";
import { CompleteRequestSchema, InternalPlatformCompleteRequestSchema } from "../../src/schemas.js";

const AT = new Date("2026-09-09T12:00:00Z");

describe("alias resolution", () => {
  it("resolves `fable` to Claude Fable 5.1 on the native Anthropic path", () => {
    const resolved = resolveModel("anthropic", "fable");
    expect(resolved).toEqual({
      apiModelId: "claude-fable-5-1",
      costPrefix: "anthropic-fable-5.1",
      provider: "anthropic",
    });
  });

  it("resolves `gpt-pro` to GPT-6 Astra on the OpenAI vendor path", () => {
    const resolved = resolveModel("openai", "gpt-pro");
    expect(resolved).toEqual({
      apiModelId: "gpt-6-astra",
      costPrefix: "openai-gpt-6-astra",
      provider: "openai",
    });
  });

  it("leaves every pre-existing alias resolving exactly where it did", () => {
    // The no-go this file exists to protect: adding two aliases must not move
    // any of the twelve that shipped before them. Written out literally rather
    // than derived from the map, so a change to the map cannot quietly change
    // the expectation with it.
    const before: Array<[Provider, ModelAlias, string, string]> = [
      ["anthropic", "haiku", "claude-haiku-4-5", "anthropic-haiku-4.5"],
      ["anthropic", "sonnet", "claude-sonnet-4-6", "anthropic-sonnet-4.6"],
      ["anthropic", "opus", "claude-opus-4-6", "anthropic-opus-4.6"],
      ["google", "flash-lite", "gemini-3.1-flash-lite", "google-flash-lite-3.1"],
      ["google", "flash", "gemini-3.5-flash-lite", "google-flash-lite-3.5"],
      ["google", "flash-pro", "gemini-3.8-flash", "google-flash-3.8"],
      ["google", "pro", "gemini-3.1-pro-preview", "google-pro-3.1"],
      ["deepseek", "deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash"],
      ["deepseek", "deepseek-pro", "deepseek-v4-pro", "deepseek-v4-pro"],
      ["zai", "glm-flash", "glm-5.3-flash", "zai-glm-5.3-flash"],
      ["zai", "glm-pro", "glm-5.3", "zai-glm-5.3"],
      ["moonshot", "kimi-flash", "kimi-k2.6", "moonshot-kimi-k2.6"],
      ["moonshot", "kimi-pro", "kimi-k3", "moonshot-kimi-k3"],
    ];
    for (const [provider, alias, apiModelId, costPrefix] of before) {
      expect(resolveModel(provider, alias)).toEqual({ apiModelId, costPrefix, provider });
    }
  });

  it("names where an alias lives when it is sent under the wrong provider", () => {
    expect(() => resolveModel("openai", "fable" as ModelAlias)).toThrow(/belongs to provider "anthropic"/);
    expect(() => resolveModel("anthropic", "gpt-pro" as ModelAlias)).toThrow(/belongs to provider "openai"/);
  });

  it("keeps the deprecated model-id → prefix map in step with both new models", () => {
    expect(costPrefixForModel("claude-fable-5-1")).toBe("anthropic-fable-5.1");
    expect(costPrefixForModel("gpt-6-astra")).toBe("openai-gpt-6-astra");
  });
});

describe("cost names", () => {
  it("declares Fable on the flat Anthropic shape", () => {
    // Anthropic's catalog rows carry input and output only — its path reports
    // no cached count, so the cached name is built but never declared.
    expect(buildLlmCostNames({ provider: "anthropic", costPrefix: "anthropic-fable-5.1", at: AT })).toEqual({
      input: "anthropic-fable-5.1-tokens-input",
      cachedInput: "anthropic-fable-5.1-tokens-cached-input",
      output: "anthropic-fable-5.1-tokens-output",
    });
  });

  it("declares Astra on three dimensions and no time-of-day regime", () => {
    // OpenAI prices a cache hit ($1 against $10 per 1M) and publishes no
    // peak/off-peak schedule, so the names carry no regime segment. Inventing
    // one would name a row the catalog does not carry, which runs-service 422s.
    expect(buildLlmCostNames({ provider: "openai", costPrefix: "openai-gpt-6-astra", at: AT })).toEqual({
      input: "openai-gpt-6-astra-tokens-input",
      cachedInput: "openai-gpt-6-astra-tokens-cached-input",
      output: "openai-gpt-6-astra-tokens-output",
    });
  });

  it("resolves the same Astra names whatever the clock says", () => {
    const peakHours = new Date("2026-09-09T02:30:00Z");
    const weekend = new Date("2026-09-12T23:00:00Z");
    expect(buildLlmCostNames({ provider: "openai", costPrefix: "openai-gpt-6-astra", at: peakHours })).toEqual(
      buildLlmCostNames({ provider: "openai", costPrefix: "openai-gpt-6-astra", at: weekend }),
    );
  });
});

describe("Anthropic sampling support — Fable rejects temperature", () => {
  it("records Fable as sampling-less and every other Anthropic alias as not", () => {
    expect(anthropicRejectsSampling("claude-fable-5-1")).toBe(true);
    for (const alias of ["haiku", "sonnet", "opus"] as const) {
      expect(anthropicRejectsSampling(resolveModel("anthropic", alias).apiModelId)).toBe(false);
    }
  });

  it("throws before any spend when temperature is paired with Fable", () => {
    expect(() => assertAnthropicSamplingSupported("claude-fable-5-1", 0.3)).toThrow(
      AnthropicUnsupportedOptionError,
    );
    // The message has to be actionable: it names the field to drop and the
    // aliases that accept it, and says retrying will not help.
    expect(() => assertAnthropicSamplingSupported("claude-fable-5-1", 0)).toThrow(
      /temperature.*haiku, sonnet, opus.*will not help/s,
    );
  });

  it("is a no-op when no sampling parameter was sent, or on a model that takes one", () => {
    expect(() => assertAnthropicSamplingSupported("claude-fable-5-1", undefined)).not.toThrow();
    expect(() => assertAnthropicSamplingSupported("claude-fable-5-1", null)).not.toThrow();
    expect(() => assertAnthropicSamplingSupported("claude-sonnet-4-6", 0.7)).not.toThrow();
  });
});

describe("OpenAI vendor entry", () => {
  it("is declared as a full vendor, not a partial one", () => {
    expect(VENDOR_IDS).toContain("openai");
    const config = vendorConfig("openai");
    expect(config.baseUrl).toBe("https://api.openai.com/v1");
    expect(config.pricing).toEqual({ kind: "priced", cachedInput: true, regime: null });
    expect(config.structuredOutput).toBe("json_schema");
  });

  it("reads cached prompt tokens where OpenAI's chat completions report them", () => {
    const read = vendorConfig("openai").readCachedTokens;
    expect(read({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 768 } })).toBe(768);
    // Absent is zero, never a guess — and never another vendor's field, which
    // would invent a discount the invoice does not carry.
    expect(read({ prompt_tokens: 1000 })).toBe(0);
    expect(read({ prompt_tokens: 1000, prompt_cache_hit_tokens: 768 })).toBe(0);
  });

  it("publishes no in-flight concurrency, and that null is not filled in from the RPM column", () => {
    // OpenAI publishes requests-per-minute and tokens-per-minute per account
    // tier. Neither is a concurrency, so `publishedConcurrency` must answer
    // null rather than convert one into the other.
    expect(publishedConcurrency("openai", "gpt-6-astra")).toBeNull();
    const { concurrency } = VENDORS.openai;
    expect(concurrency.scope).toBe("per-account-rate");
    if (concurrency.scope === "per-account-rate") {
      expect(concurrency.tierLimits["tier-1"]).toEqual({ rpm: 500, tpm: 500_000 });
      expect(concurrency.tierLimits["tier-5"]).toEqual({ rpm: 15_000, tpm: 40_000_000 });
    }
  });

  it("classifies OpenAI's empty-balance 429 apart from its rate-limit 429", () => {
    const outOfCredit = JSON.stringify({
      error: { message: "You have no credits remaining.", type: "insufficient_quota", code: "credit_balance_exhausted" },
    });
    const rateLimit = JSON.stringify({
      error: { message: "Rate limit reached for gpt-6-astra", type: "requests", code: "rate_limit_exceeded" },
    });
    expect(isOutOfCreditRefusal("openai", 429, outOfCredit)).toBe(true);
    expect(isOutOfCreditRefusal("openai", 429, rateLimit)).toBe(false);
  });
});

describe("OpenAI request shape", () => {
  const base = {
    vendor: "openai" as const,
    apiKey: "k",
    model: "gpt-6-astra",
    message: "write three cold emails",
  };

  it("caps output under max_completion_tokens, never max_tokens", () => {
    // OpenAI's docs: max_tokens "is not compatible with o-series models".
    // Sending it would be a 400, and the cap the caller declared would never
    // have applied.
    const body = buildVendorRequestBody({ ...base, maxOutputTokens: 4096 });
    expect(body.max_completion_tokens).toBe(4096);
    expect(body.max_tokens).toBeUndefined();
  });

  it("leaves the three incumbent vendors on max_tokens", () => {
    for (const vendor of ["deepseek", "zai", "moonshot"] as const) {
      const body = buildVendorRequestBody({
        vendor,
        apiKey: "k",
        model: resolveModel(vendor, `${vendor === "zai" ? "glm" : vendor === "moonshot" ? "kimi" : "deepseek"}-pro` as ModelAlias).apiModelId,
        message: "m",
        maxOutputTokens: 4096,
      });
      expect(body.max_tokens).toBe(4096);
      expect(body.max_completion_tokens).toBeUndefined();
    }
  });

  it("every vendor declares which output-cap field it takes", () => {
    for (const id of VENDOR_IDS) {
      expect(["max_tokens", "max_completion_tokens"]).toContain(VENDORS[id].maxOutputTokensField);
    }
  });

  it("floors reasoning at `low` for a structured request — Astra has no full-off", () => {
    const body = buildVendorRequestBody({
      ...base,
      responseSchema: { type: "object", properties: { subject: { type: "string" } } },
    });
    expect(body.reasoning_effort).toBe("low");
    // `none` and `minimal` are refused by this model (400), so neither may
    // ever be what we send.
    expect(body.reasoning_effort).not.toBe("none");
    expect(body.reasoning_effort).not.toBe("minimal");
    // And it must not carry another vendor's spelling, which OpenAI would
    // reject rather than ignore.
    expect(body.thinking).toBeUndefined();
  });

  it("leaves reasoning provider-normal for a free-text request", () => {
    expect(buildVendorRequestBody(base).reasoning_effort).toBeUndefined();
  });

  it("honours the caller's explicit tri-state reasoning choice", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    // false keeps reasoning at the provider default for a structured call…
    expect(
      buildVendorRequestBody({ ...base, responseSchema: schema, disableThinking: false }).reasoning_effort,
    ).toBeUndefined();
    // …and true floors it for a free-text one.
    expect(buildVendorRequestBody({ ...base, disableThinking: true }).reasoning_effort).toBe("low");
  });

  it("sends a caller schema in OpenAI's json_schema form", () => {
    const schema = { type: "object", properties: { subject: { type: "string" } }, required: ["subject"] };
    const body = buildVendorRequestBody({ ...base, responseSchema: schema });
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "response", schema } });
  });

  it("forwards the caller's system prompt byte-equal", () => {
    const systemPrompt = "You are a cold-email writer. Return JSON.";
    const body = buildVendorRequestBody({ ...base, systemPrompt });
    expect(body.messages).toEqual([
      { role: "system", content: systemPrompt },
      { role: "user", content: base.message },
    ]);
  });

  it("carries no routing or fallback knobs", () => {
    const body = buildVendorRequestBody({ ...base, responseFormat: "json" });
    for (const knob of ["models", "sort", "order", "provider", "route", "fallbacks"]) {
      expect(body[knob]).toBeUndefined();
    }
    expect(body.model).toBe("gpt-6-astra");
  });
});

describe("request contract", () => {
  const body = { message: "hi", systemPrompt: "s" };

  it("accepts both new pairs on /complete and /internal/platform-complete", () => {
    for (const schema of [CompleteRequestSchema, InternalPlatformCompleteRequestSchema]) {
      expect(schema.safeParse({ ...body, provider: "anthropic", model: "fable" }).success).toBe(true);
      expect(schema.safeParse({ ...body, provider: "openai", model: "gpt-pro" }).success).toBe(true);
    }
  });

  it("rejects a cross-provider pair with a message naming the accepted set", () => {
    const result = CompleteRequestSchema.safeParse({ ...body, provider: "openai", model: "fable" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("gpt-pro");
    }
  });

  it("keeps the enum and the resolver describing the same set of aliases", () => {
    // The two drift independently: an alias added to MODEL_MAP but not to the
    // enum is unreachable, and one added to the enum but not the map reaches
    // resolveModel and 500s instead of 400ing.
    for (const [provider, aliases] of Object.entries(PROVIDER_MODELS)) {
      for (const alias of aliases) {
        expect(
          CompleteRequestSchema.safeParse({ ...body, provider, model: alias }).success,
          `${provider}/${alias} resolves but the request schema rejects it`,
        ).toBe(true);
        expect(() => resolveModel(provider as Provider, alias)).not.toThrow();
      }
    }
  });
});
