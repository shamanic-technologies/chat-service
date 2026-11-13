import { describe, it, expect } from "vitest";
import { resolveModel, SUPPORTED_MODELS } from "../../src/lib/anthropic.js";
import { buildThinkingConfig, geminiThinkingFloor } from "../../src/lib/gemini.js";
import { readGeminiBilledTokens } from "../../src/lib/gemini-usage.js";
import { modelIdCatalogue, RETIRED_MODELS } from "../../src/lib/model-ids.js";
import { MODEL_COST_PREFIXES } from "../../src/lib/llm-cost-names.js";
import { TRANSCRIPTION_MODELS } from "../../src/lib/transcription.js";

// HYDROGEN-FLASH-HEAD-1113 (owner 2026-11-13): the gemini-flash dynasty head moved
// from gemini-3.8-flash to Gemini 4 Hydrogen. Every name that ran 3.8 Flash now runs
// Hydrogen, and its spend is declared under Hydrogen's own catalog rows.
describe("Gemini 4 Hydrogen heads the gemini-flash dynasty", () => {
  it("every name of the dynasty runs Hydrogen under its own cost prefix", () => {
    for (const name of ["gemini-flash", "flash-pro", "gemini-4-hydrogen"]) {
      expect(resolveModel("google", name), name).toMatchObject({
        apiModelId: "gemini-4-hydrogen",
        costPrefix: "google-hydrogen-4",
        capabilityTier: "cheap",
      });
    }
    expect(SUPPORTED_MODELS["gemini-4-hydrogen"]).toBe("google-hydrogen-4");
    expect(MODEL_COST_PREFIXES["gemini-4-hydrogen"]).toEqual(["google-hydrogen-4"]);
  });

  it("floors disableThinking at low: the live API refuses MINIMAL with 400 (probed 2026-11-13)", () => {
    expect(geminiThinkingFloor("gemini-4-hydrogen")).toBe("low");
    expect(buildThinkingConfig("gemini-4-hydrogen", true)).toEqual({ thinkingLevel: "low" });
    expect(() => buildThinkingConfig("gemini-4-hydrogen", false, "minimal")).toThrow();
  });

  it("bills thinking at the output rate and an implicit cache hit at the cached rate (live usage shape)", () => {
    // Usage block returned by gemini-4-hydrogen on 2026-11-13 (a repeated 4k-token system prompt).
    const usage = {
      promptTokenCount: 4038,
      candidatesTokenCount: 16,
      thoughtsTokenCount: 21,
      totalTokenCount: 4075,
      cachedContentTokenCount: 1984,
    };
    const { costLines } = readGeminiBilledTokens(usage, "gemini-4-hydrogen", "google-hydrogen-4");
    expect(Object.fromEntries(costLines.map((l) => [l.costName, l.quantity]))).toEqual({
      "google-hydrogen-4-tokens-input": 4038 - 1984,
      "google-hydrogen-4-tokens-cached-input": 1984,
      "google-hydrogen-4-tokens-output": 16 + 21,
    });
  });

  it("keeps 3.8 Flash as a retired id of the dynasty so past spend and emails still name it", () => {
    expect(RETIRED_MODELS["gemini-3.8-flash"]).toMatchObject({ provider: "google", capabilityTier: "cheap" });
    const rows = new Map(modelIdCatalogue().map((r) => [r.modelId, r]));
    expect(rows.get("gemini-4-hydrogen")).toMatchObject({ capabilityTier: "cheap", servedToday: true });
    expect(rows.get("gemini-3.8-flash")).toMatchObject({ servedToday: false });
  });

  it("leaves transcription on 3.8 Flash until its own measured re-run", () => {
    expect(TRANSCRIPTION_MODELS["flash-pro"]).toBe("gemini-3.8-flash");
  });
});
