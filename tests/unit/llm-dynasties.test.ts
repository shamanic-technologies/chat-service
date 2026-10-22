import { describe, it, expect } from "vitest";
import { LLM_DYNASTIES, dynastyOfModel } from "../../src/lib/llm-dynasties.js";
import { modelIdCatalogue, dynastyCatalogue, MODEL_DISPLAY_NAMES } from "../../src/lib/model-ids.js";
import { PROVIDER_MODELS, resolveModel, dynastyFor, modelCatalogue, type Provider } from "../../src/lib/anthropic.js";
import { CompleteRequestSchema, InternalPlatformCompleteRequestSchema } from "../../src/schemas.js";

// The owner-approved table (LLM-DYNASTY-1022, 2026-10-22; Kimi split into K2 / K3 the same day).
const EXPECTED: Record<string, { head: string; legacy: string[] }> = {
  "claude-haiku": { head: "claude-haiku-5-5", legacy: ["haiku"] },
  "claude-sonnet": { head: "claude-sonnet-5-5", legacy: ["sonnet"] },
  "claude-opus": { head: "claude-opus-5-5", legacy: ["opus"] },
  "claude-fable": { head: "claude-fable-5-1", legacy: ["fable"] },
  "gemini-flash-lite": { head: "gemini-3.5-flash-lite", legacy: ["flash", "flash-lite"] },
  "gemini-flash": { head: "gemini-3.8-flash", legacy: ["flash-pro"] },
  "gemini-pro": { head: "gemini-3.1-pro-preview", legacy: ["pro"] },
  "deepseek-flash": { head: "deepseek-flash", legacy: ["deepseek-flash", "deepseek-pro"] },
  "deepseek-pro": { head: "deepseek-v4-pro", legacy: [] },
  "glm-flash": { head: "glm-5.3-flash", legacy: ["glm-flash"] },
  glm: { head: "glm-5.3", legacy: ["glm-pro"] },
  "kimi-k2": { head: "kimi-k2.6", legacy: ["kimi-flash"] },
  "kimi-k3": { head: "kimi-k3", legacy: ["kimi-pro"] },
  "gpt-astra": { head: "gpt-6-astra", legacy: ["gpt-pro"] },
  "gpt-sol": { head: "gpt-6-sol", legacy: ["gpt-sol"] },
  "gpt-terra": { head: "gpt-5.6-terra", legacy: ["gpt-terra"] },
};

const completeBody = (provider: string, model: string) => ({ message: "hi", systemPrompt: "s", provider, model });

describe("LLM dynasties", () => {
  it("carries exactly the owner-approved dynasties, heads and legacy aliases", () => {
    expect(LLM_DYNASTIES.map((d) => d.slug).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const d of LLM_DYNASTIES) {
      expect(d.models[0], d.slug).toBe(EXPECTED[d.slug].head);
      expect([...d.legacyAliases].sort(), d.slug).toEqual([...EXPECTED[d.slug].legacy].sort());
    }
  });

  it("uses no underscore in any slug", () => {
    for (const d of LLM_DYNASTIES) expect(d.slug).not.toContain("_");
  });

  it("puts every model of the catalogue, served AND retired, in exactly one dynasty", () => {
    const all = LLM_DYNASTIES.flatMap((d) => d.models);
    expect(new Set(all).size).toBe(all.length);
    for (const row of modelIdCatalogue()) {
      expect(dynastyOfModel(row.modelId), row.modelId).toBeDefined();
      expect(row.dynasty).toBe(dynastyOfModel(row.modelId)!.slug);
    }
    // and every dynasty version names a catalogue row (no version without a name)
    const ids = new Set(modelIdCatalogue().map((r) => r.modelId));
    for (const id of all) {
      expect(ids.has(id), id).toBe(true);
      expect(MODEL_DISPLAY_NAMES[id], id).toBeDefined();
    }
  });

  it("never lets a served dynasty slug resolve outside its dynasty: it runs the head", () => {
    for (const d of LLM_DYNASTIES.filter((x) => x.servedToday)) {
      const r = resolveModel(d.provider as Provider, d.slug);
      expect(r.apiModelId, d.slug).toBe(d.models[0]);
      expect(dynastyOfModel(r.apiModelId)!.slug).toBe(d.slug);
      expect(dynastyFor(d.provider as Provider, d.slug)).toBe(d.slug);
    }
  });

  it("serves `deepseek-pro` only as the legacy redirect to DeepSeek Flash (V4.1 Flash), never as the retired Pro line", () => {
    const pro = LLM_DYNASTIES.find((d) => d.slug === "deepseek-pro")!;
    expect(pro.servedToday).toBe(false);
    expect(resolveModel("deepseek", "deepseek-pro").apiModelId).toBe("deepseek-flash");
    expect(dynastyFor("deepseek", "deepseek-pro")).toBe("deepseek-flash");
  });

  it("resolves every legacy alias to its dynasty's head", () => {
    for (const d of LLM_DYNASTIES.filter((x) => x.servedToday)) {
      for (const alias of d.legacyAliases) {
        expect(resolveModel(d.provider as Provider, alias).apiModelId, alias).toBe(d.models[0]);
      }
    }
  });

  it("applies the owner-approved moves: flash-lite → 3.5 Flash-Lite, deepseek-pro → V4.1 Flash; no Kimi move", () => {
    expect(resolveModel("google", "flash-lite").apiModelId).toBe("gemini-3.5-flash-lite");
    expect(resolveModel("deepseek", "deepseek-pro").apiModelId).toBe("deepseek-flash");
    expect(resolveModel("moonshot", "kimi-flash").apiModelId).toBe("kimi-k2.6");
    expect(resolveModel("moonshot", "kimi-pro").apiModelId).toBe("kimi-k3");
  });

  it("accepts the head's exact model id to pin it, under the same cost prefix as the slug", () => {
    for (const d of LLM_DYNASTIES.filter((x) => x.servedToday)) {
      const bySlug = resolveModel(d.provider as Provider, d.slug);
      expect(resolveModel(d.provider as Provider, d.models[0])).toEqual(bySlug);
    }
  });

  it("declares spend under the concrete model whatever name called it", () => {
    expect(resolveModel("google", "gemini-flash").costPrefix).toBe("google-flash-3.8");
    expect(resolveModel("google", "flash-pro").costPrefix).toBe("google-flash-3.8");
    expect(resolveModel("google", "gemini-3.8-flash").costPrefix).toBe("google-flash-3.8");
    expect(resolveModel("zai", "glm").costPrefix).toBe("zai-glm-5.3");
  });

  it("refuses an older version id (no live price or probed capability for it)", () => {
    expect(() => resolveModel("google", "gemini-3.7-flash")).toThrow(/Unknown model/);
  });

  it("accepts every dynasty slug and every legacy alias on both completion schemas", () => {
    for (const d of LLM_DYNASTIES) {
      for (const name of [...(d.servedToday ? [d.slug, d.models[0]] : []), ...d.legacyAliases]) {
        expect(CompleteRequestSchema.safeParse(completeBody(d.provider, name)).success, name).toBe(true);
        expect(InternalPlatformCompleteRequestSchema.safeParse(completeBody(d.provider, name)).success, name).toBe(true);
      }
    }
    expect(CompleteRequestSchema.safeParse(completeBody("google", "claude-sonnet")).success).toBe(false);
  });

  it("lists every callable name on /internal/models with its dynasty", () => {
    const rows = modelCatalogue();
    const total = Object.values(PROVIDER_MODELS).reduce((n, names) => n + names.length, 0);
    expect(rows.length).toBe(total);
    expect(rows).toContainEqual({ provider: "google", model: "flash-pro", capabilityTier: "cheap", dynasty: "gemini-flash" });
  });

  it("serves the dynasty list with versions newest first and the old-alias mapping", () => {
    const list = dynastyCatalogue();
    const flash = list.find((d) => d.slug === "gemini-flash")!;
    expect(flash).toMatchObject({ name: "Gemini Flash", provider: "google", headModelId: "gemini-3.8-flash", servedToday: true, legacyAliases: ["flash-pro"] });
    expect(flash.models.map((m) => m.modelId)).toEqual([
      "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash",
      "gemini-3.1-flash-preview", "gemini-3-flash-preview", "gemini-2.5-flash",
    ]);
    expect(flash.models.filter((m) => m.servedToday).map((m) => m.modelId)).toEqual(["gemini-3.8-flash"]);
    const dsPro = list.find((d) => d.slug === "deepseek-pro")!;
    expect(dsPro).toMatchObject({ servedToday: false, headModelId: "deepseek-v4-pro", legacyAliases: [] });
    expect(dsPro.models[0].servedToday).toBe(false);
  });
});
