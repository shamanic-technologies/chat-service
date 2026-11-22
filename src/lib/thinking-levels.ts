// ---------------------------------------------------------------------------
// The thinking levels a /chat turn can run a model at, every provider
// (DISTRY-THINKING-1122, owner 2026-11-22: he picked GPT-6.1 Terra at Medium in
// the Distry models panel and Distry kept running it with reasoning off).
//
// One answer per (provider, concrete model), read from the data each provider
// already keeps, never a per-model branch here:
//   anthropic  `output_config.effort` on the models that honour it (ANTHROPIC_EFFORT_MODELS)
//   google     `thinkingLevel`, the model's recorded floor and up (GEMINI_3_THINKING_FLOOR)
//   vendors    `VENDORS[...].thinkingLevels` (probed live with a tool call)
// Levels are Artificial Analysis's words (`none` = its "Non-reasoning"), so the
// models panel matches each scored variant to a level as is.
// ---------------------------------------------------------------------------

import { ANTHROPIC_EFFORTS } from "../schemas.js";
import { anthropicAcceptsEffort, type Provider } from "./anthropic.js";
import { geminiThinkingLevels } from "./gemini.js";
import { isVendorProvider, VENDORS } from "./openai-compatible.js";

/** Every level /chat can run this model at, with tools (empty = its default only). */
export function chatThinkingLevels(provider: Provider, modelId: string): readonly string[] {
  if (provider === "anthropic") return anthropicAcceptsEffort(modelId) ? ANTHROPIC_EFFORTS : [];
  if (provider === "google") return geminiThinkingLevels(modelId);
  if (isVendorProvider(provider)) return VENDORS[provider].thinkingLevels?.[modelId] ?? [];
  return [];
}

/** How a level is said to a person ("none" = reasoning off). */
export function levelWords(level: string): string {
  return level === "none" ? "reasoning off" : level;
}

/**
 * Why this model cannot run at `level` on /chat, in plain words; null = it can.
 * The sentence the models panel shows instead of a working-looking button.
 */
export function thinkingLevelRefusal(provider: Provider, modelId: string, displayName: string, level: string): string | null {
  const levels = chatThinkingLevels(provider, modelId);
  if (levels.includes(level)) return null;
  if (levels.length === 0) {
    if (provider === "google") return `${displayName} takes a thinking budget, not a level: Distry runs it at its default.`;
    return `No thinking level of ${displayName} has been tested with tools yet: Distry runs it at its default.`;
  }
  return `Distry can run ${displayName} at ${levels.map(levelWords).join(", ")} only, not at ${levelWords(level)}.`;
}
