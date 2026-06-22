import { describe, it, expect } from "vitest";
import {
  estimateInputTokens,
  estimateOutputTokens,
  resolveOutputBudget,
  DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
  DEFAULT_OUTPUT_ESTIMATE_CEILING_TOKENS,
  MIN_OUTPUT_ESTIMATE_TOKENS,
} from "../../src/lib/provision-estimate.js";

describe("estimateInputTokens", () => {
  it("approximates ~4 chars/token", () => {
    expect(estimateInputTokens("a".repeat(4000))).toBe(1000);
  });

  it("applies a 500-token floor for tiny prompts", () => {
    expect(estimateInputTokens("hi")).toBe(500);
    expect(estimateInputTokens("")).toBe(500);
  });
});

describe("estimateOutputTokens", () => {
  it("never returns the 64k model max (the whole point of right-sizing)", () => {
    // Even an enormous prompt clamps to the ceiling, far below the model max.
    expect(estimateOutputTokens(1_000_000)).toBe(DEFAULT_OUTPUT_ESTIMATE_CEILING_TOKENS);
    expect(estimateOutputTokens(1_000_000)).toBeLessThan(DEFAULT_MODEL_MAX_OUTPUT_TOKENS);
  });

  it("clamps to the floor for small prompts", () => {
    expect(estimateOutputTokens(100)).toBe(MIN_OUTPUT_ESTIMATE_TOKENS);
  });

  it("scales with prompt size between floor and ceiling", () => {
    const mid = estimateOutputTokens(2_000); // 2000 * 2 = 4000
    expect(mid).toBe(4_000);
    expect(mid).toBeGreaterThan(MIN_OUTPUT_ESTIMATE_TOKENS);
    expect(mid).toBeLessThan(DEFAULT_OUTPUT_ESTIMATE_CEILING_TOKENS);
  });
});

describe("resolveOutputBudget", () => {
  it("without maxTokens: hold is right-sized (<< 64k), provider keeps full budget", () => {
    const b = resolveOutputBudget({ message: "Generate 10 search queries." });
    expect(b.providerMaxOutputTokens).toBe(DEFAULT_MODEL_MAX_OUTPUT_TOKENS);
    expect(b.holdOutputTokens).toBeLessThanOrEqual(DEFAULT_OUTPUT_ESTIMATE_CEILING_TOKENS);
    expect(b.holdOutputTokens).toBeLessThan(DEFAULT_MODEL_MAX_OUTPUT_TOKENS);
  });

  it("with maxTokens: caps BOTH the hold and the provider exactly", () => {
    const b = resolveOutputBudget({ message: "score this", maxTokens: 512 });
    expect(b.holdOutputTokens).toBe(512);
    expect(b.providerMaxOutputTokens).toBe(512);
  });

  it("with maxTokens above the model max: bounds to 64k", () => {
    const b = resolveOutputBudget({ message: "x", maxTokens: 999_999 });
    expect(b.holdOutputTokens).toBe(DEFAULT_MODEL_MAX_OUTPUT_TOKENS);
    expect(b.providerMaxOutputTokens).toBe(DEFAULT_MODEL_MAX_OUTPUT_TOKENS);
  });
});

describe("burst affordability — regression for the false-402 incident", () => {
  // Reproduce the production incident: a high-fan-out caller (audiences/suggest)
  // fires N concurrent /complete calls against a fresh $5.00 org. billing-service
  // counts PROVISIONED holds as already-spent, so the affordability check sees
  // SUM(holds) against the balance. With the old flat 64k hold, a handful of
  // concurrent calls drove the balance transiently negative and 402'd.
  const BALANCE_CENTS = 500; // $5 welcome credit
  // Sample output rate observed in prod logs: a 64k-token hold ≈ 115.20c.
  const CENTS_PER_OUTPUT_TOKEN = 115.2 / 64_000;
  const holdCostCents = (outputTokens: number) => outputTokens * CENTS_PER_OUTPUT_TOKEN;

  it("OLD behavior (flat 64k hold) drives a solvent org negative on a small burst", () => {
    const concurrent = 6;
    const totalHeld = concurrent * holdCostCents(64_000);
    expect(totalHeld).toBeGreaterThan(BALANCE_CENTS); // 6 * 115.2 = 691.2 > 500 → false 402
  });

  it("NEW behavior (right-sized hold) keeps a large burst within the balance", () => {
    // Typical suggest prompt → right-sized hold well under the ceiling.
    const { holdOutputTokens } = resolveOutputBudget({
      message: "Suggest 5 audiences for this brand context.".repeat(20),
    });
    const concurrent = 25; // worst-case fan-out from the incident
    const totalHeld = concurrent * holdCostCents(holdOutputTokens);
    expect(totalHeld).toBeLessThan(BALANCE_CENTS);
  });

  it("a caller declaring a small maxTokens shrinks the hold further", () => {
    const { holdOutputTokens } = resolveOutputBudget({ message: "score", maxTokens: 1_024 });
    const concurrent = 25;
    const totalHeld = concurrent * holdCostCents(holdOutputTokens);
    // 25 * (1024 * 115.2/64000) ≈ 46c — trivially affordable.
    expect(totalHeld).toBeLessThan(BALANCE_CENTS / 5);
  });
});
