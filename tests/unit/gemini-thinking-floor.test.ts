import { describe, it, expect } from "vitest";
import {
  buildThinkingConfig,
  geminiThinkingFloor,
  geminiModelsWithThinkingFloor,
} from "../../src/lib/gemini.js";
import { PROVIDER_MODELS, resolveModel } from "../../src/lib/anthropic.js";

// Google publishes the accepted thinking levels PER MODEL, and they differ
// inside one generation:
// https://ai.google.dev/gemini-api/docs/thinking (read 2026-08-24, re-read
// 2026-09-05 for gemini-3.8-flash)
//   gemini-3.8-flash        low, medium, high        (minimal → 400)
//   gemini-3.7-flash        low, medium, high        (minimal → 400)
//   gemini-3.1-pro-preview  low, medium, high        (minimal → 400)
//   gemini-3.5-flash-lite   minimal, low, medium, high
//   gemini-3.5-flash        minimal, low, medium, high
//   gemini-3.6-flash        minimal, low, medium, high
//   gemini-3-flash-preview  minimal, low, medium, high
//   gemini-3-pro-preview    low, high
// gemini-3.1-flash-lite is absent from that table; "minimal" was confirmed
// accepted against the live API on 2026-08-24.
//
// This file pins the resolved level per model id, so a model swap that changes
// the floor (as gemini-3.6-flash → gemini-3.7-flash silently did on 2026-08-14)
// fails here rather than 400-ing every disableThinking call in production.
const EXPECTED_FLOOR: Record<string, string> = {
  "gemini-3.1-flash-lite": "minimal",
  "gemini-3.5-flash-lite": "minimal",
  "gemini-3.5-flash": "minimal",
  "gemini-3.6-flash": "minimal",
  "gemini-3-flash-preview": "minimal",
  "gemini-3.8-flash": "low",
  "gemini-3.7-flash": "low",
  "gemini-3.1-pro-preview": "low",
  "gemini-3-pro-preview": "low",
};

describe("per-model Gemini 3 thinking floor", () => {
  for (const [model, floor] of Object.entries(EXPECTED_FLOOR)) {
    it(`disableThinking resolves ${model} to "${floor}"`, () => {
      expect(geminiThinkingFloor(model)).toBe(floor);
      expect(buildThinkingConfig(model, true)).toEqual({ thinkingLevel: floor });
    });
  }

  it("does not send minimal to a model that rejects it (the 2026-08-14 outage)", () => {
    // Verbatim provider error the old generation+substring floor produced:
    // 400 INVALID_ARGUMENT "Thinking level MINIMAL is not supported for this model."
    expect(buildThinkingConfig("gemini-3.7-flash", true)).toEqual({ thinkingLevel: "low" });
    expect(buildThinkingConfig("gemini-3.1-pro-preview", true)).toEqual({ thinkingLevel: "low" });
    // gemini-3.8-flash is the current flash-pro alias and rejects minimal too —
    // the same shape that caused the outage, checked before the swap this time.
    expect(buildThinkingConfig("gemini-3.8-flash", true)).toEqual({ thinkingLevel: "low" });
  });

  it("throws for a Gemini 3 model with no recorded floor instead of guessing", () => {
    expect(() => geminiThinkingFloor("gemini-3.9-flash")).toThrow(/No recorded minimum thinking level/);
    expect(() => buildThinkingConfig("gemini-3.9-flash", true)).toThrow(
      /No recorded minimum thinking level/,
    );
    expect(() => buildThinkingConfig("gemini-3.9-flash")).toThrow(
      /No recorded minimum thinking level/,
    );
  });

  it("keeps Gemini 2.5 fully off (thinkingBudget 0) — no level involved", () => {
    expect(buildThinkingConfig("gemini-2.5-flash", true)).toEqual({ thinkingBudget: 0 });
    expect(buildThinkingConfig("gemini-2.5-pro", true, "high")).toEqual({ thinkingBudget: 0 });
  });
});

describe("every exposed Gemini alias has a recorded floor", () => {
  // Requirement: an alias pointing at a model with no recorded floor cannot
  // resolve to a guessed one. A future alias upgrade (flash-pro → the next
  // model) fails HERE, before it can 400 in production.
  const aliases = PROVIDER_MODELS.google;

  for (const alias of aliases) {
    it(`google/${alias} resolves to a model with a recorded floor`, () => {
      const { apiModelId } = resolveModel("google", alias);
      expect(geminiModelsWithThinkingFloor()).toContain(apiModelId);
      // And disableThinking produces a level the provider accepts.
      const cfg = buildThinkingConfig(apiModelId, true) as { thinkingLevel?: string };
      expect(["minimal", "low", "medium", "high"]).toContain(cfg.thinkingLevel);
    });
  }
});

describe("explicit thinkingLevel below a model's floor fails loud", () => {
  it("rejects thinkingLevel:minimal on gemini-3.7-flash rather than sending it", () => {
    expect(() => buildThinkingConfig("gemini-3.7-flash", false, "minimal")).toThrow(
      /not supported by model "gemini-3.7-flash".*lowest accepted level is "low"/,
    );
  });

  it("accepts a level at or above the floor", () => {
    expect(buildThinkingConfig("gemini-3.7-flash", false, "low")).toEqual({ thinkingLevel: "low" });
    expect(buildThinkingConfig("gemini-3.7-flash", false, "high")).toEqual({
      thinkingLevel: "high",
    });
    expect(buildThinkingConfig("gemini-3.5-flash-lite", false, "minimal")).toEqual({
      thinkingLevel: "minimal",
    });
  });

  it("leaves the default (no level, no disableThinking) unchanged at low", () => {
    for (const model of Object.keys(EXPECTED_FLOOR)) {
      expect(buildThinkingConfig(model)).toEqual({ thinkingLevel: "low" });
    }
    expect(buildThinkingConfig("gemini-2.5-flash")).toEqual({ thinkingBudget: 8192 });
  });
});
