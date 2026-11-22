import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * DISTRY-THINKING-1122 (owner 2026-11-22): he clicked "Use" on GPT-6.1 Terra at Medium in the
 * Distry models panel; Distry was saved at the model's default, which with tools is reasoning
 * OFF. Every level the panel offers must run as scored, on one path for every provider.
 */
const post = vi.fn();
vi.mock("../../src/lib/openai-compatible.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/openai-compatible.js")>();
  return { ...real, postVendorChatCompletion: (args: unknown) => post(args) };
});

const { streamVendorChat } = await import("../../src/lib/vendor-chat.js");
const { usesResponsesApi, toResponsesRequest, fromResponsesBody, vendorThinkingLevelFields } = await import("../../src/lib/openai-compatible.js");
const { codeDistryDefinition, validateDistryDefinition, thinkingColumns } = await import("../../src/agent/distry-config.js");
const { chatThinkingLevels, thinkingLevelRefusal } = await import("../../src/lib/thinking-levels.js");
const { buildModelPanel } = await import("../../src/lib/intelligence-index.js");

const TOOLS = [{ name: "get_billing_account", description: "Balance", input_schema: { type: "object" as const, properties: {} } }];

function terraTurn(extra: Record<string, unknown>) {
  return streamVendorChat({
    vendor: "openai", apiKey: "k", model: "gpt-6.1-terra", costPrefix: "openai-gpt-6.1-terra", systemPrompt: "SYS",
    turnContext: "", history: [], userMessage: "How much is left?", tools: TOOLS, res: {} as never, sendSSE: () => {},
    executeTool: vi.fn().mockResolvedValue({ name: "get_billing_account", result: { balance: 4.12 } }),
    signal: new AbortController().signal, beforeProviderCall: async () => {}, ...extra,
  });
}

describe("Distry's config takes a thinking level for every provider", () => {
  const code = codeDistryDefinition();
  const check = (provider: string, model: string, effort: string | null) => () =>
    validateDistryDefinition({ ...code, provider: provider as never, model, effort }, []);

  it("accepts each level the model runs with tools", () => {
    expect(check("openai", "gpt-6.1-terra", "medium")).not.toThrow();
    expect(check("openai", "gpt-6.1-terra", "none")).not.toThrow();
    expect(check("openai", "gpt-6.1-sol", "max")).not.toThrow();
    expect(check("zai", "glm-5.3", "high")).not.toThrow();
    expect(check("deepseek", "deepseek-flash", "max")).not.toThrow();
    expect(check("google", "flash-pro", "medium")).not.toThrow();
    expect(check("anthropic", "claude-haiku", "xhigh")).not.toThrow();
  });

  it("refuses a level the model cannot run, saying why", () => {
    expect(check("openai", "gpt-6.1-sol", "none")).toThrow(/at low, medium, high, xhigh, max only, not at reasoning off/);
    expect(check("zai", "glm-5.3", "medium")).toThrow(/not at medium/);
    expect(check("moonshot", "kimi-k3.1-pro", "low")).toThrow(/has been tested with tools yet/);
  });

  it("writes the level where each loop reads it", () => {
    expect(thinkingColumns({ provider: "anthropic", effort: "low" })).toEqual({ effort: "low", thinkingLevel: null });
    expect(thinkingColumns({ provider: "openai", effort: "medium" })).toEqual({ effort: null, thinkingLevel: "medium" });
    expect(thinkingColumns({ provider: "google", effort: null })).toEqual({ effort: null, thinkingLevel: null });
  });
});

describe("a tool round at a picked level", () => {
  beforeEach(() => post.mockReset());

  it("Terra at medium sends reasoning_effort medium (over its tool default none) and goes to the Responses API", async () => {
    post.mockResolvedValue({ model: "gpt-6.1-terra", choices: [{ message: { content: "You have $4.12." }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 60 } });
    await terraTurn({ reasoningLevel: "medium" });
    const { body, reasoningDisabled } = post.mock.calls[0][0];
    expect(body.reasoning_effort).toBe("medium");
    expect(reasoningDisabled).toBe(false);
    expect(usesResponsesApi("openai", "gpt-6.1-terra", body)).toBe(true);
    expect(toResponsesRequest(body).reasoning).toEqual({ effort: "medium" });
  });

  it("Terra at none or its default stays on chat/completions with reasoning off", async () => {
    post.mockResolvedValue({ model: "gpt-6.1-terra", choices: [{ message: { content: "Hi." }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5 } });
    await terraTurn({ reasoningLevel: "none" });
    await terraTurn({});
    for (const [args] of post.mock.calls) {
      expect(args.body.reasoning_effort).toBe("none");
      expect(usesResponsesApi("openai", "gpt-6.1-terra", args.body)).toBe(false);
    }
  });

  it("a level the model does not take fails the turn loud, never the default in silence", async () => {
    await expect(terraTurn({ reasoningLevel: "minimal" })).rejects.toThrow(/does not run at thinking level "minimal"/);
    expect(() => vendorThinkingLevelFields("zai", "glm-5.3", "medium")).toThrow(/low, high, max/);
    expect(vendorThinkingLevelFields("deepseek", "deepseek-flash", "none")).toEqual({ thinking: { type: "disabled" } });
    expect(vendorThinkingLevelFields("zai", "glm-5.3", "max")).toEqual({ reasoning_effort: "max" });
  });

  it("bills the reasoning tokens as output (Responses API output_tokens counts them)", async () => {
    // Shape of the live answer 2026-11-22: 60 output tokens, 10 of them reasoning.
    const answer = fromResponsesBody({
      model: "gpt-6.1-terra",
      status: "completed",
      output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: "You have $4.12." }] }],
      usage: { input_tokens: 100, output_tokens: 60, output_tokens_details: { reasoning_tokens: 10 } } as never,
    });
    expect(answer.usage?.completion_tokens).toBe(60);
    post.mockResolvedValue(answer);
    const r = await terraTurn({ reasoningLevel: "medium" });
    const byName = Object.fromEntries(r.costLines.map((l) => [l.costName, l.quantity]));
    expect(byName["openai-gpt-6.1-terra-tokens-output"]).toBe(60);
  });
});

describe("the models panel says, per scored level, whether Distry can run it", () => {
  const NOW = new Date("2026-11-22T12:00:00Z");
  const entry = (variantLabel: string | null, effort: string | null, score: number, releaseName = "GPT-6.1 Terra", releaseSlug = "gpt-6-1-terra") => ({
    aaId: `${releaseSlug}-${variantLabel}`, aaSlug: `${releaseSlug}-${variantLabel}`, aaName: `${releaseName} (${variantLabel})`, releaseSlug, releaseName,
    variantLabel, effort, creator: null, indexVersion: "4", score, indexCostPerTaskUsd: score / 100, priceInputPer1mUsd: null, priceOutputPer1mUsd: null,
  });
  const entries = [
    entry("Medium", "medium", 38.2), entry("Non-reasoning", null, 30.5), entry("Max", "max", 51.3),
    entry("Xhigh", "xhigh", 53.9, "Gemini 4 Hydrogen", "gemini-4-hydrogen"), entry("Low", "low", 26.9, "Gemini 4 Hydrogen", "gemini-4-hydrogen"),
  ];
  const choices = [
    { provider: "openai" as const, modelId: "gpt-6.1-terra", displayName: "GPT-6.1 Terra", names: ["gpt-terra"], capabilityTier: "strong" as const, costPrefix: "openai-gpt-6.1-terra" },
    { provider: "google" as const, modelId: "gemini-4-hydrogen", displayName: "Gemini 4 Hydrogen", names: ["flash-pro"], capabilityTier: "strong" as const, costPrefix: "google-gemini-4-hydrogen" },
  ];
  const panel = (current: { provider: string; model: string; effort: string | null }) =>
    buildModelPanel({
      choices, state: { latestOk: { read: { id: "r", fetchedAt: NOW, status: "ok", error: null, indexVersion: "4", source: "api" }, entries } as never, latestAttempt: null },
      keyConfigured: true, priceOf: () => null, pricesRead: true, current, now: NOW,
    });

  it("marks the saved level as Distry's thinking, and offers every runnable level", () => {
    const terra = panel({ provider: "openai", model: "gpt-6.1-terra", effort: "medium" }).models.find((m) => m.modelId === "gpt-6.1-terra")!;
    expect(terra.thinkingLevels).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(terra.index.score).toBe(38.2);
    const medium = terra.variants.find((v) => v.variantLabel === "Medium")!;
    expect(medium).toMatchObject({ isDistrysThinking: true, distry: { level: "medium", canRun: true, reason: null } });
    expect(terra.variants.find((v) => v.variantLabel === "Non-reasoning")!.distry).toEqual({ level: "none", canRun: true, reason: null });
  });

  it("a level that cannot run says why instead of offering Use", () => {
    const hydrogen = panel({ provider: "openai", model: "gpt-6.1-terra", effort: "medium" }).models.find((m) => m.modelId === "gemini-4-hydrogen")!;
    expect(hydrogen.variants.find((v) => v.variantLabel === "Xhigh")!.distry).toEqual({
      level: "xhigh", canRun: false, reason: "Distry can run Gemini 4 Hydrogen at low, medium, high only, not at xhigh.",
    });
    expect(chatThinkingLevels("google", "gemini-4-hydrogen")).toEqual(["low", "medium", "high"]);
    expect(thinkingLevelRefusal("google", "gemini-4-hydrogen", "Gemini 4 Hydrogen", "low")).toBeNull();
  });
});

describe("Distry's fallback order: best model x level by intelligence per dollar, dynamically", () => {
  const NOW = new Date("2026-11-22T12:00:00Z");
  const e = (releaseName: string, releaseSlug: string, variantLabel: string | null, effort: string | null, score: number, cost: number | null) => ({
    aaId: `${releaseSlug}-${variantLabel}`, aaSlug: `${releaseSlug}-${variantLabel}`, aaName: `${releaseName} (${variantLabel})`, releaseSlug, releaseName,
    variantLabel, effort, creator: null, indexVersion: "4", score, indexCostPerTaskUsd: cost, priceInputPer1mUsd: null, priceOutputPer1mUsd: null,
  });
  const entries = [
    e("Claude Haiku 5.5", "claude-haiku-5-5", "Low", "low", 18.6, 0.0438),
    e("Claude Haiku 5.5", "claude-haiku-5-5", "Max", "max", 36.5, 0.411),
    e("GPT-6.1 Terra", "gpt-6-1-terra", "Medium", "medium", 38.2, 0.169),
    e("GPT-6.1 Terra", "gpt-6-1-terra", "Non-reasoning", null, 30.5, 0.1),
    e("Gemini 4 Hydrogen", "gemini-4-hydrogen", "Xhigh", "xhigh", 53.9, 0.05),
    e("Gemini 4 Hydrogen", "gemini-4-hydrogen", "Low", "low", 26.9, null),
  ];
  const choices = [
    { provider: "anthropic" as const, modelId: "claude-haiku-5-5", displayName: "Claude Haiku 5.5", names: ["claude-haiku"], capabilityTier: "cheap" as const, costPrefix: "anthropic-haiku-5.5" },
    { provider: "openai" as const, modelId: "gpt-6.1-terra", displayName: "GPT-6.1 Terra", names: ["gpt-terra"], capabilityTier: "strong" as const, costPrefix: "openai-gpt-6.1-terra" },
    { provider: "google" as const, modelId: "gemini-4-hydrogen", displayName: "Gemini 4 Hydrogen", names: ["flash-pro"], capabilityTier: "strong" as const, costPrefix: "google-gemini-4-hydrogen" },
    { provider: "moonshot" as const, modelId: "kimi-k3.1-pro", displayName: "Kimi K3.1 Pro", names: ["kimi-pro"], capabilityTier: "strong" as const, costPrefix: "moonshot-kimi-k3.1-pro" },
  ];
  const panel = (outOfCredit: (p: string) => string | null = () => null) =>
    buildModelPanel({
      choices, state: { latestOk: { read: { id: "r", fetchedAt: NOW, status: "ok", error: null, indexVersion: "4", source: "api" }, entries } as never, latestAttempt: null },
      keyConfigured: true, priceOf: () => null, pricesRead: true, current: { provider: "openai", model: "gpt-terra", effort: "medium" }, now: NOW, outOfCredit: outOfCredit as never,
    });

  it("ranks runnable levels by points per dollar, then scored without a run cost, then unscored; never the current model nor a level that cannot run", () => {
    const p = panel();
    expect(p.fallbackOrder.map((c) => `${c.modelId}@${c.level}`)).toEqual([
      "claude-haiku-5-5@low", // 425 pts/$
      "claude-haiku-5-5@max", // 89 pts/$
      "gemini-4-hydrogen@low", // no run cost, scored 26.9 (xhigh cannot run: left out)
      "kimi-k3.1-pro@null", // no score: last, at its default
    ]);
    expect(p.nextFallback).toBe("If GPT-6.1 Terra cannot serve a turn, Distry answers on Claude Haiku 5.5 at low.");
  });

  it("drops a vendor out of credit, recomputed on every read", () => {
    const p = panel((prov) => (prov === "anthropic" ? "Anthropic is out of credit." : null));
    expect(p.fallbackOrder[0]).toMatchObject({ modelId: "gemini-4-hydrogen", level: "low" });
  });
});
