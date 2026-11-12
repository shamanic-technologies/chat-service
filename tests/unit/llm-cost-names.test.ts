import { describe, it, expect } from "vitest";
import { llmCostNameCatalogue } from "../../src/lib/llm-cost-names.js";
import { PROVIDER_MODELS, resolveModel, type Provider } from "../../src/lib/anthropic.js";
import { flatCostNames } from "../../src/lib/cost-names.js";

// Every LLM token cost name stored in runs-service on 2026-11-12 (all time,
// SELECT DISTINCT cost_name FROM runs_costs), with the dynasty it must resolve
// to. Judges, image, embedding and search units are not LLM dynasties.
const STORED_IN_PROD: Record<string, string> = {
  "anthropic-fable-5.1-tokens-cached-input": "claude-fable",
  "anthropic-fable-5.1-tokens-cache-write-5m": "claude-fable",
  "anthropic-fable-5.1-tokens-input": "claude-fable",
  "anthropic-fable-5.1-tokens-output": "claude-fable",
  "anthropic-haiku-4.5-tokens-input": "claude-haiku",
  "anthropic-haiku-4.5-tokens-output": "claude-haiku",
  "anthropic-haiku-5.5-tokens-cached-input": "claude-haiku",
  "anthropic-haiku-5.5-tokens-cache-write-5m": "claude-haiku",
  "anthropic-haiku-5.5-tokens-input": "claude-haiku",
  "anthropic-haiku-5.5-tokens-output": "claude-haiku",
  "anthropic-opus-4.5-tokens-input": "claude-opus",
  "anthropic-opus-4.5-tokens-output": "claude-opus",
  "anthropic-opus-4.6-tokens-input": "claude-opus",
  "anthropic-opus-4.6-tokens-output": "claude-opus",
  "anthropic-opus-5.5-tokens-cached-input": "claude-opus",
  "anthropic-opus-5.5-tokens-cache-write-5m": "claude-opus",
  "anthropic-opus-5.5-tokens-input": "claude-opus",
  "anthropic-opus-5.5-tokens-output": "claude-opus",
  "anthropic-sonnet-4.6-tokens-input": "claude-sonnet",
  "anthropic-sonnet-4.6-tokens-output": "claude-sonnet",
  "anthropic-sonnet-5.5-tokens-cached-input": "claude-sonnet",
  "anthropic-sonnet-5.5-tokens-cache-write-5m": "claude-sonnet",
  "anthropic-sonnet-5.5-tokens-input": "claude-sonnet",
  "anthropic-sonnet-5.5-tokens-output": "claude-sonnet",
  "deepseek-v4.1-flash-off-peak-tokens-cached-input": "deepseek-flash",
  "deepseek-v4.1-flash-off-peak-tokens-input": "deepseek-flash",
  "deepseek-v4.1-flash-off-peak-tokens-output": "deepseek-flash",
  "deepseek-v4.1-flash-peak-tokens-cached-input": "deepseek-flash",
  "deepseek-v4.1-flash-peak-tokens-input": "deepseek-flash",
  "deepseek-v4.1-flash-peak-tokens-output": "deepseek-flash",
  "deepseek-v4-flash-off-peak-tokens-cached-input": "deepseek-flash",
  "deepseek-v4-flash-off-peak-tokens-input": "deepseek-flash",
  "deepseek-v4-flash-off-peak-tokens-output": "deepseek-flash",
  "deepseek-v4-flash-peak-tokens-input": "deepseek-flash",
  "deepseek-v4-flash-peak-tokens-output": "deepseek-flash",
  "deepseek-v4-flash-tokens-input": "deepseek-flash",
  "deepseek-v4-flash-tokens-output": "deepseek-flash",
  "deepseek-v4-pro-off-peak-tokens-cached-input": "deepseek-pro",
  "deepseek-v4-pro-off-peak-tokens-input": "deepseek-pro",
  "deepseek-v4-pro-off-peak-tokens-output": "deepseek-pro",
  "deepseek-v4-pro-peak-tokens-cached-input": "deepseek-pro",
  "deepseek-v4-pro-peak-tokens-input": "deepseek-pro",
  "deepseek-v4-pro-peak-tokens-output": "deepseek-pro",
  "deepseek-v4-pro-tokens-input": "deepseek-pro",
  "deepseek-v4-pro-tokens-output": "deepseek-pro",
  "gemini-3-flash-tokens-input": "gemini-flash",
  "gemini-3-flash-tokens-output": "gemini-flash",
  "google-argon-4-tokens-input": "gemini-argon",
  "google-argon-4-tokens-output": "gemini-argon",
  "google-flash-3.5-tokens-input": "gemini-flash",
  "google-flash-3.5-tokens-output": "gemini-flash",
  "google-flash-3.6-tokens-input": "gemini-flash",
  "google-flash-3.6-tokens-output": "gemini-flash",
  "google-flash-3.7-tokens-input": "gemini-flash",
  "google-flash-3.7-tokens-output": "gemini-flash",
  "google-flash-3.8-tokens-cached-input": "gemini-flash",
  "google-flash-3.8-tokens-input": "gemini-flash",
  "google-flash-3.8-tokens-output": "gemini-flash",
  "google-flash-3-tokens-input": "gemini-flash",
  "google-flash-3-tokens-output": "gemini-flash",
  "google-flash-lite-3.1-tokens-cached-input": "gemini-flash-lite",
  "google-flash-lite-3.1-tokens-input": "gemini-flash-lite",
  "google-flash-lite-3.1-tokens-output": "gemini-flash-lite",
  "google-flash-lite-3.5-tokens-cached-input": "gemini-flash-lite",
  "google-flash-lite-3.5-tokens-input": "gemini-flash-lite",
  "google-flash-lite-3.5-tokens-output": "gemini-flash-lite",
  "google-pro-3.1-long-context-tokens-cached-input": "gemini-pro",
  "google-pro-3.1-long-context-tokens-input": "gemini-pro",
  "google-pro-3.1-long-context-tokens-output": "gemini-pro",
  "google-pro-3.1-tokens-cached-input": "gemini-pro",
  "google-pro-3.1-tokens-input": "gemini-pro",
  "google-pro-3.1-tokens-output": "gemini-pro",
  "moonshot-kimi-k2.6-tokens-cached-input": "kimi-k2",
  "moonshot-kimi-k2.6-tokens-input": "kimi-k2",
  "moonshot-kimi-k2.6-tokens-output": "kimi-k2",
  "moonshot-kimi-k3-tokens-cached-input": "kimi-k3",
  "moonshot-kimi-k3-tokens-input": "kimi-k3",
  "moonshot-kimi-k3-tokens-output": "kimi-k3",
  "openai-gpt-5.6-terra-tokens-cached-input": "gpt-terra",
  "openai-gpt-5.6-terra-tokens-input": "gpt-terra",
  "openai-gpt-5.6-terra-tokens-output": "gpt-terra",
  "openai-gpt-6.1-sol-tokens-cache-write": "gpt-sol",
  "openai-gpt-6.1-sol-tokens-input": "gpt-sol",
  "openai-gpt-6.1-sol-tokens-output": "gpt-sol",
  "openai-gpt-6.1-terra-tokens-cache-write": "gpt-terra",
  "openai-gpt-6.1-terra-tokens-input": "gpt-terra",
  "openai-gpt-6.1-terra-tokens-output": "gpt-terra",
  "openai-gpt-6-astra-tokens-cached-input": "gpt-astra",
  "openai-gpt-6-astra-tokens-cache-write": "gpt-astra",
  "openai-gpt-6-astra-tokens-input": "gpt-astra",
  "openai-gpt-6-astra-tokens-output": "gpt-astra",
  "openai-gpt-6-sol-tokens-cached-input": "gpt-sol",
  "openai-gpt-6-sol-tokens-input": "gpt-sol",
  "openai-gpt-6-sol-tokens-output": "gpt-sol",
  "zai-glm-4.7-flashx-tokens-cached-input": "glm-flash",
  "zai-glm-4.7-flashx-tokens-input": "glm-flash",
  "zai-glm-4.7-flashx-tokens-output": "glm-flash",
  "zai-glm-5.2-tokens-cached-input": "glm",
  "zai-glm-5.2-tokens-input": "glm",
  "zai-glm-5.2-tokens-output": "glm",
  "zai-glm-5.3-flash-tokens-cached-input": "glm-flash",
  "zai-glm-5.3-flash-tokens-input": "glm-flash",
  "zai-glm-5.3-flash-tokens-output": "glm-flash",
  "zai-glm-5.3-tokens-cached-input": "glm",
  "zai-glm-5.3-tokens-input": "glm",
  "zai-glm-5.3-tokens-output": "glm",
};

describe("llmCostNameCatalogue", () => {
  const rows = llmCostNameCatalogue();
  const byName = new Map(rows.map((r) => [r.costName, r]));

  it("has one row per cost name", () => {
    expect(byName.size).toBe(rows.length);
  });

  it("resolves every LLM cost name stored in prod to its dynasty, retired versions included", () => {
    for (const [name, dynasty] of Object.entries(STORED_IN_PROD)) {
      expect(byName.get(name)?.dynasty, name).toBe(dynasty);
    }
  });

  it("names the concrete model behind a cost name", () => {
    expect(byName.get("anthropic-fable-5.1-tokens-output")!.modelIds).toEqual(["claude-fable-5-1"]);
    expect(byName.get("deepseek-v4.1-flash-peak-tokens-output")!.modelIds).toEqual(["deepseek-flash"]);
    expect(byName.get("google-flash-lite-3.1-tokens-input")!.modelIds.sort()).toEqual([
      "gemini-3.1-flash-lite",
      "gemini-3.1-flash-lite-preview",
    ]);
  });

  it("does not confuse nested prefixes (GLM-5.3 vs GLM-5.3 Flash)", () => {
    expect(byName.get("zai-glm-5.3-tokens-output")!.modelIds).toEqual(["glm-5.3"]);
    expect(byName.get("zai-glm-5.3-flash-tokens-output")!.modelIds).toEqual(["glm-5.3-flash"]);
  });

  it("covers every name /complete bills today, for every callable alias", () => {
    for (const provider of Object.keys(PROVIDER_MODELS) as Provider[]) {
      for (const alias of PROVIDER_MODELS[provider]) {
        const r = resolveModel(provider, alias);
        const flat = flatCostNames(r.costPrefix);
        for (const name of [flat.input, flat.output]) {
          expect(byName.get(name)?.modelIds, `${alias} → ${name}`).toContain(r.apiModelId);
        }
      }
    }
  });

  it("lists no judge, image or embedding name", () => {
    for (const name of ["typesafe-jev-1.13-tokens-input", "cloudflare-clef-tokens-input", "google-flash-image-3.1-tokens-output", "google-embedding-001-tokens-input"]) {
      expect(byName.has(name), name).toBe(false);
    }
  });
});
