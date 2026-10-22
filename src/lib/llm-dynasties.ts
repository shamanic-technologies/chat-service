/**
 * LLM dynasties (LLM-DYNASTY-1022, owner 2026-10-22): one dynasty = one vendor
 * LINE x tier, named the way the vendor names the line, without a version
 * number. Its versions pool their history, like workflow and template
 * dynasties: when a vendor ships a new version, the line keeps what it proved.
 *
 * The rules, decided by the owner (never by an LLM judgment):
 *   - Thinking level is a call parameter: same dynasty.
 *   - Preview and GA of one model: same dynasty.
 *   - A renamed line joins the old dynasty ONLY when the vendor states it
 *     replaces it; otherwise it is a new dynasty.
 *   - Flash and Flash-Lite are separate dynasties.
 *
 * The dynasty is a fact on the MODEL, never derived from an alias: an alias has
 * moved across lines (`flash` went from Gemini 3 Flash to 3.5 Flash-Lite).
 * Whoever adds a model adds it to its dynasty's `models` in the same change;
 * `tests/unit/llm-dynasties.test.ts` fails a model without one.
 *
 * Pure data, no imports: `schemas.ts` builds the `/complete` model enum from it.
 */

export type DynastyProvider = "anthropic" | "google" | "deepseek" | "zai" | "moonshot" | "openai";
export type DynastyTier = "cheap" | "strong" | "frontier";

export interface LlmDynasty {
  /** The name a workflow writes in `/complete` `model`. Always `-`, never `_`. */
  slug: string;
  /** The vendor's name for the line, no version. */
  name: string;
  provider: DynastyProvider;
  /** Tier of the HEAD model. */
  capabilityTier: DynastyTier;
  /**
   * Every concrete model id of the line, NEWEST FIRST. `models[0]` is the head:
   * the newest version a current name serves (or, for a line nothing serves any
   * more, its last version).
   */
  models: readonly string[];
  /**
   * True when the slug answers `/complete` and runs `models[0]`. False for a
   * line no name serves any more (DeepSeek Pro): its history stays readable.
   */
  servedToday: boolean;
  /**
   * The version-free names workflows wrote BEFORE dynasties. Each still answers
   * `/complete` as a redirect to this dynasty's head, and tells a consumer which
   * dynasty an old workflow belongs to. May equal the slug.
   */
  legacyAliases: readonly string[];
}

export const LLM_DYNASTIES: readonly LlmDynasty[] = [
  // Anthropic
  {
    slug: "claude-haiku",
    name: "Claude Haiku",
    provider: "anthropic",
    capabilityTier: "cheap",
    models: ["claude-haiku-5-5", "claude-haiku-4-5", "claude-3-haiku-20240307"],
    servedToday: true,
    legacyAliases: ["haiku"],
  },
  {
    slug: "claude-sonnet",
    name: "Claude Sonnet",
    provider: "anthropic",
    capabilityTier: "strong",
    models: ["claude-sonnet-5-5", "claude-sonnet-4-6"],
    servedToday: true,
    legacyAliases: ["sonnet"],
  },
  {
    slug: "claude-opus",
    name: "Claude Opus",
    provider: "anthropic",
    capabilityTier: "frontier",
    models: ["claude-opus-5-5", "claude-opus-4-6", "claude-opus-4-5"],
    servedToday: true,
    legacyAliases: ["opus"],
  },
  {
    slug: "claude-fable",
    name: "Claude Fable",
    provider: "anthropic",
    capabilityTier: "frontier",
    models: ["claude-fable-5-1"],
    servedToday: true,
    legacyAliases: ["fable"],
  },
  // Google
  {
    slug: "gemini-flash-lite",
    name: "Gemini Flash-Lite",
    provider: "google",
    capabilityTier: "cheap",
    models: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.1-flash-lite-preview", "gemini-2.5-flash-lite"],
    servedToday: true,
    legacyAliases: ["flash", "flash-lite"],
  },
  {
    slug: "gemini-flash",
    name: "Gemini Flash",
    provider: "google",
    capabilityTier: "cheap",
    models: [
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-3.1-flash-preview",
      "gemini-3-flash-preview",
      "gemini-2.5-flash",
    ],
    servedToday: true,
    legacyAliases: ["flash-pro"],
  },
  {
    slug: "gemini-pro",
    name: "Gemini Pro",
    provider: "google",
    capabilityTier: "strong",
    models: ["gemini-3.1-pro-preview", "gemini-2.5-pro"],
    servedToday: true,
    legacyAliases: ["pro"],
  },
  // DeepSeek
  {
    slug: "deepseek-flash",
    name: "DeepSeek Flash",
    provider: "deepseek",
    capabilityTier: "cheap",
    models: ["deepseek-flash", "deepseek-v4-flash"],
    servedToday: true,
    // `deepseek-pro` has served V4.1 Flash since 2026-09-10 (V4 Pro was
    // discontinued); it stays a redirect here, owner 2026-10-22.
    legacyAliases: ["deepseek-flash", "deepseek-pro"],
  },
  {
    slug: "deepseek-pro",
    name: "DeepSeek Pro",
    provider: "deepseek",
    capabilityTier: "strong",
    models: ["deepseek-v4-pro"],
    // Nothing serves V4 Pro. The NAME `deepseek-pro` still answers /complete,
    // as the legacy redirect to `deepseek-flash` above, never as this line.
    servedToday: false,
    legacyAliases: [],
  },
  // Z.ai
  {
    slug: "glm-flash",
    name: "GLM Flash",
    provider: "zai",
    capabilityTier: "cheap",
    models: ["glm-5.3-flash", "glm-4.7-flashx"],
    servedToday: true,
    legacyAliases: ["glm-flash"],
  },
  {
    slug: "glm",
    name: "GLM",
    provider: "zai",
    capabilityTier: "strong",
    models: ["glm-5.3", "glm-5.2"],
    servedToday: true,
    legacyAliases: ["glm-pro"],
  },
  // Moonshot
  // Two lines: Moonshot sells K2 and K3 side by side at two price tiers
  // (owner 2026-10-22, amending the single `kimi` dynasty).
  {
    slug: "kimi-k2",
    name: "Kimi K2",
    provider: "moonshot",
    capabilityTier: "cheap",
    models: ["kimi-k2.6"],
    servedToday: true,
    legacyAliases: ["kimi-flash"],
  },
  {
    slug: "kimi-k3",
    name: "Kimi K3",
    provider: "moonshot",
    capabilityTier: "strong",
    models: ["kimi-k3"],
    servedToday: true,
    legacyAliases: ["kimi-pro"],
  },
  // OpenAI
  {
    slug: "gpt-astra",
    name: "GPT Astra",
    provider: "openai",
    capabilityTier: "frontier",
    models: ["gpt-6-astra"],
    servedToday: true,
    legacyAliases: ["gpt-pro"],
  },
  {
    slug: "gpt-sol",
    name: "GPT Sol",
    provider: "openai",
    capabilityTier: "strong",
    models: ["gpt-6-sol"],
    servedToday: true,
    legacyAliases: ["gpt-sol"],
  },
  {
    slug: "gpt-terra",
    name: "GPT Terra",
    provider: "openai",
    capabilityTier: "strong",
    models: ["gpt-5.6-terra"],
    servedToday: true,
    legacyAliases: ["gpt-terra"],
  },
];

/** The dynasty a concrete model id belongs to, or undefined (a test forbids that for any catalogue id). */
export function dynastyOfModel(modelId: string): LlmDynasty | undefined {
  return LLM_DYNASTIES.find((d) => d.models.includes(modelId));
}

/**
 * Every name `/complete` accepts for a provider, in this order per served
 * dynasty: the dynasty slug, the head's exact model id (pins the version), then
 * the legacy aliases. Deduplicated (`deepseek-flash` is slug, id and alias).
 */
export function callableModelNames(provider: DynastyProvider): string[] {
  const names: string[] = [];
  for (const d of LLM_DYNASTIES) {
    if (d.provider !== provider || !d.servedToday) continue;
    for (const name of [d.slug, d.models[0], ...d.legacyAliases]) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

export const DYNASTY_PROVIDERS: readonly DynastyProvider[] = ["anthropic", "google", "deepseek", "zai", "moonshot", "openai"];

/** Every name `/complete` accepts, all providers. */
export const ALL_CALLABLE_MODEL_NAMES: readonly string[] = DYNASTY_PROVIDERS.flatMap(callableModelNames).filter(
  (name, i, all) => all.indexOf(name) === i,
);
