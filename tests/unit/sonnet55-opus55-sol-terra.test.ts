// ---------------------------------------------------------------------------
// Claude Sonnet 5.5 / Opus 5.5 (`sonnet` / `opus`) and GPT-6 Sol / GPT-5.6
// Terra (`gpt-sol` / `gpt-terra`), added 2026-09-29 so the public onboarding
// can move onto Sonnet 5.5 and be compared against same-price models.
//
// Every value asserted here was probed against the live vendor APIs the same
// day with the platform keys, not taken from a model page:
//   • Sonnet 5.5 / Opus 5.5 — temperature 0.3 → 400; json_schema → 200;
//     thinking cannot be disabled, `output_config.effort: "low"` → 200.
//   • gpt-6-sol / gpt-5.6-terra — temperature / top_p / max_tokens → 400;
//     reasoning_effort accepts none|low|medium|high|xhigh ('none' → 200, 0
//     reasoning tokens); json_schema → 200.
// Cost prefixes are byte-equal to costs-service's seeded rows.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

let capturedParams: Record<string, unknown> | undefined;

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      stream: (params: Record<string, unknown>) => {
        capturedParams = params;
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

const {
  resolveModel,
  costPrefixForModel,
  capabilityTierFor,
  modelCatalogue,
  anthropicRejectsSampling,
  anthropicEffortFloor,
  assertAnthropicSamplingSupported,
  AnthropicUnsupportedOptionError,
  createAnthropicClient,
} = await import("../../src/lib/anthropic.js");
const { buildVendorRequestBody } = await import("../../src/lib/openai-compatible.js");
const { CompleteRequestSchema, InternalPlatformCompleteRequestSchema } = await import("../../src/schemas.js");

describe("alias resolution", () => {
  it.each([
    ["anthropic", "sonnet", "claude-sonnet-5-5", "anthropic-sonnet-5.5", "strong"],
    ["anthropic", "opus", "claude-opus-5-5", "anthropic-opus-5.5", "frontier"],
    ["openai", "gpt-sol", "gpt-6-sol", "openai-gpt-6-sol", "strong"],
    ["openai", "gpt-terra", "gpt-5.6-terra", "openai-gpt-5.6-terra", "strong"],
  ] as const)("%s/%s → %s under %s, tier %s", (provider, alias, apiModelId, costPrefix, tier) => {
    expect(resolveModel(provider, alias)).toMatchObject({ apiModelId, costPrefix, provider });
    expect(costPrefixForModel(apiModelId)).toBe(costPrefix);
    expect(capabilityTierFor(provider, alias)).toBe(tier);
    expect(modelCatalogue()).toContainEqual({ provider, model: alias, capabilityTier: tier });
  });

  it("keeps the retired 4.6 model ids priced so past spend still resolves", () => {
    expect(costPrefixForModel("claude-sonnet-4-6")).toBe("anthropic-sonnet-4.6");
    expect(costPrefixForModel("claude-opus-4-6")).toBe("anthropic-opus-4.6");
  });

  it("does not move gpt-pro or fable", () => {
    expect(resolveModel("openai", "gpt-pro").apiModelId).toBe("gpt-6-astra");
    expect(resolveModel("anthropic", "fable").apiModelId).toBe("claude-fable-5-1");
  });
});

describe("request contract", () => {
  const base = { message: "m", systemPrompt: "s" };
  it.each([
    ["openai", "gpt-sol"],
    ["openai", "gpt-terra"],
  ])("accepts %s/%s on both completion routes", (provider, model) => {
    expect(CompleteRequestSchema.safeParse({ ...base, provider, model }).success).toBe(true);
    expect(InternalPlatformCompleteRequestSchema.safeParse({ ...base, provider, model }).success).toBe(true);
  });

  it("refuses the new OpenAI aliases under another provider", () => {
    const r = CompleteRequestSchema.safeParse({ ...base, provider: "anthropic", model: "gpt-sol" });
    expect(r.success).toBe(false);
  });
});

describe("Anthropic 5.5 — sampling", () => {
  it("refuses temperature before any spend on sonnet and opus, keeps haiku open", () => {
    for (const alias of ["sonnet", "opus"] as const) {
      const id = resolveModel("anthropic", alias).apiModelId;
      expect(anthropicRejectsSampling(id)).toBe(true);
      expect(() => assertAnthropicSamplingSupported(id, 0.3)).toThrow(AnthropicUnsupportedOptionError);
    }
    expect(anthropicRejectsSampling(resolveModel("anthropic", "haiku").apiModelId)).toBe(false);
  });
});

describe("Anthropic 5.5 — disableThinking lowers effort, never disables thinking", () => {
  beforeEach(() => {
    capturedParams = undefined;
  });
  const schema = { type: "object", properties: { city: { type: "string" } }, required: ["city"] };

  it("records `low` as the floor for Sonnet 5.5 / Opus 5.5 only", () => {
    expect(anthropicEffortFloor("claude-sonnet-5-5")).toBe("low");
    expect(anthropicEffortFloor("claude-opus-5-5")).toBe("low");
    // Fable and Haiku keep the no-op they always had.
    expect(anthropicEffortFloor("claude-fable-5-1")).toBeNull();
    expect(anthropicEffortFloor("claude-haiku-4-5")).toBeNull();
  });

  it("sends effort beside the schema format when disableThinking is true", async () => {
    const claude = createAnthropicClient({ apiKey: "k", systemPrompt: "s" });
    await claude.complete("m", { model: "claude-sonnet-5-5", responseSchema: schema, disableThinking: true });
    const oc = capturedParams!.output_config as Record<string, unknown>;
    expect(oc.effort).toBe("low");
    expect((oc.format as Record<string, unknown>).type).toBe("json_schema");
    // Never a thinking block: `{type:"disabled"}` is a 400 on these models.
    expect(capturedParams!.thinking).toBeUndefined();
  });

  it("sends effort alone on a free-text request", async () => {
    const claude = createAnthropicClient({ apiKey: "k", systemPrompt: "s" });
    await claude.complete("m", { model: "claude-opus-5-5", disableThinking: true });
    expect(capturedParams!.output_config).toEqual({ effort: "low" });
  });

  it("leaves the request byte-identical when disableThinking is absent or on Fable", async () => {
    const claude = createAnthropicClient({ apiKey: "k", systemPrompt: "s" });
    await claude.complete("m", { model: "claude-sonnet-5-5" });
    expect(capturedParams!.output_config).toBeUndefined();
    await claude.complete("m", { model: "claude-fable-5-1", disableThinking: true });
    expect(capturedParams!.output_config).toBeUndefined();
  });
});

describe("GPT-6 Sol / GPT-5.6 Terra — request body", () => {
  const schema = { type: "object", properties: { city: { type: "string" } } };
  for (const model of ["gpt-6-sol", "gpt-5.6-terra"]) {
    it(`${model}: reasoning fully OFF for a structured request (it has a 'none')`, () => {
      const body = buildVendorRequestBody({ vendor: "openai", apiKey: "k", model, message: "m", responseSchema: schema });
      expect(body.reasoning_effort).toBe("none");
      expect(body.response_format).toMatchObject({ type: "json_schema" });
    });

    it(`${model}: caps under max_completion_tokens, never max_tokens`, () => {
      const body = buildVendorRequestBody({ vendor: "openai", apiKey: "k", model, message: "m", maxOutputTokens: 4096 });
      expect(body.max_completion_tokens).toBe(4096);
      expect(body.max_tokens).toBeUndefined();
    });
  }

  it("keeps Astra on its `low` floor — it refuses 'none'", () => {
    const body = buildVendorRequestBody({ vendor: "openai", apiKey: "k", model: "gpt-6-astra", message: "m", responseSchema: schema });
    expect(body.reasoning_effort).toBe("low");
  });
});
