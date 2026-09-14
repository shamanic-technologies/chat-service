import { describe, it, expect } from "vitest";
import {
  PROVIDER_MODELS,
  capabilityTierFor,
  modelCatalogue,
  resolveModel,
  type Provider,
  type CapabilityTier,
} from "../../src/lib/anthropic.js";

const TIERS: CapabilityTier[] = ["cheap", "strong", "frontier"];

describe("capability tier", () => {
  it("records a tier for every alias this service can resolve", () => {
    for (const provider of Object.keys(PROVIDER_MODELS) as Provider[]) {
      for (const alias of PROVIDER_MODELS[provider]) {
        const tier = capabilityTierFor(provider, alias);
        expect(TIERS, `${provider}/${alias} has an unknown tier "${tier}"`).toContain(tier);
      }
    }
  });

  it("throws on an alias this service cannot resolve rather than inventing a tier", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      capabilityTierFor("google", "not-a-real-alias" as any),
    ).toThrow(/Unknown model/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => capabilityTierFor("nope" as any, "pro" as any)).toThrow(/Unknown provider/);
  });

  // The counter-example the whole design exists for. `flash-pro` contains
  // "pro" and resolves to gemini-3.8-FLASH: a substring rule on the alias
  // string would call it strong, which is exactly the wrong answer for a
  // consumer choosing a model by capability. The tier is a decision recorded
  // per alias; if a later refactor re-derives it from the name, this fails.
  it("reports flash-pro as cheap — it resolves to a Flash model despite the alias name", () => {
    expect(resolveModel("google", "flash-pro").apiModelId).toBe("gemini-3.8-flash");
    expect(capabilityTierFor("google", "flash-pro")).toBe("cheap");
  });

  // Second counter-example, same shape from the other direction: two aliases
  // sharing the "-pro" suffix sit two tiers apart, and a third "-pro" alias is
  // a deprecated synonym for a Flash model.
  it("does not treat the -pro suffix as a tier", () => {
    expect(capabilityTierFor("openai", "gpt-pro")).toBe("frontier");
    expect(capabilityTierFor("zai", "glm-pro")).toBe("strong");
    expect(capabilityTierFor("deepseek", "deepseek-pro")).toBe("cheap");
  });

  it("does not treat the -flash suffix as a tier either — it is read per alias", () => {
    for (const [provider, alias] of [
      ["google", "flash"],
      ["zai", "glm-flash"],
      ["moonshot", "kimi-flash"],
      ["deepseek", "deepseek-flash"],
    ] as Array<[Provider, string]>) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(capabilityTierFor(provider, alias as any)).toBe("cheap");
    }
  });

  it("puts the premium tier above each vendor's workhorse on frontier", () => {
    expect(capabilityTierFor("anthropic", "sonnet")).toBe("strong");
    expect(capabilityTierFor("anthropic", "opus")).toBe("frontier");
    expect(capabilityTierFor("anthropic", "fable")).toBe("frontier");
    expect(capabilityTierFor("anthropic", "haiku")).toBe("cheap");
  });
});

describe("modelCatalogue", () => {
  it("carries exactly the aliases /complete accepts, once each", () => {
    const catalogue = modelCatalogue();
    const expected = (Object.keys(PROVIDER_MODELS) as Provider[]).flatMap((p) =>
      PROVIDER_MODELS[p].map((m) => `${p}/${m}`),
    );
    const got = catalogue.map((e) => `${e.provider}/${e.model}`);
    expect(got.sort()).toEqual(expected.sort());
    expect(new Set(got).size).toBe(got.length);
  });

  it("agrees with capabilityTierFor on every entry", () => {
    for (const entry of modelCatalogue()) {
      expect(entry.capabilityTier).toBe(capabilityTierFor(entry.provider, entry.model));
    }
  });

  it("spans all three tiers, so the catalogue can actually discriminate", () => {
    const tiers = new Set(modelCatalogue().map((e) => e.capabilityTier));
    expect([...tiers].sort()).toEqual(["cheap", "frontier", "strong"]);
  });
});
