import { describe, it, expect } from "vitest";
import { PROVIDER_MODELS, resolveModel, type Provider } from "../../src/lib/anthropic.js";
import { LLM_DYNASTIES } from "../../src/lib/llm-dynasties.js";
import { FALLBACK_MODELS, fallbackModelFor } from "../../src/lib/vendor-credit.js";

// Owner rule: NOTHING ever goes to Claude Haiku 4.5 (`claude-haiku-4-5`); Haiku 5.5 is allowed.
// Every name a caller may send (dynasty slug, head id, legacy alias such as `haiku`) and every
// out-of-credit fallback must resolve to another model, and the 4.5 id itself must be refused.
const HAIKU_45 = "claude-haiku-4-5";

describe("no name and no fallback ever reaches Claude Haiku 4.5 (owner rule)", () => {
  const providers = Object.keys(PROVIDER_MODELS) as Provider[];
  const names: Array<[Provider, string]> = [
    ...providers.flatMap((p) => PROVIDER_MODELS[p].map((m) => [p, m] as [Provider, string])),
    // Every legacy alias, served dynasty or not (a name that stops resolving is fine; one reaching 4.5 is not).
    ...LLM_DYNASTIES.flatMap((d) => d.legacyAliases.map((a) => [d.provider as Provider, a] as [Provider, string])),
  ];

  it("covers the old `haiku` alias", () => {
    expect(names).toContainEqual(["anthropic", "haiku"]);
  });

  it.each(names)("%s / %s never resolves to claude-haiku-4-5", (provider, name) => {
    let apiModelId: string | null = null;
    try {
      apiModelId = resolveModel(provider, name).apiModelId;
    } catch {
      return; // refused loudly: allowed
    }
    expect(apiModelId).not.toBe(HAIKU_45);
    const fb = fallbackModelFor(resolveModel(provider, name));
    if (fb) expect(fb.apiModelId).not.toBe(HAIKU_45);
  });

  it("`haiku` runs Claude Haiku 5.5", () => {
    expect(resolveModel("anthropic", "haiku").apiModelId).toBe("claude-haiku-5-5");
    expect(resolveModel("anthropic", "claude-haiku").apiModelId).toBe("claude-haiku-5-5");
  });

  it("the Haiku 4.5 id itself is refused", () => {
    expect(() => resolveModel("anthropic", HAIKU_45)).toThrow();
  });

  it("no declared fallback names Haiku 4.5", () => {
    for (const fb of Object.values(FALLBACK_MODELS)) expect(resolveModel(fb.provider, fb.model).apiModelId).not.toBe(HAIKU_45);
  });
});
