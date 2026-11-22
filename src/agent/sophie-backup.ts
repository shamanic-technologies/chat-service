// ---------------------------------------------------------------------------
// Sophie's backup model (SOPHIE-HAIKU-BACKUP-1112, owner 2026-11-12 « Utilise
// Haiku en secours pour Sophie »; mirrored by SOPHIE-ON-HAIKU-1113 when Haiku
// became her model).
//
// Prod 2026-11-11 18:59 UTC: the DeepSeek platform balance ran out, and every
// Copilot turn (web, WhatsApp, Telegram, Lead event answers) failed: 47 client
// messages unanswered overnight. While her model's vendor is out of credit
// (the stored fact of vendor-credit.ts, red on Monitoring), her WHOLE turn runs
// on the other measured model: same prompt, skills, tools and briefs, that
// vendor's own cost names. Since 2026-11-13 her model is Claude Haiku 5.5 and
// the backup is DeepSeek V4.1 Flash with reasoning on (54.9% of replies on the
// equal-conditions bake-off vs 51.0% for Haiku low): never no answer.
//
// A Sophie turn never probes the empty vendor (a probe would be a failed reply
// for a client): the outage closes when any other call on that vendor succeeds
// (/complete callers probe it every PROBE_INTERVAL_MS), then her turns return
// to her model.
// ---------------------------------------------------------------------------

import type { ModelAlias, Provider } from "../lib/anthropic.js";
import { modelDisplayName } from "../lib/model-ids.js";
import { resolveModel } from "../lib/anthropic.js";
import { isProviderOutOfCredit, PROVIDER_LABELS } from "../lib/vendor-credit.js";
import { SOPHIE_CONFIG_KEY } from "./sophie.js";

/** Reasoning "on" = no reasoning-off field sent (the vendor's default), as measured. */
export const SOPHIE_BACKUP_MODEL = { provider: "deepseek", model: "deepseek-flash", reasoning: "on" } as const;

export interface SophieTurnModel {
  provider: Provider;
  modelAlias: ModelAlias;
  /** Set when the turn runs on the backup: the provider that is out of credit. */
  backupFor: Provider | null;
}

/**
 * The model this turn runs on: the config's, or the backup while Sophie's vendor is out of credit.
 * Any vendor staff set Distry to (DISTRY-ALL-MODELS-1122), not only Anthropic; the backup's own
 * vendor has no backup (its outage fails the turn loud).
 */
export function sophieTurnModel(configKey: string, primary: { provider: Provider; modelAlias: ModelAlias }): SophieTurnModel {
  const isSophie = configKey === SOPHIE_CONFIG_KEY && primary.provider !== SOPHIE_BACKUP_MODEL.provider;
  if (isSophie && isProviderOutOfCredit(primary.provider)) {
    return { provider: SOPHIE_BACKUP_MODEL.provider as Provider, modelAlias: SOPHIE_BACKUP_MODEL.model as ModelAlias, backupFor: primary.provider };
  }
  return { ...primary, backupFor: null };
}

/**
 * What happens to a Distry turn on this provider right now, in words: null while it serves; else that its
 * vendor is out of credit (the stored fact, red on Monitoring) and where the turn runs meanwhile.
 */
export function distryOutageSentence(provider: Provider): string | null {
  if (!isProviderOutOfCredit(provider)) return null;
  const label = PROVIDER_LABELS[provider];
  if (provider === SOPHIE_BACKUP_MODEL.provider) {
    return `${label} is out of credit on our account (red on Monitoring): a Distry turn on it fails until it serves again.`;
  }
  const backup = modelDisplayName(resolveModel(SOPHIE_BACKUP_MODEL.provider, SOPHIE_BACKUP_MODEL.model).apiModelId);
  return `${label} is out of credit on our account (red on Monitoring): Distry's turns run on ${backup} until it serves again.`;
}
