import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { completeWithGemini, GeminiUnsupportedOptionError } from "../../src/lib/gemini.js";

describe("completeWithGemini", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const baseOptions = {
    apiKey: "test-key",
    model: "gemini-3-flash-preview",
    message: "Return URLs as JSON",
    systemPrompt: "You are helpful.",
    responseFormat: "json" as const,
  };

  const okResponse = (text = '["https://example.com"]', tokensIn = 100, tokensOut = 50) => ({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: tokensIn, candidatesTokenCount: tokensOut },
    }),
  });

  const errorResponse = (status: number, body = "overloaded") => ({
    ok: false,
    status,
    text: async () => body,
  });

  /** Run completeWithGemini and advance fake timers until it resolves. */
  async function runWithTimers(opts: Parameters<typeof completeWithGemini>[0]) {
    const promise = completeWithGemini(opts);
    // Prevent unhandled rejection warnings — caller will handle via .rejects
    promise.catch(() => {});
    await vi.runAllTimersAsync();
    return promise;
  }

  // Regression — incident 2026-06-04: Gemini truncated JSON on MAX_TOKENS, and
  // the downstream strict JSON.parse in /complete threw a cryptic
  // "Unterminated string" 502. JSON mode must fail loud HERE with a clear cause.
  it("throws on MAX_TOKENS in JSON mode (output truncated, fail loud)", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: { parts: [{ text: '["https://example.com", "https://truncat' }] },
            finishReason: "MAX_TOKENS",
          },
        ],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 500 },
      }),
    });

    await expect(runWithTimers(baseOptions)).rejects.toThrow(/Output truncated \(MAX_TOKENS\)/);
  });

  it("returns partial content when finishReason is MAX_TOKENS in non-JSON mode", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: { parts: [{ text: "Here are the top outlets for your campaign: 1. TechCrun" }] },
            finishReason: "MAX_TOKENS",
          },
        ],
        usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 1000 },
      }),
    });

    const result = await runWithTimers({ ...baseOptions, responseFormat: undefined });
    expect(result.content).toBe("Here are the top outlets for your campaign: 1. TechCrun");
    expect(result.tokensInput).toBe(200);
    expect(result.tokensOutput).toBe(1000);
  });

  it("returns content when finishReason is STOP (normal completion)", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse());

    const result = await runWithTimers(baseOptions);
    expect(result.content).toBe('["https://example.com"]');
    expect(result.tokensInput).toBe(100);
    expect(result.tokensOutput).toBe(50);
  });

  it("sends maxOutputTokens 64000 by default (parity with authorized hold + Anthropic)", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers(baseOptions);
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.maxOutputTokens).toBe(64000);
  });

  it("honors a caller-supplied maxOutputTokens cap", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers({ ...baseOptions, maxOutputTokens: 2048 });
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.maxOutputTokens).toBe(2048);
  });

  // Regression — incident 2026-06-24 (#316): /complete must send a bounded
  // thinkingConfig for Gemini 3. The default stays normal provider behavior
  // (low), while disableThinking is the explicit opt-in for provider-flooring.
  it("sends normal bounded thinkingLevel low for a Gemini 3 Flash model by default", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers({ ...baseOptions, model: "gemini-3.5-flash" });
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("sends normal bounded thinkingLevel low for a Gemini 3 Pro model by default", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers({ ...baseOptions, model: "gemini-3.1-pro-preview" });
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("sends thinkingBudget 8192 for a Gemini 2.5 model by default (not floored)", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers({ ...baseOptions, model: "gemini-2.5-flash" });
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 8192 });
  });

  // disableThinking — provider-floored "minimize thinking" option (POST /complete).
  // Gemini 3 has NO full-off, so it drops to the lowest level the gen allows;
  // Gemini 2.5 alone goes fully off (thinkingBudget: 0).
  it("disableThinking → Gemini 3 Flash floors at thinkingLevel minimal", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers({ ...baseOptions, model: "gemini-3.5-flash", disableThinking: true });
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
  });

  it("disableThinking → Gemini 3 Pro floors at thinkingLevel low (no minimal on Pro)", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers({ ...baseOptions, model: "gemini-3.1-pro-preview", disableThinking: true });
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  // Regression — incident 2026-08-14→24: the `flash-pro` alias moved to
  // gemini-3.7-flash, which REJECTS "minimal"
  // (400 INVALID_ARGUMENT "Thinking level MINIMAL is not supported for this
  // model"). The floor is per MODEL, not per generation + a "pro" substring.
  it("disableThinking → gemini-3.7-flash floors at low, never minimal", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers({ ...baseOptions, model: "gemini-3.7-flash", disableThinking: true });
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  // Same shape one model later: gemini-3.8-flash is the current flash-pro alias
  // and also rejects "minimal" — checked BEFORE the swap this time.
  it("disableThinking → gemini-3.8-flash (flash-pro alias) floors at low, never minimal", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers({ ...baseOptions, model: "gemini-3.8-flash", disableThinking: true });
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("disableThinking → gemini-3.1-flash-lite floors at minimal (accepted by that model)", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers({ ...baseOptions, model: "gemini-3.1-flash-lite", disableThinking: true });
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
  });

  it("disableThinking → gemini-3.5-flash-lite (flash alias) floors at minimal", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers({ ...baseOptions, model: "gemini-3.5-flash-lite", disableThinking: true });
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
  });

  it("disableThinking → Gemini 2.5 fully off (thinkingBudget 0)", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers({ ...baseOptions, model: "gemini-2.5-flash", disableThinking: true });
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it("disableThinking omitted → Gemini 3 Flash keeps the normal bounded default", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers({ ...baseOptions, model: "gemini-3.5-flash" });
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  // thinkingLevel — optional per-call Gemini-3 level (POST /complete +
  // /internal/platform-complete). Graduated levels the /chat config path already
  // supports, now selectable per request. Precedence: disableThinking wins →
  // floor; else the level; else the "low" default. No-op on Gemini 2.5.
  it("thinkingLevel honored on Gemini 3 Flash (medium)", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers({ ...baseOptions, model: "gemini-3.5-flash", thinkingLevel: "medium" });
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "medium" });
  });

  it("thinkingLevel honored on Gemini 3 Flash (low — below default cost, above floor)", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers({ ...baseOptions, model: "gemini-3.5-flash", thinkingLevel: "low" });
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("thinkingLevel honored on Gemini 3 Pro (high)", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers({ ...baseOptions, model: "gemini-3.1-pro-preview", thinkingLevel: "high" });
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "high" });
  });

  it("disableThinking wins over thinkingLevel (floor, not the requested level)", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers({
      ...baseOptions,
      model: "gemini-3.5-flash",
      disableThinking: true,
      thinkingLevel: "high",
    });
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    // Floor (minimal on Flash), NOT the requested "high".
    expect(requestBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
  });

  it("thinkingLevel omitted → Gemini 3 default stays low (existing callers unchanged)", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers({ ...baseOptions, model: "gemini-3.5-flash" });
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("thinkingLevel is a safe no-op on Gemini 2.5 (uses its bounded budget)", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers({ ...baseOptions, model: "gemini-2.5-flash", thinkingLevel: "high" });
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 8192 });
  });

  // --- responseSchema rides Google's JSON Schema field (SCHEMA-ANY-VENDOR-1116) ---

  it("sends the caller's schema as generationConfig.responseJsonSchema, never the OpenAPI responseSchema", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    const schema = {
      type: "object",
      properties: { urls: { type: "array", items: { type: "string" } } },
      required: ["urls"],
      additionalProperties: false,
    };
    await runWithTimers({ ...baseOptions, responseSchema: schema });
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.responseJsonSchema).toEqual(schema);
    expect(requestBody.generationConfig.responseSchema).toBeUndefined();
    expect(requestBody.generationConfig.responseMimeType).toBe("application/json");
  });

  it("accepts an enum holding the empty string and serves the answer unchanged (prod 2026-11-16, lead answerer)", async () => {
    // Google's OpenAPI responseSchema answered 400 `properties[replyTo].enum[2]: cannot be empty` to this
    // valid JSON Schema; its JSON Schema field takes it (probed live 2026-11-16).
    const answer = JSON.stringify({ decision: "now", replyTo: "", message: "Hi" });
    fetchSpy.mockResolvedValueOnce(okResponse(answer));
    const schema = {
      type: "object",
      properties: {
        decision: { type: "string", enum: ["now", "later", "nothing"] },
        replyTo: { type: "string", enum: ["thread-a", "thread-b", ""] },
        message: { type: "string" },
      },
      required: ["decision", "replyTo", "message"],
      additionalProperties: false,
    };
    const result = await runWithTimers({ ...baseOptions, responseSchema: schema });
    const sent = JSON.parse(fetchSpy.mock.calls[0][1].body).generationConfig.responseJsonSchema;
    expect(sent.properties.replyTo.enum).toEqual(["thread-a", "thread-b", ""]);
    expect(result.content).toBe(answer);
    expect(JSON.parse(result.content).replyTo).toBe("");
  });

  it("omits both schema fields when the caller does not supply one", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers(baseOptions);
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.responseSchema).toBeUndefined();
    expect(requestBody.generationConfig.responseJsonSchema).toBeUndefined();
  });

  it("forces responseMimeType: application/json when responseSchema is set even if responseFormat is omitted", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    const schema = { type: "object", properties: { x: { type: "number" } } };
    await runWithTimers({
      ...baseOptions,
      responseFormat: undefined,
      responseSchema: schema,
    });
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.responseMimeType).toBe("application/json");
    expect(requestBody.generationConfig.responseJsonSchema).toEqual(schema);
  });

  it("keeps the keywords the old allow-list dropped ($defs/$ref, const, additionalProperties) and rewrites the tuple form", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $defs: { Foo: { type: "string" } },
      type: "object",
      additionalProperties: false,
      properties: {
        ref: { $ref: "#/$defs/Foo" },
        kind: { type: "string", const: "lead" },
        pair: { type: "array", items: [{ type: "string" }, { type: "number" }] },
      },
    };
    await runWithTimers({ ...baseOptions, responseSchema: schema });
    const sent = JSON.parse(fetchSpy.mock.calls[0][1].body).generationConfig.responseJsonSchema;
    expect(sent.$defs).toEqual({ Foo: { type: "string" } });
    expect(sent.properties.ref.$ref).toBe("#/$defs/Foo");
    expect(sent.properties.kind.const).toBe("lead");
    expect(sent.additionalProperties).toBe(false);
    // Google refuses `items: [...]` ("must be a boolean or an object"): the same tuple as prefixItems.
    expect(sent.properties.pair).toEqual({ type: "array", prefixItems: [{ type: "string" }, { type: "number" }] });
  });

  it("does not mutate the caller-provided schema", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { pair: { type: "array", items: [{ type: "string" }] } },
    };
    const before = JSON.parse(JSON.stringify(schema));
    await runWithTimers({ ...baseOptions, responseSchema: schema });
    expect(schema).toEqual(before);
  });

  // Was "does not send thinkingConfig" — that omission IS the #316 bug: a Gemini 3
  // model with no thinkingConfig defaults to high thinking and burns the output
  // budget before emitting JSON. thinkingConfig must be sent, but the default
  // remains normal bounded thinking (baseOptions.model = gemini-3-flash-preview).
  it("sends a normal bounded thinkingConfig for the Gemini 3 default model on /complete", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers(baseOptions);
    const requestBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(requestBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("passes AbortSignal.timeout to the Gemini fetch call", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse("{}"));
    await runWithTimers(baseOptions);
    const fetchOptions = fetchSpy.mock.calls[0][1];
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it("re-throws non-retryable fetch errors as-is", async () => {
    const networkError = new TypeError("fetch failed");
    fetchSpy.mockRejectedValueOnce(networkError);
    await expect(runWithTimers(baseOptions)).rejects.toThrow("fetch failed");
  });

  it("a 400 shape refusal is a GeminiUnsupportedOptionError carrying Google's message, never retried", async () => {
    const vendorBody = '{"error":{"code":400,"message":"* GenerateContentRequest.generation_config.response_schema.properties[replyTo].enum[2]: cannot be empty","status":"INVALID_ARGUMENT"}}';
    fetchSpy.mockResolvedValueOnce(errorResponse(400, vendorBody));
    const err = await runWithTimers(baseOptions).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GeminiUnsupportedOptionError);
    expect((err as GeminiUnsupportedOptionError).status).toBe(400);
    expect((err as GeminiUnsupportedOptionError).vendorMessage).toContain("enum[2]: cannot be empty");
    expect((err as Error).message).toContain("enum[2]: cannot be empty");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("re-throws other non-retryable HTTP errors (e.g. 403) as-is without retrying", async () => {
    fetchSpy.mockResolvedValueOnce(errorResponse(403, "forbidden"));
    await expect(runWithTimers(baseOptions)).rejects.toThrow("[gemini] API error 403: forbidden");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // --- Retry behavior ---

  it("retries on 503 and succeeds on second attempt", async () => {
    fetchSpy
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(okResponse("ok"));

    const result = await runWithTimers(baseOptions);
    expect(result.content).toBe("ok");
    expect(result.model).toBe("gemini-3-flash-preview");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries on 429 and succeeds on third attempt", async () => {
    fetchSpy
      .mockResolvedValueOnce(errorResponse(429))
      .mockResolvedValueOnce(errorResponse(429))
      .mockResolvedValueOnce(okResponse("ok"));

    const result = await runWithTimers(baseOptions);
    expect(result.content).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("retries on 500 and succeeds", async () => {
    fetchSpy
      .mockResolvedValueOnce(errorResponse(500))
      .mockResolvedValueOnce(okResponse("recovered"));

    const result = await runWithTimers(baseOptions);
    expect(result.content).toBe("recovered");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries on timeout (DOMException TimeoutError) and succeeds", async () => {
    const timeoutError = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    fetchSpy
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce(okResponse("recovered"));

    const result = await runWithTimers(baseOptions);
    expect(result.content).toBe("recovered");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // --- No fallback model: retry-exhausted calls fail loud ---

  it("throws after all retries fail, never calling a different model", async () => {
    fetchSpy
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503, "high demand"));

    await expect(runWithTimers({ ...baseOptions, model: "gemini-3.1-pro-preview" })).rejects.toThrow(
      "[gemini] API error 503: high demand",
    );
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    for (const call of fetchSpy.mock.calls) {
      expect(call[0] as string).toContain("/models/gemini-3.1-pro-preview:");
    }
  });

  it("throws after retries exhausted on timeout too", async () => {
    const timeoutError = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    fetchSpy
      .mockRejectedValueOnce(timeoutError)
      .mockRejectedValueOnce(timeoutError)
      .mockRejectedValueOnce(timeoutError)
      .mockRejectedValueOnce(timeoutError);

    await expect(runWithTimers(baseOptions)).rejects.toThrow(/timed out/);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it("logs a warning for each retry attempt", async () => {
    fetchSpy
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(okResponse("ok"));

    await runWithTimers(baseOptions);

    const warnCalls = (console.warn as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string)
      .filter((msg) => msg.includes("Gemini retry"));
    expect(warnCalls).toHaveLength(2);
    expect(warnCalls[0]).toMatch(/retry 1\/3/);
    expect(warnCalls[1]).toMatch(/retry 2\/3/);
  });
});
