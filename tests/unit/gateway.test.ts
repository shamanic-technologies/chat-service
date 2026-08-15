import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildGatewayRequestBody,
  assertModelMatches,
  mapGatewayResponse,
  completeWithGateway,
  GatewayProviderError,
  GATEWAY_PROVIDER,
} from "../../src/lib/gateway.js";
import { resolveModel, PROVIDER_MODELS, costPrefixForModel } from "../../src/lib/anthropic.js";

const MODEL = "deepseek/deepseek-v4-flash";

function okBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "gen_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    model: MODEL,
    choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 45,
      prompt_tokens_details: { cached_tokens: 100 },
    },
    provider_metadata: {
      gateway: { cost: "0.000123", generationId: "gen_x", routing: { finalProvider: "fireworks" } },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Model resolution — one alias = two catalog rows, nothing else reachable
// ---------------------------------------------------------------------------

describe("gateway model resolution", () => {
  it("resolves the deepseek-flash alias to the gateway model id and cost prefix", () => {
    const resolved = resolveModel("vercel", "deepseek-flash");
    expect(resolved.apiModelId).toBe(MODEL);
    expect(resolved.costPrefix).toBe("deepseek-v4-flash");
    expect(resolved.provider).toBe(GATEWAY_PROVIDER);
  });

  it("declares exactly the two catalog names the costs catalog carries", () => {
    const { costPrefix } = resolveModel("vercel", "deepseek-flash");
    expect(`${costPrefix}-tokens-input`).toBe("deepseek-v4-flash-tokens-input");
    expect(`${costPrefix}-tokens-output`).toBe("deepseek-v4-flash-tokens-output");
  });

  it("throws for an alias that is not declared for the gateway provider", () => {
    // The gateway serves hundreds of models; only mapped aliases are reachable,
    // so an undeclared model can never produce an undeclared cost name.
    expect(() => resolveModel("vercel", "pro")).toThrow(/Unknown model/);
    expect(() => resolveModel("vercel", "sonnet")).toThrow(/Unknown model/);
  });

  it("exposes exactly one gateway alias for Zod validation", () => {
    expect(PROVIDER_MODELS.vercel).toEqual(["deepseek-flash"]);
  });

  it("maps the gateway model id back to its cost prefix", () => {
    expect(costPrefixForModel(MODEL)).toBe("deepseek-v4-flash");
  });

  it("leaves the native provider maps untouched", () => {
    expect(resolveModel("google", "flash-pro").costPrefix).toBe("google-flash-3.7");
    expect(resolveModel("anthropic", "sonnet").costPrefix).toBe("anthropic-sonnet-4.6");
  });
});

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

describe("buildGatewayRequestBody", () => {
  it("builds an OpenAI-shaped non-streaming body", () => {
    const body = buildGatewayRequestBody({
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
    const body = buildGatewayRequestBody({ apiKey: "k", model: MODEL, message: "m", systemPrompt });
    const messages = body.messages as Array<{ role: string; content: string }>;
    const system = messages.find((m) => m.role === "system");
    expect(system?.content).toBe(systemPrompt);
  });

  it("omits the system message entirely when no systemPrompt is supplied", () => {
    const body = buildGatewayRequestBody({ apiKey: "k", model: MODEL, message: "m" });
    expect(body.messages).toEqual([{ role: "user", content: "m" }]);
  });

  it("requests structured output natively when a responseSchema is supplied", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    const body = buildGatewayRequestBody({
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
    const body = buildGatewayRequestBody({
      apiKey: "k",
      model: MODEL,
      message: "m",
      responseFormat: "json",
    });
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("carries NO routing knobs — a silent model swap would misname the cost", () => {
    const body = buildGatewayRequestBody({ apiKey: "k", model: MODEL, message: "m" });
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

  it("throws when the gateway served a different model", () => {
    expect(() => assertModelMatches(MODEL, "deepseek/deepseek-v4-pro")).toThrow(
      /Model mismatch/,
    );
  });

  it("tolerates a missing model echo rather than inventing a mismatch", () => {
    expect(() => assertModelMatches(MODEL, undefined)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

describe("mapGatewayResponse", () => {
  it("maps usage onto the shared completion result shape", () => {
    const r = mapGatewayResponse(MODEL, okBody());
    expect(r.content).toBe('{"ok":true}');
    expect(r.tokensInput).toBe(120);
    expect(r.tokensOutput).toBe(45);
    expect(r.model).toBe(MODEL);
    expect(r.searchCount).toBe(0);
    expect(r.sources).toEqual([]);
  });

  it("captures cached input tokens for observability WITHOUT discounting them", () => {
    const r = mapGatewayResponse(MODEL, okBody());
    expect(r.cachedInputTokens).toBe(100);
    // The billed input quantity is the FULL prompt token count. Cache reads are
    // billed at the cache-miss rate (vercel/ai#13907 — the gateway does not
    // apply the cache discount for implicit-caching providers today).
    expect(r.tokensInput).toBe(120);
  });

  it("surfaces the gateway's own cost and the provider that served the call", () => {
    const r = mapGatewayResponse(MODEL, okBody());
    expect(r.gatewayCostUsd).toBe("0.000123");
    expect(r.finalProvider).toBe("fireworks");
  });

  it("defaults token counts to 0 when usage is absent", () => {
    const r = mapGatewayResponse(MODEL, okBody({ usage: undefined }));
    expect(r.tokensInput).toBe(0);
    expect(r.tokensOutput).toBe(0);
    expect(r.cachedInputTokens).toBe(0);
  });

  it("throws on an in-band error payload instead of returning content", () => {
    expect(() =>
      mapGatewayResponse(MODEL, { error: { message: "no providers available" } }),
    ).toThrow(/no providers available/);
  });

  it("throws on an empty completion rather than returning an empty string", () => {
    expect(() => mapGatewayResponse(MODEL, okBody({ choices: [] }))).toThrow(
      GatewayProviderError,
    );
    expect(() =>
      mapGatewayResponse(MODEL, okBody({ choices: [{ message: { content: "" } }] })),
    ).toThrow(/Empty response/);
  });

  it("throws when the served model differs from the requested one", () => {
    expect(() => mapGatewayResponse(MODEL, okBody({ model: "zai/glm-4.7" }))).toThrow(
      /Model mismatch/,
    );
  });
});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

describe("completeWithGateway", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("POSTs to the gateway chat-completions endpoint with bearer auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => okBody(),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const r = await completeWithGateway({ apiKey: "secret-key", model: MODEL, message: "m" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer secret-key");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(r.tokensInput).toBe(120);
  });

  it("throws on a non-2xx response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    }) as unknown as typeof fetch;

    await expect(
      completeWithGateway({ apiKey: "k", model: MODEL, message: "m" }),
    ).rejects.toThrow(/429/);
  });

  it("does NOT retry a completed HTTP response — it may already have been billed", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "upstream boom",
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      completeWithGateway({ apiKey: "k", model: MODEL, message: "m" }),
    ).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

    const r = await completeWithGateway({ apiKey: "k", model: MODEL, message: "m" });

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
      completeWithGateway({ apiKey: "k", model: MODEL, message: "m" }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it("does not retry a non-transient thrown error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("bad input"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      completeWithGateway({ apiKey: "k", model: MODEL, message: "m" }),
    ).rejects.toThrow(/bad input/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
