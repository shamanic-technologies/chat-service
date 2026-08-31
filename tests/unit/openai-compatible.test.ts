import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildVendorRequestBody,
  assertModelMatches,
  mapVendorResponse,
  completeWithVendor,
  keyResolutionErrorMessage,
  isVendorProvider,
  vendorConfig,
  VendorProviderError,
  VendorUnsupportedOptionError,
  VendorRateLimitError,
  isUnsupportedOptionRefusal,
  parseRetryAfterMs,
  publishedConcurrency,
  shouldDisableVendorReasoning,
  vendorReasoningFields,
  VENDORS,
  VENDOR_IDS,
  type VendorId,
} from "../../src/lib/openai-compatible.js";
import { resolveModel, PROVIDER_MODELS, costPrefixForModel } from "../../src/lib/anthropic.js";
import { CompleteRequestSchema, InternalPlatformCompleteRequestSchema } from "../../src/schemas.js";

const MODEL = "deepseek-v4-flash";

/**
 * The six declared aliases and everything each one pins: which vendor serves
 * it, which model id goes on the wire, and which catalog prefix the spend is
 * declared under. One table so a wrong id is visible rather than buried.
 */
const ALIASES = [
  { provider: "deepseek", alias: "deepseek-flash", modelId: "deepseek-v4-flash", prefix: "deepseek-v4-flash" },
  { provider: "deepseek", alias: "deepseek-pro", modelId: "deepseek-v4-pro", prefix: "deepseek-v4-pro" },
  { provider: "zai", alias: "glm-flash", modelId: "glm-5.3-flash", prefix: "zai-glm-5.3-flash" },
  { provider: "zai", alias: "glm-pro", modelId: "glm-5.3", prefix: "zai-glm-5.3" },
  { provider: "moonshot", alias: "kimi-flash", modelId: "kimi-k2.6", prefix: "moonshot-kimi-k2.6" },
  { provider: "moonshot", alias: "kimi-pro", modelId: "kimi-k3", prefix: "moonshot-kimi-k3" },
] as const;

function okBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-abc123",
    model: MODEL,
    choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 45, prompt_cache_hit_tokens: 100 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Model resolution — a caller can reach every vendor, and nothing else
// ---------------------------------------------------------------------------

describe("direct-vendor model resolution", () => {
  for (const { provider, alias, modelId, prefix } of ALIASES) {
    it(`resolves "${alias}" to ${provider} / ${modelId}`, () => {
      const resolved = resolveModel(provider, alias);
      expect(resolved.provider).toBe(provider);
      expect(resolved.apiModelId).toBe(modelId);
      expect(resolved.costPrefix).toBe(prefix);
    });

    it(`declares the three catalog names for "${alias}"`, () => {
      const { costPrefix } = resolveModel(provider, alias);
      expect(`${costPrefix}-tokens-input`).toBe(`${prefix}-tokens-input`);
      expect(`${costPrefix}-tokens-output`).toBe(`${prefix}-tokens-output`);
      expect(`${costPrefix}-tokens-cached-input`).toBe(`${prefix}-tokens-cached-input`);
    });
  }

  it("keeps the two live DeepSeek aliases on their existing cost prefixes", () => {
    // Existing production callers use these two. The transport moved off the
    // gateway; the catalog names they bill under must NOT move with it.
    expect(resolveModel("deepseek", "deepseek-flash").costPrefix).toBe("deepseek-v4-flash");
    expect(resolveModel("deepseek", "deepseek-pro").costPrefix).toBe("deepseek-v4-pro");
  });

  it("sends the UNDATED vendor model id, letting the vendor pick the build", () => {
    expect(resolveModel("deepseek", "deepseek-pro").apiModelId).toBe("deepseek-v4-pro");
    expect(resolveModel("deepseek", "deepseek-pro").apiModelId).not.toMatch(/-\d{4}$/);
  });

  it("fails loud on an unknown model and names the accepted set", () => {
    expect(() => resolveModel("deepseek", "deepseek-ultra" as never)).toThrow(
      /Unknown model "deepseek-ultra".*Accepted models for "deepseek": deepseek-flash, deepseek-pro/,
    );
    expect(() => resolveModel("zai", "pro" as never)).toThrow(
      /Accepted models for "zai": glm-flash, glm-pro/,
    );
  });

  it("points a right-alias/wrong-provider mistake at the provider that serves it", () => {
    expect(() => resolveModel("zai", "kimi-pro" as never)).toThrow(
      /"kimi-pro" belongs to provider "moonshot"/,
    );
  });

  it("fails loud on an unknown provider and names the accepted set", () => {
    // The removed gateway provider is the concrete case: a caller still sending
    // it must get a clear list, not a silent route to some other vendor.
    expect(() => resolveModel("vercel" as never, "deepseek-flash")).toThrow(
      /Unknown provider: vercel.*anthropic, google, deepseek, zai, moonshot/,
    );
  });

  it("exposes exactly the declared aliases per vendor for Zod validation", () => {
    expect(PROVIDER_MODELS.deepseek).toEqual(["deepseek-flash", "deepseek-pro"]);
    expect(PROVIDER_MODELS.zai).toEqual(["glm-flash", "glm-pro"]);
    expect(PROVIDER_MODELS.moonshot).toEqual(["kimi-flash", "kimi-pro"]);
  });

  it("maps every vendor model id back to its cost prefix", () => {
    for (const { modelId, prefix } of ALIASES) {
      expect(costPrefixForModel(modelId)).toBe(prefix);
    }
  });

  it("leaves the native provider maps untouched", () => {
    expect(resolveModel("google", "flash-pro").costPrefix).toBe("google-flash-3.7");
    expect(resolveModel("anthropic", "sonnet").costPrefix).toBe("anthropic-sonnet-4.6");
  });
});

// ---------------------------------------------------------------------------
// Vendor registry — one adapter, N vendors, differing only in data
// ---------------------------------------------------------------------------

describe("vendor registry", () => {
  it("routes each vendor at its own base URL", () => {
    expect(VENDORS.deepseek.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(VENDORS.zai.baseUrl).toBe("https://api.z.ai/api/paas/v4");
    expect(VENDORS.moonshot.baseUrl).toBe("https://api.moonshot.ai/v1");
  });

  it("uses the vendor id as its key-service provider slug", () => {
    for (const id of VENDOR_IDS) {
      expect(VENDORS[id].id).toBe(id);
      expect(isVendorProvider(id)).toBe(true);
    }
  });

  it("does not claim the native providers or the removed gateway", () => {
    expect(isVendorProvider("anthropic")).toBe(false);
    expect(isVendorProvider("google")).toBe(false);
    expect(isVendorProvider("vercel")).toBe(false);
  });

  it("fails loud rather than defaulting to a vendor on an unknown slug", () => {
    expect(() => vendorConfig("vercel")).toThrow(/Unknown vendor "vercel"/);
  });

  it("reads each vendor's own cached-token field", () => {
    // The three report the same number in three different places; that
    // divergence is the whole reason readCachedTokens is per-vendor data.
    expect(VENDORS.deepseek.readCachedTokens({ prompt_cache_hit_tokens: 90 })).toBe(90);
    expect(VENDORS.zai.readCachedTokens({ prompt_tokens_details: { cached_tokens: 80 } })).toBe(80);
    expect(VENDORS.moonshot.readCachedTokens({ cached_tokens: 70 })).toBe(70);
  });

  it("reads 0 when a vendor reports no cache hit", () => {
    for (const id of VENDOR_IDS) {
      expect(VENDORS[id].readCachedTokens({ prompt_tokens: 10 })).toBe(0);
    }
  });

  it("does not cross-read another vendor's cache field", () => {
    // Reading DeepSeek's field on a Z.ai response would invent a discount that
    // the invoice does not carry.
    expect(VENDORS.deepseek.readCachedTokens({ prompt_tokens_details: { cached_tokens: 80 } })).toBe(0);
    expect(VENDORS.zai.readCachedTokens({ prompt_cache_hit_tokens: 90 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Request schemas — the caller reads these to learn which models exist
// ---------------------------------------------------------------------------

describe("vendor aliases on the request schemas", () => {
  const base = { message: "hi", systemPrompt: "" };

  for (const { provider, alias } of ALIASES) {
    it(`accepts provider "${provider}" + model "${alias}" on POST /complete`, () => {
      expect(CompleteRequestSchema.safeParse({ ...base, provider, model: alias }).success).toBe(true);
    });

    it(`accepts provider "${provider}" + model "${alias}" on /internal/platform-complete`, () => {
      expect(
        InternalPlatformCompleteRequestSchema.safeParse({ ...base, provider, model: alias }).success,
      ).toBe(true);
    });
  }

  it("rejects the removed gateway provider", () => {
    expect(CompleteRequestSchema.safeParse({ ...base, provider: "vercel", model: "deepseek-flash" }).success).toBe(false);
    expect(
      InternalPlatformCompleteRequestSchema.safeParse({ ...base, provider: "vercel", model: "deepseek-flash" }).success,
    ).toBe(false);
  });

  it("rejects an unknown model", () => {
    expect(
      CompleteRequestSchema.safeParse({ ...base, provider: "deepseek", model: "deepseek-ultra" }).success,
    ).toBe(false);
  });

  it("rejects a vendor alias sent with the wrong vendor and names the accepted set", () => {
    const parsed = CompleteRequestSchema.safeParse({ ...base, provider: "zai", model: "kimi-pro" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message).join(" ")).toMatch(
        /not valid for provider "zai".*glm-flash, glm-pro/s,
      );
    }
  });

  it("rejects a vendor alias sent with a native provider on the platform route too", () => {
    const parsed = InternalPlatformCompleteRequestSchema.safeParse({
      ...base,
      provider: "google",
      model: "glm-pro",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message).join(" ")).toMatch(
        /not valid for provider "google".*flash-lite, flash, flash-pro, pro/s,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

describe("buildVendorRequestBody", () => {
  it("builds an OpenAI-shaped non-streaming body", () => {
    const body = buildVendorRequestBody({
      vendor: "deepseek",
      apiKey: "k",
      model: MODEL,
      message: "hello",
      systemPrompt: "You are terse.",
      temperature: 0.3,
      maxOutputTokens: 4096,
    });

    expect(body.model).toBe(MODEL);
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toEqual([
      { role: "system", content: "You are terse." },
      { role: "user", content: "hello" },
    ]);
  });

  it("forwards the caller's systemPrompt byte-equal (no preamble, no nudge)", () => {
    const systemPrompt = "Return ONLY the value. Do not explain.";
    const body = buildVendorRequestBody({ vendor: "zai", apiKey: "k", model: "glm-5.2", message: "m", systemPrompt });
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages.find((m) => m.role === "system")?.content).toBe(systemPrompt);
  });

  it("omits the system message entirely when no systemPrompt is supplied", () => {
    const body = buildVendorRequestBody({ vendor: "moonshot", apiKey: "k", model: "kimi-k3", message: "m" });
    expect(body.messages).toEqual([{ role: "user", content: "m" }]);
  });

  it("requests structured output natively when a responseSchema is supplied", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    const body = buildVendorRequestBody({
      vendor: "zai",
      apiKey: "k",
      model: "glm-5.2",
      message: "m",
      responseSchema: schema,
    });
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "response", schema },
    });
  });

  // -------------------------------------------------------------------------
  // Structured output is per-vendor. Regression for the 2026-08-25 incident:
  // every deepseek-pro completion 400'd with "This response_format type is
  // unavailable now" because the json_schema form was sent to a vendor that
  // implements json_object only.
  // -------------------------------------------------------------------------

  it("sends DeepSeek its own json_object mode when a responseSchema is supplied", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    for (const model of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
      const body = buildVendorRequestBody({
        vendor: "deepseek",
        apiKey: "k",
        model,
        message: "m",
        responseSchema: schema,
      });
      expect(body.response_format).toEqual({ type: "json_object" });
      // The refused form must not appear anywhere on the wire.
      expect(JSON.stringify(body)).not.toContain("json_schema");
    }
  });

  it("leaves the json_schema vendors untouched — only DeepSeek downgrades", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    const bodies = [
      buildVendorRequestBody({ vendor: "zai", apiKey: "k", model: "glm-4.7-flashx", message: "m", responseSchema: schema }),
      buildVendorRequestBody({ vendor: "zai", apiKey: "k", model: "glm-5.2", message: "m", responseSchema: schema }),
      buildVendorRequestBody({ vendor: "moonshot", apiKey: "k", model: "kimi-k2.6", message: "m", responseSchema: schema }),
      buildVendorRequestBody({ vendor: "moonshot", apiKey: "k", model: "kimi-k3", message: "m", responseSchema: schema }),
    ];
    for (const body of bodies) {
      expect(body.response_format).toEqual({
        type: "json_schema",
        json_schema: { name: "response", schema },
      });
    }
  });

  it("asks every vendor for plain json_object when json mode carries no schema", () => {
    for (const vendor of VENDOR_IDS) {
      const body = buildVendorRequestBody({
        vendor,
        apiKey: "k",
        model: "m",
        message: "m",
        responseFormat: "json",
      });
      expect(body.response_format).toEqual({ type: "json_object" });
    }
  });

  it("every vendor declares which response_format it implements", () => {
    for (const vendor of VENDOR_IDS) {
      expect(["json_schema", "json_object"]).toContain(VENDORS[vendor].structuredOutput);
    }
  });

  it("falls back to json_object when json mode is requested without a schema", () => {
    const body = buildVendorRequestBody({
      vendor: "deepseek",
      apiKey: "k",
      model: MODEL,
      message: "m",
      responseFormat: "json",
    });
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("carries NO routing or fallback knobs — a silent model swap would misname the cost", () => {
    const body = buildVendorRequestBody({ vendor: "deepseek", apiKey: "k", model: MODEL, message: "m" });
    expect(body).not.toHaveProperty("models");
    expect(body).not.toHaveProperty("sort");
    expect(body).not.toHaveProperty("provider");
    expect(body).not.toHaveProperty("providerOptions");
  });
});

// ---------------------------------------------------------------------------
// Model-match guard
// ---------------------------------------------------------------------------

describe("assertModelMatches", () => {
  it("accepts the model it asked for", () => {
    expect(() => assertModelMatches(MODEL, MODEL)).not.toThrow();
  });

  it("accepts a case/whitespace variation", () => {
    expect(() => assertModelMatches(MODEL, ` ${MODEL.toUpperCase()} `)).not.toThrow();
  });

  it("accepts a dated build of the requested model", () => {
    // Our aliases are version-free; the vendor resolves the current build. Same
    // model, same price, same catalog name.
    expect(() => assertModelMatches("deepseek-v4-pro", "deepseek-v4-pro-0813")).not.toThrow();
  });

  it("throws when the vendor served a different model", () => {
    expect(() => assertModelMatches(MODEL, "deepseek-v4-pro")).toThrow(/Model mismatch/);
    expect(() => assertModelMatches("glm-5.2", "glm-4.7")).toThrow(/Model mismatch/);
  });

  it("tolerates a missing model echo rather than inventing a mismatch", () => {
    expect(() => assertModelMatches(MODEL, undefined)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

describe("mapVendorResponse", () => {
  it("maps usage onto the shared completion result shape", () => {
    const r = mapVendorResponse("deepseek", MODEL, okBody());
    expect(r.content).toBe('{"ok":true}');
    expect(r.tokensInput).toBe(120);
    expect(r.tokensOutput).toBe(45);
    expect(r.model).toBe(MODEL);
    expect(r.searchCount).toBe(0);
    expect(r.sources).toEqual([]);
    expect(r.vendor).toBe("deepseek");
  });

  it("carries DeepSeek's cache hit through as a subset of the prompt tokens", () => {
    const r = mapVendorResponse("deepseek", MODEL, okBody());
    expect(r.tokensInput).toBe(120);
    expect(r.cachedInputTokens).toBe(100);
    // 20 fresh tokens are what the miss rate applies to.
    expect(r.tokensInput - r.cachedInputTokens).toBe(20);
  });

  it("carries Z.ai's nested cached_tokens", () => {
    const body = okBody({
      model: "glm-5.2",
      usage: { prompt_tokens: 500, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 460 } },
    });
    const r = mapVendorResponse("zai", "glm-5.2", body);
    expect(r.cachedInputTokens).toBe(460);
  });

  it("carries Moonshot's flat cached_tokens", () => {
    const body = okBody({
      model: "kimi-k3",
      usage: { prompt_tokens: 900, completion_tokens: 12, cached_tokens: 850 },
    });
    const r = mapVendorResponse("moonshot", "kimi-k3", body);
    expect(r.cachedInputTokens).toBe(850);
  });

  it("clamps a cached count that exceeds the prompt total", () => {
    // A negative fresh-token quantity would make runs-service reject the whole
    // declaration and fail a call that actually succeeded.
    const body = okBody({ usage: { prompt_tokens: 50, completion_tokens: 5, prompt_cache_hit_tokens: 999 } });
    const r = mapVendorResponse("deepseek", MODEL, body);
    expect(r.cachedInputTokens).toBe(50);
    expect(r.tokensInput - r.cachedInputTokens).toBe(0);
  });

  it("defaults token counts to 0 when usage is absent", () => {
    const r = mapVendorResponse("deepseek", MODEL, okBody({ usage: undefined }));
    expect(r.tokensInput).toBe(0);
    expect(r.tokensOutput).toBe(0);
    expect(r.cachedInputTokens).toBe(0);
  });

  it("throws on an in-band error payload instead of returning content", () => {
    expect(() =>
      mapVendorResponse("deepseek", MODEL, { error: { message: "insufficient balance" } }),
    ).toThrow(/insufficient balance/);
  });

  it("throws on an empty completion rather than returning an empty string", () => {
    expect(() => mapVendorResponse("deepseek", MODEL, okBody({ choices: [] }))).toThrow(
      VendorProviderError,
    );
    expect(() =>
      mapVendorResponse("deepseek", MODEL, okBody({ choices: [{ message: { content: "" } }] })),
    ).toThrow(/Empty response/);
  });

  it("throws when the served model differs from the requested one", () => {
    expect(() => mapVendorResponse("deepseek", MODEL, okBody({ model: "glm-4.7" }))).toThrow(
      /Model mismatch/,
    );
  });
});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

describe("completeWithVendor", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  const endpoints: Array<[VendorId, string, string]> = [
    ["deepseek", "deepseek-v4-flash", "https://api.deepseek.com/v1/chat/completions"],
    ["zai", "glm-5.2", "https://api.z.ai/api/paas/v4/chat/completions"],
    ["moonshot", "kimi-k3", "https://api.moonshot.ai/v1/chat/completions"],
  ];

  for (const [vendor, model, url] of endpoints) {
    it(`POSTs ${vendor} at ${url} with bearer auth`, async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => okBody({ model }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await completeWithVendor({ vendor, apiKey: "secret-key", model, message: "m" });

      const [calledUrl, init] = fetchMock.mock.calls[0];
      expect(calledUrl).toBe(url);
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer secret-key");
      expect(init.headers["Content-Type"]).toBe("application/json");
    });
  }

  it("throws on a non-2xx response, naming the vendor", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "upstream boom",
    }) as unknown as typeof fetch;

    await expect(
      completeWithVendor({ vendor: "moonshot", apiKey: "k", model: "kimi-k3", message: "m" }),
    ).rejects.toThrow(/\[vendor:moonshot\] 500/);
  });

  it("does NOT retry a completed HTTP response — it may already have been billed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "upstream boom",
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      completeWithVendor({ vendor: "deepseek", apiKey: "k", model: MODEL, message: "m" }),
    ).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT fall back to another vendor when one is down", async () => {
    // A vendor being down must fail loud. Substituting a model would hand the
    // caller an answer it did not ask for and bill it under the wrong name.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "service unavailable",
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      completeWithVendor({ vendor: "zai", apiKey: "k", model: "glm-5.2", message: "m" }),
    ).rejects.toThrow(/503/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.z.ai/api/paas/v4/chat/completions");
  });

  it("retries a connect-phase failure, which never reached the server", async () => {
    const connErr = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(connErr)
      .mockResolvedValue({ ok: true, status: 200, json: async () => okBody() });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const r = await completeWithVendor({ vendor: "deepseek", apiKey: "k", model: MODEL, message: "m" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.content).toBe('{"ok":true}');
  });

  it("gives up after exhausting connect retries", async () => {
    const connErr = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
    });
    const fetchMock = vi.fn().mockRejectedValue(connErr);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      completeWithVendor({ vendor: "deepseek", apiKey: "k", model: MODEL, message: "m" }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  // -------------------------------------------------------------------------
  // A refused request SHAPE is a configuration error, not a transient one.
  // -------------------------------------------------------------------------

  it("classifies a vendor 400 as an unsupported-option error, not a transient failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        '{"error":{"message":"This response_format type is unavailable now","type":"invalid_request_error"}}',
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const err = await completeWithVendor({
      vendor: "deepseek",
      apiKey: "k",
      model: "deepseek-v4-pro",
      message: "m",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VendorUnsupportedOptionError);
    expect(err).toBeInstanceOf(VendorProviderError);
    expect((err as VendorUnsupportedOptionError).status).toBe(400);
    expect((err as Error).message).toMatch(/retrying will not help/);
    expect((err as Error).message).toMatch(/This response_format type is unavailable now/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a transient refusal a plain provider error", async () => {
    for (const status of [500, 503]) {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status,
        text: async () => "later",
      }) as unknown as typeof fetch;

      const err = await completeWithVendor({
        vendor: "zai",
        apiKey: "k",
        model: "glm-5.2",
        message: "m",
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(VendorProviderError);
      expect(err).not.toBeInstanceOf(VendorUnsupportedOptionError);
    }
  });

  it("leaves an empty balance (402) a transient-shaped provider error, not a config error", async () => {
    // Out-of-credit is account state, not request shape: it clears when the
    // balance is topped up, so it must not be reported as a bad request.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      text: async () => "Insufficient Balance",
    }) as unknown as typeof fetch;

    const err = await completeWithVendor({
      vendor: "deepseek",
      apiKey: "k",
      model: MODEL,
      message: "m",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VendorProviderError);
    expect(err).not.toBeInstanceOf(VendorUnsupportedOptionError);
  });

  it("does not retry a non-transient thrown error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("bad input"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      completeWithVendor({ vendor: "deepseek", apiKey: "k", model: MODEL, message: "m" }),
    ).rejects.toThrow(/bad input/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Missing-key errors — the keys are provisioned per vendor, so name the vendor
// ---------------------------------------------------------------------------

describe("keyResolutionErrorMessage", () => {
  it("names the vendor and the slug the key must live under", () => {
    expect(keyResolutionErrorMessage("zai", "org")).toMatch(/Z\.ai API key \(key-service provider "zai"\)/);
    expect(keyResolutionErrorMessage("moonshot", "platform")).toMatch(
      /Moonshot \(Kimi\) API key \(key-service provider "moonshot"\)/,
    );
    expect(keyResolutionErrorMessage("deepseek", "org")).toMatch(
      /DeepSeek API key \(key-service provider "deepseek"\)/,
    );
  });

  it("never reports one vendor's key as another's", () => {
    for (const id of VENDOR_IDS) {
      const message = keyResolutionErrorMessage(id, "platform");
      for (const other of VENDOR_IDS.filter((v) => v !== id)) {
        expect(message).not.toContain(`"${other}"`);
      }
    }
  });

  it("still says something useful for a native provider", () => {
    expect(keyResolutionErrorMessage("anthropic", "org")).toMatch(/Failed to resolve anthropic API key/);
  });
});

// ---------------------------------------------------------------------------
// Refusal classification
// ---------------------------------------------------------------------------

describe("isUnsupportedOptionRefusal", () => {
  it("treats a rejected request shape as unsupported", () => {
    expect(isUnsupportedOptionRefusal(400)).toBe(true);
    expect(isUnsupportedOptionRefusal(422)).toBe(true);
  });

  it("treats auth, credit, rate limits and outages as retryable/account state", () => {
    for (const status of [401, 402, 403, 404, 429, 500, 502, 503, 529]) {
      expect(isUnsupportedOptionRefusal(status)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Rate limits — a 429 is transitory and must not throw the run away
//
// The two refusal classes pull in opposite directions and the tests below are
// the guard that keeps them apart: a 400 on an option the vendor does not
// implement is permanent and must fail on the FIRST call; a 429 clears on its
// own and must be replayed. Getting either backwards costs real money — the
// first burned 335 calls over five hours looking like flakiness, the second
// killed about half of one night's runs after they had already paid for their
// upstream enrichment.
// ---------------------------------------------------------------------------

describe("rate-limit retry", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  /** Start the call, let every backoff timer fire, then settle. */
  async function drive<T>(promise: Promise<T>): Promise<T | unknown> {
    const settled = promise.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    return settled;
  }

  const rateLimited = (body = '{"error":{"code":"1302","message":"Rate limit reached for requests"}}') => ({
    ok: false,
    status: 429,
    text: async () => body,
    headers: new Headers(),
  });

  it("retries a 429 and returns the completion the run had already paid for", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValue({ ok: true, status: 200, json: async () => okBody({ model: "glm-5.2" }) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await drive(
      completeWithVendor({ vendor: "zai", apiKey: "k", model: "glm-5.2", message: "m" }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((result as { content: string }).content).toBe('{"ok":true}');
  });

  it("gives up within a bound and stays loud about the saturation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(rateLimited());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const err = await drive(
      completeWithVendor({ vendor: "zai", apiKey: "k", model: "glm-5.2", message: "m" }),
    );

    // Bounded: the initial attempt plus the four-step backoff, never an
    // unbounded wait on a vendor that is simply over capacity.
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(err).toBeInstanceOf(VendorRateLimitError);
    expect(err).toBeInstanceOf(VendorProviderError);
    expect((err as VendorRateLimitError).attempts).toBe(5);
    expect((err as VendorRateLimitError).waitedMs).toBeGreaterThan(0);
    // Names the capacity, so "we asked for more parallelism than we bought" is
    // readable straight off the error rather than inferred.
    expect((err as Error).message).toMatch(/rate limiting "glm-5\.2"/);
    expect((err as Error).message).toMatch(/published concurrency: 10/);
  });

  it("does NOT retry a 400 on an option the vendor does not implement", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"This response_format type is unavailable now"}}',
      headers: new Headers(),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const err = await drive(
      completeWithVendor({ vendor: "deepseek", apiKey: "k", model: "deepseek-v4-pro", message: "m" }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(VendorUnsupportedOptionError);
    expect(err).not.toBeInstanceOf(VendorRateLimitError);
  });

  it("does NOT retry an out-of-credit 429 — an empty balance does not clear by waiting", async () => {
    // Z.ai reports an empty balance with the SAME status as a rate limit and
    // separates them in the body (1113 vs 1302). Retrying 1113 would burn the
    // budget on a certainty and delay the error the owner has to act on.
    const fetchMock = vi.fn().mockResolvedValue(
      rateLimited('{"error":{"code":"1113","message":"Insufficient balance or no resource package."}}'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const err = await drive(
      completeWithVendor({ vendor: "zai", apiKey: "k", model: "glm-5.2", message: "m" }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(VendorProviderError);
    expect(err).not.toBeInstanceOf(VendorRateLimitError);
  });

  it("does NOT retry a 5xx — that response may already have been billed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
      headers: new Headers(),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const err = await drive(
      completeWithVendor({ vendor: "moonshot", apiKey: "k", model: "kimi-k3", message: "m" }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(err).not.toBeInstanceOf(VendorRateLimitError);
  });

  it("never answers a rate limit from a different model or vendor", async () => {
    const fetchMock = vi.fn().mockResolvedValue(rateLimited());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await drive(completeWithVendor({ vendor: "zai", apiKey: "k", model: "glm-5.2", message: "m" }));

    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe("https://api.z.ai/api/paas/v4/chat/completions");
      expect(JSON.parse(init.body).model).toBe("glm-5.2");
    }
  });

  it("honours a short Retry-After and ignores an absurd one", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs("0.5")).toBe(500);
    // Beyond the bound: discarded, so the caller falls back to the bounded step
    // rather than holding the request open for minutes.
    expect(parseRetryAfterMs("600")).toBeNull();
    expect(parseRetryAfterMs("nonsense")).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("0")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Concurrency is recorded next to the price, because price alone hid a 10x cut
// ---------------------------------------------------------------------------

describe("published vendor concurrency", () => {
  it("every vendor records how much parallelism it sells", () => {
    for (const id of VENDOR_IDS) {
      const { concurrency } = VENDORS[id];
      expect(concurrency.source).toMatch(/^http/);
      expect(concurrency.observedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (concurrency.scope === "per-model") {
        expect(Object.keys(concurrency.limits).length).toBeGreaterThan(0);
      } else {
        expect(Object.keys(concurrency.tierLimits).length).toBeGreaterThan(0);
      }
    }
  });

  it("reads a per-model limit and refuses to invent one it was never given", () => {
    expect(publishedConcurrency("zai", "glm-5.2")).toBe(10);
    expect(publishedConcurrency("zai", "glm-5.3")).toBe(15);
    expect(publishedConcurrency("zai", "glm-5.3-flash")).toBe(50);
    expect(publishedConcurrency("deepseek", "deepseek-v4-pro")).toBe(500);
    // glm-4.7-flashx has no published row. Null is the honest answer — reading
    // it off the sibling glm-4.7 would be a number the vendor never gave us.
    expect(publishedConcurrency("zai", "glm-4.7-flashx")).toBeNull();
    // Moonshot's limit belongs to the ACCOUNT tier, not the model.
    expect(publishedConcurrency("moonshot", "kimi-k3")).toBeNull();
  });

  it("no production alias resolves to a single-in-flight-slot model", () => {
    // The regression guard for 2026-08-20: glm-pro was pointed at GLM-5.3 on an
    // identical list price, which serves ONE concurrent request against
    // GLM-5.2's ten. Three campaigns then contended for that one slot. A future
    // swap onto a one-slot model fails here instead of in production.
    for (const { provider, alias, modelId } of ALIASES) {
      const limit = publishedConcurrency(provider as VendorId, modelId);
      if (limit == null) continue; // vendor publishes nothing for this model
      expect(
        limit,
        `alias "${alias}" resolves to ${modelId}, published at ${limit} concurrent request(s)`,
      ).toBeGreaterThan(1);
    }
  });

  it("keeps glm-pro on the flagship that serves our parallelism", () => {
    // The number this pins moved twice: 5.3 served ONE slot on 2026-08-25
    // (which is why the alias sat on 5.2) and fifteen on 2026-08-31. The
    // assertion is on the CONCURRENCY, not on the model id, because the id is
    // whichever flagship currently clears the bar.
    const resolved = resolveModel("zai", "glm-pro");
    expect(resolved.apiModelId).toBe("glm-5.3");
    expect(publishedConcurrency("zai", resolved.apiModelId)).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Reasoning — we pay for every token of it as output, and nobody reads it
//
// Measured in production 2026-08-25: the same cold-email campaign at the same
// $24 daily budget spent 316 output tokens per generation on Gemini and 9,633
// on GLM. Thirty times the output for the same three emails, all of it the
// model narrating its way to an answer the caller parses and discards. Probed
// live the same day, `thinking: {type:"disabled"}` took GLM-5.2 from 703 to 389
// output tokens and Kimi K2.6 from 1,173 to 452 — with the answers intact
// (1,955 → 1,565 chars and 1,140 → 1,866 chars respectively).
// ---------------------------------------------------------------------------

describe("vendor reasoning capability", () => {
  it("every vendor declares whether reasoning can be turned off", () => {
    // A fourth vendor fails here until it says. Silence would read as "no
    // control exists" and quietly keep paying for reasoning.
    for (const id of VENDOR_IDS) {
      const { reasoning } = VENDORS[id];
      if (reasoning.kind === "disablable") {
        expect(Object.keys(reasoning.requestFields).length).toBeGreaterThan(0);
        expect(reasoning.source).toMatch(/^http/);
        expect(reasoning.evidence).toMatch(/\d{4}-\d{2}-\d{2}/);
      } else {
        expect(reasoning.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it("sends each vendor its OWN field, never another vendor's name", () => {
    // DeepSeek and Z.ai both answer 200 to an unknown top-level key and keep
    // reasoning running, so a wrong name buys nothing and looks like success.
    for (const id of VENDOR_IDS) {
      const { reasoning } = VENDORS[id];
      if (reasoning.kind !== "disablable") continue;
      const body = buildVendorRequestBody({
        vendor: id,
        apiKey: "k",
        model: "m",
        message: "m",
        responseFormat: "json",
      });
      for (const [field, value] of Object.entries(reasoning.requestFields)) {
        expect(body[field]).toEqual(value);
      }
    }
  });
});

describe("shouldDisableVendorReasoning", () => {
  const base = { vendor: "zai" as VendorId, apiKey: "k", model: "glm-5.2", message: "m" };

  it("defaults to OFF for a structured request — the caller parses the object and never sees the reasoning", () => {
    expect(shouldDisableVendorReasoning({ ...base, responseSchema: { type: "object" } })).toBe(true);
    expect(shouldDisableVendorReasoning({ ...base, responseFormat: "json" })).toBe(true);
  });

  it("leaves free-text requests provider-normal — no measurement says that reasoning is safe to take away", () => {
    expect(shouldDisableVendorReasoning(base)).toBe(false);
    expect(shouldDisableVendorReasoning({ ...base, responseFormat: "text" })).toBe(false);
  });

  it("lets the caller override in BOTH directions", () => {
    expect(
      shouldDisableVendorReasoning({ ...base, responseSchema: { type: "object" }, disableThinking: false }),
    ).toBe(false);
    expect(shouldDisableVendorReasoning({ ...base, disableThinking: true })).toBe(true);
  });
});

describe("buildVendorRequestBody — reasoning", () => {
  const schema = { type: "object", properties: { a: { type: "string" } } };

  it("turns reasoning off on a structured request", () => {
    const body = buildVendorRequestBody({
      vendor: "zai",
      apiKey: "k",
      model: "glm-5.2",
      message: "m",
      responseSchema: schema,
    });
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("turns reasoning off on a json-mode request with no schema", () => {
    const body = buildVendorRequestBody({
      vendor: "moonshot",
      apiKey: "k",
      model: "kimi-k2.6",
      message: "m",
      responseFormat: "json",
    });
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("leaves a free-text request untouched", () => {
    const body = buildVendorRequestBody({
      vendor: "deepseek",
      apiKey: "k",
      model: MODEL,
      message: "m",
    });
    expect(body.thinking).toBeUndefined();
  });

  it("keeps reasoning ON when the caller explicitly asks for it on a structured request", () => {
    const body = buildVendorRequestBody({
      vendor: "zai",
      apiKey: "k",
      model: "glm-5.2",
      message: "m",
      responseSchema: schema,
      disableThinking: false,
    });
    expect(body.thinking).toBeUndefined();
  });

  it("turns reasoning off on a free-text request when the caller asks", () => {
    const body = buildVendorRequestBody({
      vendor: "deepseek",
      apiKey: "k",
      model: MODEL,
      message: "m",
      disableThinking: true,
    });
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("sends the GLM-5.3 family its OWN field name, not the vendor default", () => {
    // The vendor changed the spelling mid-generation: 5.2 takes `thinking`,
    // the 5.3 family hard-400s it (code 1210) and takes `reasoning_effort`.
    // Sending the default here is not a degraded request, it is zero
    // completions — which is exactly how the DeepSeek json_schema incident
    // looked for five hours.
    for (const model of ["glm-5.3", "glm-5.3-flash"]) {
      const body = buildVendorRequestBody({
        vendor: "zai",
        apiKey: "k",
        model,
        message: "m",
        responseSchema: schema,
      });
      expect(body.reasoning_effort).toBe("low");
      // Both together would hand the model the field it refuses alongside the
      // one it accepts, and the refusal is a 400 for the whole request.
      expect(body.thinking).toBeUndefined();
    }
  });

  it("leaves the models that take the vendor default untouched by perModel", () => {
    const body = buildVendorRequestBody({
      vendor: "zai",
      apiKey: "k",
      model: "glm-4.7-flashx",
      message: "m",
      responseSchema: schema,
    });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("adds nothing to a free-text request on a perModel model", () => {
    const body = buildVendorRequestBody({
      vendor: "zai",
      apiKey: "k",
      model: "glm-5.3",
      message: "m",
    });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });

  it("never sends a production alias a reasoning field its model is recorded as refusing", () => {
    // The 2026-08-25 regression in one assertion: glm-pro pointed at a model
    // that refused the field it was being sent, so every structured call 400'd.
    // An alias whose model refuses its own field is a broken alias, and the
    // refusal must be visible here rather than in prod.
    for (const { provider, alias, modelId } of ALIASES) {
      const { reasoning } = VENDORS[provider as VendorId];
      if (reasoning.kind !== "disablable") continue;
      const fields = vendorReasoningFields(reasoning, modelId);
      expect(Object.keys(fields).length).toBeGreaterThan(0);
      expect(
        reasoning.refusedBy[modelId],
        `alias ${alias} resolves to ${modelId}, which REFUSES the field it is sent`,
      ).toBeUndefined();
    }
  });

  it("does not carry a routing or fallback knob alongside it", () => {
    const body = buildVendorRequestBody({
      vendor: "zai",
      apiKey: "k",
      model: "glm-5.2",
      message: "m",
      responseSchema: schema,
    });
    expect(body.models).toBeUndefined();
    expect(body.sort).toBeUndefined();
    expect(body.provider).toBeUndefined();
  });
});

describe("a vendor refusing to disable reasoning", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fails loud with the vendor's own words on a refused request shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"thinking is not supported for this model","code":"1210"}}',
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const call = completeWithVendor({
      vendor: "zai",
      apiKey: "k",
      model: "glm-5.3",
      message: "m",
      responseSchema: { type: "object" },
    });

    await expect(call).rejects.toThrow(VendorUnsupportedOptionError);
    await expect(call).rejects.toThrow(/thinking is not supported for this model/);
    // Permanent: refused on the FIRST call, never replayed (the assertions
    // above await the one promise, so one fetch).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("names the refused option when the model is recorded as refusing EVERY spelling", async () => {
    // `refusedBy` is empty today and that is the point of `perModel`: GLM-5.3
    // used to sit in it, and the fix was to learn the field name it DOES take
    // rather than to keep failing loudly. What stays behind it is the case
    // perModel cannot answer — a model with no working spelling at all — so the
    // note is exercised against an injected entry rather than deleted with the
    // last real one.
    const zai = VENDORS.zai.reasoning;
    if (zai.kind !== "disablable") throw new Error("zai must be disablable");
    zai.refusedBy["glm-fictional-always-thinks"] = "Z.ai 400 code 1210 — always engages in thinking.";
    try {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => "always engages in thinking",
      }) as unknown as typeof fetch;

      await expect(
        completeWithVendor({
          vendor: "zai",
          apiKey: "k",
          model: "glm-fictional-always-thinks",
          message: "m",
          responseSchema: { type: "object" },
        }),
      ).rejects.toThrow(/asked Z\.ai to disable reasoning/);
    } finally {
      delete zai.refusedBy["glm-fictional-always-thinks"];
    }
  });

  it("does not blame the reasoning option for an unrelated 400", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "messages: field required",
    }) as unknown as typeof fetch;

    await expect(
      completeWithVendor({ vendor: "zai", apiKey: "k", model: "glm-5.2", message: "m", responseSchema: {} }),
    ).rejects.toThrow(/messages: field required/);
    await expect(
      completeWithVendor({ vendor: "zai", apiKey: "k", model: "glm-5.2", message: "m", responseSchema: {} }),
    ).rejects.not.toThrow(/disable reasoning/);
  });
});
