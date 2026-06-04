import type { Provider, ModelAlias } from "./anthropic.js";

// ---------------------------------------------------------------------------
// Chat config default resolution + registration merge semantics.
//
// Gemini is the platform default for /chat (the Anthropic platform key has no
// credit balance). A config row with NULL provider/model resolves to
// google/flash-pro here — NOT anthropic/sonnet — so the default survives every
// app re-registration and redeploy without depending on a manual DB flip.
//
// flash-pro (Gemini 3.5 Flash) is the mid-tier dashboard default (DIS-130).
// The agentic `workflow` chat is deliberately pinned to `pro` via an explicit
// platform_configs row (provider/model NOT NULL), so the heaviest tool-calling
// mode keeps the strongest model regardless of this NULL-config default.
// ---------------------------------------------------------------------------

/** Provider used when a chat config row leaves `provider` NULL. */
export const DEFAULT_CHAT_PROVIDER: Provider = "google";

/** Per-provider model alias used when a chat config row leaves `model` NULL. */
export function defaultModelAliasFor(provider: Provider): ModelAlias {
  return provider === "anthropic" ? "sonnet" : "flash-pro";
}

/**
 * Resolve the (provider, modelAlias) pair a chat request should use from its
 * stored config row. NULL provider → google; NULL model → the provider's
 * default alias.
 */
export function resolveChatProviderModel(appConfig: {
  provider: string | null;
  model: string | null;
}): { provider: Provider; modelAlias: ModelAlias } {
  const provider = (appConfig.provider ?? DEFAULT_CHAT_PROVIDER) as Provider;
  const modelAlias = (appConfig.model ?? defaultModelAliasFor(provider)) as ModelAlias;
  return { provider, modelAlias };
}

export interface ConfigConflictSetInput {
  systemPrompt: string;
  allowedTools: string[];
  /** Omitted (undefined) means "leave the stored value unchanged". */
  provider?: "anthropic" | "google";
  /** Omitted (undefined) means "leave the stored value unchanged". */
  model?: string;
}

export interface ConfigConflictSet {
  systemPrompt: string;
  allowedTools: string[];
  provider?: "anthropic" | "google";
  model?: string;
}

/**
 * Build the `onConflictDoUpdate.set` payload for a config re-registration.
 *
 * `provider`/`model` are included ONLY when the caller actually supplied them.
 * An omitted field is left out of the SET so the existing stored value is
 * preserved — a registering app that doesn't send `provider` no longer clobbers
 * an explicit override back to NULL.
 */
export function buildConfigConflictSet(input: ConfigConflictSetInput): ConfigConflictSet {
  const set: ConfigConflictSet = {
    systemPrompt: input.systemPrompt,
    allowedTools: input.allowedTools,
  };
  if (input.provider !== undefined) set.provider = input.provider;
  if (input.model !== undefined) set.model = input.model;
  return set;
}
