import { describe, it, expect } from "vitest";
import { modelIdCatalogue, RETIRED_MODELS } from "../../src/lib/model-ids.js";
import { PROVIDER_MODELS, resolveModel, type Provider } from "../../src/lib/anthropic.js";
import { LLM_DYNASTIES } from "../../src/lib/llm-dynasties.js";

const LEGACY = new Set(LLM_DYNASTIES.flatMap((d) => d.legacyAliases));

// Every model id content-generation-service had stored on an email generation
// in prod on 2026-10-18 (SELECT DISTINCT model FROM email_generations). Each
// one names past emails, so each must keep a row here even once retired.
const STORED_IN_PROD = [
  "claude-3-haiku-20240307", "claude-fable-5-1", "claude-haiku-5-5", "claude-opus-4-5",
  "claude-opus-5-5", "claude-sonnet-4-6", "claude-sonnet-5-5", "deepseek-flash",
  "deepseek-v4-flash", "deepseek-v4-pro", "gemini-3.1-flash-lite", "gemini-3.1-pro-preview",
  "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.7-flash",
  "gemini-3.8-flash", "gemini-3-flash-preview", "glm-5.2", "glm-5.3", "glm-5.3-flash",
  "gpt-6-astra", "kimi-k2.6", "kimi-k3",
];

describe("modelIdCatalogue", () => {
  const rows = modelIdCatalogue();
  const byId = new Map(rows.map((r) => [r.modelId, r]));

  it("has one row per id", () => {
    expect(byId.size).toBe(rows.length);
  });

  it("keeps a row for every id that names a stored generation", () => {
    for (const id of STORED_IN_PROD) expect(byId.has(id), id).toBe(true);
  });

  it("serves today exactly the ids /complete resolves, with their aliases and tier", () => {
    for (const provider of Object.keys(PROVIDER_MODELS) as Provider[]) {
      for (const alias of PROVIDER_MODELS[provider]) {
        const r = resolveModel(provider, alias);
        const row = byId.get(r.apiModelId)!;
        expect(row.servedToday).toBe(true);
        // A legacy alias is listed on the model it runs; slugs and ids are callable, not listed.
        if (LEGACY.has(alias)) expect(row.aliases, alias).toContain(alias);
        expect(row.capabilityTier).toBe(r.capabilityTier);
      }
    }
    for (const row of rows.filter((x) => x.servedToday)) expect(row.aliases.length).toBeGreaterThan(0);
  });

  it("groups the two DeepSeek aliases on the one model they resolve to", () => {
    expect(byId.get("deepseek-flash")!.aliases).toEqual(["deepseek-flash", "deepseek-pro"]);
  });

  it("names the tier from the model, not the alias: Flash generations under flash-pro are cheap", () => {
    for (const id of ["gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash"]) {
      expect(byId.get(id)!.capabilityTier, id).toBe("cheap");
    }
    expect(byId.get("gemini-3.1-pro-preview")!.capabilityTier).toBe("strong");
  });

  it("serves retired ids with no current alias", () => {
    for (const id of Object.keys(RETIRED_MODELS)) {
      const row = byId.get(id)!;
      expect(row.servedToday, id).toBe(false);
      expect(row.aliases).toEqual([]);
      expect(row.displayName.length).toBeGreaterThan(0);
    }
    expect(byId.get("glm-5.2")!.formerAliases).toEqual(["glm-pro"]);
  });
});
