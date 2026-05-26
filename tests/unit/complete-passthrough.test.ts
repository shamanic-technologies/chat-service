import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression: chat-service must forward the caller's `systemPrompt` byte-equal
// to the provider for /complete and /internal/platform-complete. No injection
// (no Campaign Context block, no JSON suffix, nothing). JSON mode is enforced
// only via native provider metadata (`output_config` on Anthropic,
// `responseMimeType` / `responseSchema` on Gemini).

let capturedAnthropicParams: Record<string, unknown> | undefined;

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      create: () => {
        throw new Error("create not implemented in mock");
      },
      stream: (params: Record<string, unknown>) => {
        capturedAnthropicParams = params;
        return {
          finalMessage: async () => ({
            content: [{ type: "text", text: '{"ok":true}' }],
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: "end_turn",
          }),
        };
      },
    };
  },
}));

const { createAnthropicClient } = await import("../../src/lib/anthropic.js");
const { completeWithGemini } = await import("../../src/lib/gemini.js");

const CALLER_PROMPT = "You are a precise assistant. Reply concisely.";

describe("Anthropic complete() — caller systemPrompt is forwarded byte-equal", () => {
  beforeEach(() => {
    capturedAnthropicParams = undefined;
  });

  it("forwards systemPrompt unchanged for non-JSON requests", async () => {
    const claude = createAnthropicClient({ apiKey: "k", systemPrompt: CALLER_PROMPT });
    await claude.complete("hi");
    expect(capturedAnthropicParams!.system).toBe(CALLER_PROMPT);
  });

  it("forwards systemPrompt unchanged when responseFormat is json", async () => {
    const claude = createAnthropicClient({ apiKey: "k", systemPrompt: CALLER_PROMPT });
    await claude.complete("hi", { responseFormat: "json" });
    expect(capturedAnthropicParams!.system).toBe(CALLER_PROMPT);
  });

  it("forwards systemPrompt unchanged when responseSchema is supplied", async () => {
    const claude = createAnthropicClient({ apiKey: "k", systemPrompt: CALLER_PROMPT });
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    };
    await claude.complete("hi", { responseFormat: "json", responseSchema: schema });
    expect(capturedAnthropicParams!.system).toBe(CALLER_PROMPT);
  });

  it("does NOT append a JSON suffix to systemPrompt", async () => {
    const claude = createAnthropicClient({ apiKey: "k", systemPrompt: CALLER_PROMPT });
    await claude.complete("hi", { responseFormat: "json" });
    const sys = capturedAnthropicParams!.system as string;
    expect(sys).not.toContain("IMPORTANT: You MUST respond with valid JSON");
    expect(sys).not.toContain("Never wrap the result in an array");
    expect(sys).not.toContain("single JSON object");
  });

  it("does NOT inject a Campaign Context block", async () => {
    const claude = createAnthropicClient({ apiKey: "k", systemPrompt: CALLER_PROMPT });
    await claude.complete("hi", { responseFormat: "json" });
    const sys = capturedAnthropicParams!.system as string;
    expect(sys).not.toContain("## Campaign Context");
    expect(sys).not.toContain("Additional Context");
  });
});

describe("Gemini completeWithGemini() — caller systemPrompt is forwarded byte-equal", () => {
  let capturedFetchBody: Record<string, unknown> | undefined;

  beforeEach(() => {
    capturedFetchBody = undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedFetchBody = JSON.parse(init?.body as string);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
            modelVersion: "gemini-3.1-flash-lite",
          }),
          headers: new Headers(),
        } as unknown as Response;
      }),
    );
  });

  it("forwards systemPrompt unchanged for jsonMode requests", async () => {
    await completeWithGemini({
      apiKey: "k",
      model: "gemini-3.1-flash-lite",
      message: "hi",
      systemPrompt: CALLER_PROMPT,
      responseFormat: "json",
    });
    const sys = (capturedFetchBody!.systemInstruction as Record<string, unknown>).parts as Array<{ text: string }>;
    expect(sys[0].text).toBe(CALLER_PROMPT);
  });

  it("forwards systemPrompt unchanged when responseSchema is supplied", async () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    await completeWithGemini({
      apiKey: "k",
      model: "gemini-3.1-flash-lite",
      message: "hi",
      systemPrompt: CALLER_PROMPT,
      responseFormat: "json",
      responseSchema: schema,
    });
    const sys = (capturedFetchBody!.systemInstruction as Record<string, unknown>).parts as Array<{ text: string }>;
    expect(sys[0].text).toBe(CALLER_PROMPT);
  });
});
