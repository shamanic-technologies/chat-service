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
  { provider: "zai", alias: "glm-flash", modelId: "glm-4.7-flashx", prefix: "zai-glm-4.7-flashx" },
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
    const body = buildVendorRequestBody({ vendor: "zai", apiKey: "k", model: "glm-5.3", message: "m", systemPrompt });
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
      vendor: "deepseek",
      apiKey: "k",
      model: MODEL,
      message: "m",
      responseSchema: schema,
    });
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "response", schema },
    });
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
    expect(() => assertModelMatches("glm-5.3", "glm-4.7")).toThrow(/Model mismatch/);
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
      model: "glm-5.3",
      usage: { prompt_tokens: 500, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 460 } },
    });
    const r = mapVendorResponse("zai", "glm-5.3", body);
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
    ["zai", "glm-5.3", "https://api.z.ai/api/paas/v4/chat/completions"],
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
      status: 429,
      text: async () => "rate limited",
    }) as unknown as typeof fetch;

    await expect(
      completeWithVendor({ vendor: "moonshot", apiKey: "k", model: "kimi-k3", message: "m" }),
    ).rejects.toThrow(/\[vendor:moonshot\] 429/);
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
      completeWithVendor({ vendor: "zai", apiKey: "k", model: "glm-5.3", message: "m" }),
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
