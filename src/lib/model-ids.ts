import {
  PROVIDER_MODELS,
  resolveModel,
  type CapabilityTier,
  type ModelAlias,
  type Provider,
} from "./anthropic.js";
import { LLM_DYNASTIES, dynastyOfModel } from "./llm-dynasties.js";

/**
 * Concrete model id → display name + capability tier, for every id this
 * service writes with TODAY and every id it (or the caller before it moved
 * here) wrote with BEFORE.
 *
 * Why per concrete id and not per alias: consumers store the id that actually
 * answered (content-generation-service records `gemini-3.1-pro-preview`, not
 * `pro`), and an alias moves to a new model every few weeks. A study grouping
 * emails by model must name each id the way this service names it, and must
 * not guess the tier from the string (`flash-pro` is a Flash model, `cheap`).
 *
 * Today's ids are DERIVED from MODEL_MAP (via PROVIDER_MODELS + resolveModel),
 * so their aliases and tier cannot drift from what /complete resolves. Only
 * two things are recorded by hand: the display name of every id, and the facts
 * of the retired ids, which no map carries any more.
 */

/** Human-readable name of every concrete model id, served or retired. */
export const MODEL_DISPLAY_NAMES: Record<string, string> = {
  // Anthropic
  "claude-haiku-5-5": "Claude Haiku 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-fable-5-1": "Claude Fable 5.1",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-opus-4-5": "Claude Opus 4.5",
  "claude-3-haiku-20240307": "Claude 3 Haiku",
  // Google
  "gemini-3.1-flash-lite": "Gemini 3.1 Flash-Lite",
  "gemini-3.5-flash-lite": "Gemini 3.5 Flash-Lite",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
  "gemini-4-argon": "Gemini 4 Argon",
  "gemini-3.1-flash-lite-preview": "Gemini 3.1 Flash-Lite (preview)",
  "gemini-3-flash-preview": "Gemini 3 Flash",
  "gemini-3.1-flash-preview": "Gemini 3.1 Flash (preview)",
  "gemini-3.5-flash": "Gemini 3.5 Flash",
  "gemini-3.6-flash": "Gemini 3.6 Flash",
  "gemini-3.7-flash": "Gemini 3.7 Flash",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash-lite": "Gemini 2.5 Flash-Lite",
  // DeepSeek
  "deepseek-flash": "DeepSeek V4.1 Flash",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  // Z.ai
  "glm-5.3-flash": "GLM-5.3 Flash",
  "glm-5.3": "GLM-5.3",
  "glm-5.2": "GLM-5.2",
  "glm-4.7-flashx": "GLM-4.7 FlashX",
  // Moonshot
  "kimi-k2.6": "Kimi K2.6",
  "kimi-k3": "Kimi K3",
  // OpenAI
  "gpt-6-astra": "GPT-6 Astra",
  "gpt-6-sol": "GPT-6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-6.1-sol": "GPT-6.1 Sol",
  "gpt-6.1-terra": "GPT-6.1 Terra",
};

interface RetiredModel {
  provider: Provider;
  capabilityTier: CapabilityTier;
  /** Aliases that resolved to this id (primary, or as the Gemini 2.5 fallback). Empty = never resolved here. */
  formerAliases: ModelAlias[];
}

/**
 * Ids no alias resolves to any more, with the facts recorded at the time
 * (read from this repo's git history of MODEL_MAP and from the ids
 * content-generation-service stored in prod, 2026-10-18).
 *
 * The tier is the same vocabulary as MODEL_MAP and follows the same rule: it
 * describes the MODEL. Every Flash / Flash-Lite / Haiku is `cheap` whatever
 * alias carried it (the 3.5–3.7 Flash generations sat under `flash-pro`, like
 * 3.8 Flash does today).
 *
 * `claude-3-haiku-20240307` and `claude-opus-4-5` were never resolved by this
 * service: content-generation-service called Anthropic itself before it moved
 * onto /complete (Jan–Feb 2026), and its old emails still carry those ids.
 * `gemini-2.5-flash` / `-flash-lite` / `-pro` were the retry fallback of the Gemini 3
 * aliases (2026-04-03 → 2026-10-01); `gemini-2.5-flash` was also `flash`'s first
 * target (2026-04-01).
 */
export const RETIRED_MODELS: Record<string, RetiredModel> = {
  "claude-3-haiku-20240307": { provider: "anthropic", capabilityTier: "cheap", formerAliases: [] },
  "claude-opus-4-5": { provider: "anthropic", capabilityTier: "frontier", formerAliases: [] },
  "claude-haiku-4-5": { provider: "anthropic", capabilityTier: "cheap", formerAliases: ["haiku"] },
  "claude-sonnet-4-6": { provider: "anthropic", capabilityTier: "strong", formerAliases: ["sonnet"] },
  "claude-opus-4-6": { provider: "anthropic", capabilityTier: "frontier", formerAliases: ["opus"] },
  "gemini-3.1-flash-lite": { provider: "google", capabilityTier: "cheap", formerAliases: ["flash-lite"] },
  "gemini-3.1-flash-lite-preview": { provider: "google", capabilityTier: "cheap", formerAliases: ["flash-lite"] },
  "gemini-3-flash-preview": { provider: "google", capabilityTier: "cheap", formerAliases: ["flash"] },
  "gemini-3.1-flash-preview": { provider: "google", capabilityTier: "cheap", formerAliases: ["flash"] },
  "gemini-3.5-flash": { provider: "google", capabilityTier: "cheap", formerAliases: ["flash-pro"] },
  "gemini-3.6-flash": { provider: "google", capabilityTier: "cheap", formerAliases: ["flash-pro"] },
  "gemini-3.7-flash": { provider: "google", capabilityTier: "cheap", formerAliases: ["flash-pro"] },
  "gemini-2.5-flash": {
    provider: "google",
    capabilityTier: "cheap",
    formerAliases: ["flash", "flash-lite", "flash-pro"],
  },
  "gemini-2.5-pro": { provider: "google", capabilityTier: "strong", formerAliases: ["pro"] },
  "gemini-2.5-flash-lite": { provider: "google", capabilityTier: "cheap", formerAliases: ["flash"] },
  "deepseek-v4-flash": { provider: "deepseek", capabilityTier: "cheap", formerAliases: ["deepseek-flash"] },
  "deepseek-v4-pro": { provider: "deepseek", capabilityTier: "strong", formerAliases: ["deepseek-pro"] },
  "glm-5.2": { provider: "zai", capabilityTier: "strong", formerAliases: ["glm-pro"] },
  "glm-4.7-flashx": { provider: "zai", capabilityTier: "cheap", formerAliases: ["glm-flash"] },
  // LLM-HEADS-1027 (2026-10-27): heads moved to gpt-6.1-sol, gpt-6.1-terra.
  "gpt-6-sol": { provider: "openai", capabilityTier: "strong", formerAliases: ["gpt-sol"] },
  "gpt-5.6-terra": { provider: "openai", capabilityTier: "strong", formerAliases: ["gpt-terra"] },
};

export interface ModelIdEntry {
  modelId: string;
  displayName: string;
  provider: Provider;
  capabilityTier: CapabilityTier;
  servedToday: boolean;
  /** LLM dynasty slug (LLM-DYNASTY-1022): the vendor line this version belongs to. */
  dynasty: string;
  /**
   * Legacy aliases that run this model today (redirects to its dynasty). The
   * dynasty slug and the model id itself are callable too; they are not listed here.
   */
  aliases: ModelAlias[];
  formerAliases: ModelAlias[];
}

function dynastySlugOf(modelId: string): string {
  const dynasty = dynastyOfModel(modelId);
  if (!dynasty) throw new Error(`No LLM dynasty recorded for model id "${modelId}"`);
  return dynasty.slug;
}

/** The vendor's public name of a concrete model id ("Claude Sonnet 5.5"); throws on an unrecorded id. */
export function modelDisplayName(modelId: string): string {
  return displayNameOf(modelId);
}

function displayNameOf(modelId: string): string {
  const name = MODEL_DISPLAY_NAMES[modelId];
  if (!name) throw new Error(`No display name recorded for model id "${modelId}"`);
  return name;
}

/**
 * Every concrete model id, served today first (in PROVIDER_MODELS order), then
 * the retired ones. Throws when two aliases on one id disagree on its tier, or
 * when an id lacks a display name: a consumer must never get a guessed fact.
 */
export function modelIdCatalogue(): ModelIdEntry[] {
  const current = new Map<string, ModelIdEntry>();
  for (const dynasty of LLM_DYNASTIES) {
    if (!dynasty.servedToday) continue;
    const provider = dynasty.provider as Provider;
    const resolved = resolveModel(provider, dynasty.slug);
    if (RETIRED_MODELS[resolved.apiModelId]) {
      throw new Error(`"${resolved.apiModelId}" is served today and also listed as retired`);
    }
    if (current.has(resolved.apiModelId)) {
      throw new Error(`"${resolved.apiModelId}" is the head of two dynasties`);
    }
    const aliases = PROVIDER_MODELS[provider].filter(
      (name) => dynasty.legacyAliases.includes(name) && resolveModel(provider, name).apiModelId === resolved.apiModelId,
    );
    current.set(resolved.apiModelId, {
      modelId: resolved.apiModelId,
      displayName: displayNameOf(resolved.apiModelId),
      provider,
      capabilityTier: resolved.capabilityTier,
      servedToday: true,
      dynasty: dynastySlugOf(resolved.apiModelId),
      aliases,
      formerAliases: [],
    });
  }
  const retired = Object.entries(RETIRED_MODELS).map(([modelId, r]) => ({
    modelId,
    displayName: displayNameOf(modelId),
    provider: r.provider,
    capabilityTier: r.capabilityTier,
    servedToday: false,
    dynasty: dynastySlugOf(modelId),
    aliases: [],
    formerAliases: [...r.formerAliases],
  }));
  return [...current.values(), ...retired];
}

export interface DynastyEntry {
  slug: string;
  name: string;
  provider: Provider;
  capabilityTier: CapabilityTier;
  /** The newest version a current name serves (for a line nothing serves, its last version). */
  headModelId: string;
  /** True when `slug` answers /complete and runs `headModelId`. */
  servedToday: boolean;
  /** Every version, newest first, with its display name. */
  models: Array<{ modelId: string; displayName: string; servedToday: boolean }>;
  /** Names workflows wrote before dynasties; each answers /complete as a redirect to this dynasty's head. */
  legacyAliases: string[];
}

/**
 * Every LLM dynasty with its versions, newest first. Throws when a version has
 * no display name or a served head is not what the slug resolves to: a
 * consumer pooling per dynasty must never read a guessed fact.
 */
export function dynastyCatalogue(): DynastyEntry[] {
  return LLM_DYNASTIES.map((d) => {
    const provider = d.provider as Provider;
    const headModelId = d.models[0];
    if (d.servedToday && resolveModel(provider, d.slug).apiModelId !== headModelId) {
      throw new Error(`Dynasty "${d.slug}" resolves outside its head "${headModelId}"`);
    }
    return {
      slug: d.slug,
      name: d.name,
      provider,
      capabilityTier: d.capabilityTier,
      headModelId,
      servedToday: d.servedToday,
      models: d.models.map((modelId) => ({
        modelId,
        displayName: displayNameOf(modelId),
        servedToday: d.servedToday && modelId === headModelId,
      })),
      legacyAliases: [...d.legacyAliases],
    };
  });
}
