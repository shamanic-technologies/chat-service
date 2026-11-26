/**
 * GLM-FLASH-502-1125: Z.ai held ~1 in 140 `glm-flash` calls open with no answer until
 * undici's 300 s headers cut ("fetch failed" → 502 to the Script). Z.ai calls are now
 * STREAMED and reassembled, a call silent for STREAM_SILENCE_MS is asked again on the
 * SAME model, and the caller still gets one whole answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeWithVendor,
  MAX_HUNG_RETRIES,
  postVendorChatCompletion,
  STREAM_SILENCE_MS,
  VendorHungError,
  VendorProviderError,
  VendorSilentError,
} from "../../src/lib/openai-compatible.js";

const MODEL = "glm-5.3-flash";

function chunk(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: "z1", model: MODEL, object: "chat.completion.chunk", ...obj })}\n\n`;
}

const WHOLE = [
  chunk({ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Think" } }] }),
  chunk({ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "ing." } }] }),
  chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "{\"answer\":" } }] }),
  chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "\"blue\"}" } }] }),
  chunk({
    choices: [{ index: 0, finish_reason: "stop", delta: { role: "assistant", content: "" } }],
    usage: { prompt_tokens: 30, completion_tokens: 61, total_tokens: 91, prompt_tokens_details: { cached_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 20 } },
  }),
  "data: [DONE]\n\n",
];

/** A streamed Response; `stallAfter` = number of parts sent before the stream goes silent forever. */
function sse(parts: string[], opts: { stallAfter?: number; closeEarlyAfter?: number; signal?: AbortSignal } = {}): Response {
  const enc = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.closeEarlyAfter !== undefined && i >= opts.closeEarlyAfter) {
        controller.close();
        return;
      }
      if (opts.stallAfter !== undefined && i >= opts.stallAfter) {
        return new Promise<void>((_, reject) => {
          opts.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      if (i >= parts.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(parts[i++]));
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A fetch that never answers until aborted (the hang seen in prod). */
function hangingFetch(_url: string, init: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
}

describe("Z.ai calls are streamed and a hung call is asked again on the same model", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("asks Z.ai for a stream with usage and hands the caller one whole answer", async () => {
    const fetchMock = vi.fn(async () => sse(WHOLE));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await completeWithVendor({ vendor: "zai", apiKey: "k", model: MODEL, message: "m", responseFormat: "json" });

    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toEqual({ include_usage: true });
    expect(result.content).toBe("{\"answer\":\"blue\"}");
    expect(result.tokensInput).toBe(30);
    expect(result.tokensOutput).toBe(61);
    expect(result.cachedInputTokens).toBe(10);
  });

  it("reassembles tool calls by index for the /chat tool loop", async () => {
    globalThis.fetch = vi.fn(async () => sse([
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ id: "c0", index: 0, type: "function", function: { name: "get_weather", arguments: "{\"city\":" } }] } }] }),
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"Paris\"}" } }] } }] }),
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ id: "c1", index: 1, type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Rome\"}" } }] } }] }),
      chunk({ choices: [{ index: 0, finish_reason: "tool_calls", delta: { content: "" } }], usage: { prompt_tokens: 188, completion_tokens: 23 } }),
      "data: [DONE]\n\n",
    ])) as unknown as typeof fetch;

    const body = await postVendorChatCompletion({ vendor: "zai", apiKey: "k", model: MODEL, body: { model: MODEL, messages: [] }, reasoningDisabled: false });
    expect(body.choices?.[0]?.finish_reason).toBe("tool_calls");
    expect(body.choices?.[0]?.message?.tool_calls).toEqual([
      { id: "c0", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } },
      { id: "c1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Rome\"}" } },
    ]);
    expect(body.usage?.prompt_tokens).toBe(188);
  });

  it("a call that sends nothing is cut after the silence limit and asked again on the SAME model", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockImplementationOnce(hangingFetch)
      .mockImplementationOnce(async () => sse(WHOLE));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = completeWithVendor({ vendor: "zai", apiKey: "k", model: MODEL, message: "m" });
    await vi.advanceTimersByTimeAsync(STREAM_SILENCE_MS + 2_000);
    const result = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(JSON.parse((call as [string, RequestInit])[1].body as string).model).toBe(MODEL);
    }
    expect(result.content).toBe("{\"answer\":\"blue\"}");
  });

  it("a stream that goes silent mid-answer is cut and asked again", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockImplementationOnce(async (_u: string, init: RequestInit) => sse(WHOLE, { stallAfter: 2, signal: init.signal ?? undefined }))
      .mockImplementationOnce(async () => sse(WHOLE));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = completeWithVendor({ vendor: "zai", apiKey: "k", model: MODEL, message: "m" });
    await vi.advanceTimersByTimeAsync(STREAM_SILENCE_MS + 2_000);
    const result = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.tokensOutput).toBe(61);
  });

  it("a stream that closes before its finish chunk is asked again", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => sse(WHOLE, { closeEarlyAfter: 3 }))
      .mockImplementationOnce(async () => sse(WHOLE));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await completeWithVendor({ vendor: "zai", apiKey: "k", model: MODEL, message: "m" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.content).toBe("{\"answer\":\"blue\"}");
  });

  it("fails loud, named, once every attempt hung", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(hangingFetch);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = completeWithVendor({ vendor: "zai", apiKey: "k", model: MODEL, message: "m" }).catch((e) => e);
    await vi.advanceTimersByTimeAsync((STREAM_SILENCE_MS + 2_000) * (MAX_HUNG_RETRIES + 1));
    const err = await pending;
    expect(err).toBeInstanceOf(VendorHungError);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_HUNG_RETRIES + 1);
  });

  it("an in-band error chunk is the vendor's answer: never replayed", async () => {
    const fetchMock = vi.fn(async () => sse([`data: ${JSON.stringify({ error: { code: "1234", message: "boom" } })}\n\n`]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const err = await completeWithVendor({ vendor: "zai", apiKey: "k", model: MODEL, message: "m" }).catch((e) => e);
    expect(err).toBeInstanceOf(VendorProviderError);
    expect(err).not.toBeInstanceOf(VendorHungError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the Copilot's silence limit still counts until the whole answer is in", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => sse(WHOLE, { stallAfter: 1, signal: init.signal ?? undefined }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const pending = postVendorChatCompletion({ vendor: "zai", apiKey: "k", model: MODEL, body: { model: MODEL, messages: [] }, reasoningDisabled: false, silentAfterMs: 30_000 }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await pending).toBeInstanceOf(VendorSilentError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a vendor not marked as streaming is called as before (stream: false)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ model: "deepseek-flash", choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await completeWithVendor({ vendor: "deepseek", apiKey: "k", model: "deepseek-flash", message: "m" });
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.stream).toBe(false);
    expect(sent.stream_options).toBeUndefined();
  });
});

describe("a stream request answered with one JSON body", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("is read as the whole answer, asked once", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      model: MODEL,
      choices: [{ message: { content: "whole" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await completeWithVendor({ vendor: "zai", apiKey: "k", model: MODEL, message: "m" });
    expect(result.content).toBe("whole");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
