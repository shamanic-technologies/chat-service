import { resolveModel, type Provider } from "./anthropic.js";
import { LLM_DYNASTIES, dynastyOfModel, type DynastyProvider } from "./llm-dynasties.js";

/**
 * Every LLM cost name this service (or the caller before it moved onto
 * /complete) ever wrote to runs-service → the concrete model(s) and the LLM
 * dynasty that made it (LLM-RATING-PER-ENGINE-1112, owner 2026-11-12: the
 * Rating rates LLMs per Engine, seeded from every past call).
 *
 * Served as EXACT names so no consumer parses a cost name: a prefix is a string
 * we move whenever a vendor renames a model, and prefixes nest
 * (`zai-glm-5.3-` is a prefix of `zai-glm-5.3-flash-tokens-input`).
 *
 * A retired model's prefixes are NEVER dropped: its spend stays attributable.
 * A served head's current `costPrefix` must be listed here (test-enforced), so a
 * head move that forgets this file fails the build, not the consumer.
 */

/**
 * Cost-name prefixes each concrete model billed under, read from this repo's
 * git history of MODEL_MAP / the Gemini cost map and from runs-service's
 * stored cost names (2026-11-12). An empty list = the model is known (it names
 * stored generations) but no cost row under our names ever carried it.
 */
export const MODEL_COST_PREFIXES: Record<string, readonly string[]> = {
  // Anthropic
  "claude-haiku-5-5": ["anthropic-haiku-5.5"],
  "claude-haiku-4-5": ["anthropic-haiku-4.5"],
  // Called by content-generation-service itself before /complete; no cost row under our names.
  "claude-3-haiku-20240307": [],
  "claude-sonnet-5-5": ["anthropic-sonnet-5.5"],
  "claude-sonnet-4-6": ["anthropic-sonnet-4.6"],
  "claude-opus-5-5": ["anthropic-opus-5.5"],
  "claude-opus-4-6": ["anthropic-opus-4.6"],
  // Written by content-generation-service (Feb 2026) before it moved onto /complete.
  "claude-opus-4-5": ["anthropic-opus-4.5"],
  "claude-fable-5-2": ["anthropic-fable-5.2"],
  "claude-fable-5-1": ["anthropic-fable-5.1"],
  // Google. Preview and GA of 3.1 Flash-Lite billed under ONE prefix.
  "gemini-3.5-flash-lite": ["google-flash-lite-3.5"],
  "gemini-3.1-flash-lite": ["google-flash-lite-3.1"],
  "gemini-3.1-flash-lite-preview": ["google-flash-lite-3.1"],
  "gemini-2.5-flash-lite": ["google-flash-lite-2.5"],
  "gemini-3.8-flash": ["google-flash-3.8"],
  "gemini-3.7-flash": ["google-flash-3.7"],
  "gemini-3.6-flash": ["google-flash-3.6"],
  "gemini-3.5-flash": ["google-flash-3.5"],
  "gemini-3.1-flash-preview": ["google-flash-3.1"],
  // `gemini-3-flash` = content-generation-service's own name (Feb 2026).
  "gemini-3-flash-preview": ["google-flash-3", "google-flash-3.0", "gemini-3-flash"],
  "gemini-2.5-flash": ["google-flash-2.5"],
  "gemini-3.1-pro-preview": ["google-pro-3.1"],
  "gemini-2.5-pro": ["google-pro-2.5"],
  "gemini-4-argon": ["google-argon-4"],
  // DeepSeek. `deepseek-flash` is V4.1 Flash (wire id and cost prefix differ on purpose).
  "deepseek-flash": ["deepseek-v4.1-flash"],
  "deepseek-v4-flash": ["deepseek-v4-flash"],
  "deepseek-v4-pro": ["deepseek-v4-pro"],
  // Z.ai
  "glm-5.3-flash": ["zai-glm-5.3-flash"],
  "glm-4.7-flashx": ["zai-glm-4.7-flashx"],
  "glm-5.3": ["zai-glm-5.3"],
  "glm-5.2": ["zai-glm-5.2"],
  // Moonshot
  "kimi-k2.6": ["moonshot-kimi-k2.6"],
  "kimi-k3.1-pro": ["moonshot-kimi-k3.1-pro"],
  "kimi-k3": ["moonshot-kimi-k3"],
  // OpenAI
  "gpt-6-astra": ["openai-gpt-6-astra"],
  "gpt-6.1-sol": ["openai-gpt-6.1-sol"],
  "gpt-6-sol": ["openai-gpt-6-sol"],
  "gpt-6.1-terra": ["openai-gpt-6.1-terra"],
  "gpt-5.6-terra": ["openai-gpt-5.6-terra"],
};

/**
 * The billed dimensions each vendor's names carry, and the segments that sit
 * between the prefix and the dimension (pricing regime, long-context tier).
 * A superset of what was written: a listed name never billed is harmless, a
 * missing one is an unattributable cost.
 */
const VENDOR_NAME_SHAPES: Record<DynastyProvider, { segments: readonly string[]; dimensions: readonly string[] }> = {
  anthropic: {
    segments: ["", "-long-context"],
    dimensions: ["tokens-input", "tokens-cached-input", "tokens-cache-write-5m", "tokens-output"],
  },
  google: {
    segments: ["", "-long-context"],
    dimensions: ["tokens-input", "tokens-cached-input", "tokens-output", "tokens-text-output"],
  },
  deepseek: {
    segments: ["", "-peak", "-off-peak"],
    dimensions: ["tokens-input", "tokens-cached-input", "tokens-output"],
  },
  zai: { segments: [""], dimensions: ["tokens-input", "tokens-cached-input", "tokens-output"] },
  moonshot: { segments: [""], dimensions: ["tokens-input", "tokens-cached-input", "tokens-output"] },
  openai: {
    segments: ["", "-long-context"],
    dimensions: ["tokens-input", "tokens-cached-input", "tokens-cache-write", "tokens-output"],
  },
};

export interface LlmCostNameEntry {
  costName: string;
  /** LLM dynasty slug (same slugs as `/internal/model-dynasties`). */
  dynasty: string;
  provider: DynastyProvider;
  /** Concrete model id(s) billed under this name; several only when a vendor's preview and GA shared one name. */
  modelIds: string[];
}

/**
 * Every LLM cost name → dynasty + model ids, sorted by name. Throws when a
 * name would map to two dynasties, a dynasty model has no recorded prefixes
 * entry, or a prefix is recorded for a model outside every dynasty.
 */
export function llmCostNameCatalogue(): LlmCostNameEntry[] {
  const byName = new Map<string, LlmCostNameEntry>();
  for (const [modelId, prefixes] of Object.entries(MODEL_COST_PREFIXES)) {
    const dynasty = dynastyOfModel(modelId);
    if (!dynasty) throw new Error(`Cost prefixes recorded for "${modelId}", which no LLM dynasty carries`);
    const shape = VENDOR_NAME_SHAPES[dynasty.provider];
    for (const prefix of prefixes) {
      for (const segment of shape.segments) {
        for (const dimension of shape.dimensions) {
          const costName = `${prefix}${segment}-${dimension}`;
          const existing = byName.get(costName);
          if (!existing) {
            byName.set(costName, { costName, dynasty: dynasty.slug, provider: dynasty.provider, modelIds: [modelId] });
          } else if (existing.dynasty !== dynasty.slug) {
            throw new Error(`Cost name "${costName}" maps to two dynasties: ${existing.dynasty}, ${dynasty.slug}`);
          } else if (!existing.modelIds.includes(modelId)) {
            existing.modelIds.push(modelId);
          }
        }
      }
    }
  }
  for (const d of LLM_DYNASTIES) {
    for (const modelId of d.models) {
      if (!MODEL_COST_PREFIXES[modelId]) throw new Error(`No cost prefixes recorded for "${modelId}" (${d.slug})`);
    }
    if (d.servedToday) {
      const head = resolveModel(d.provider as Provider, d.slug);
      if (!MODEL_COST_PREFIXES[head.apiModelId]?.includes(head.costPrefix)) {
        throw new Error(`Head "${head.apiModelId}" bills under "${head.costPrefix}", not recorded in MODEL_COST_PREFIXES`);
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.costName.localeCompare(b.costName));
}
