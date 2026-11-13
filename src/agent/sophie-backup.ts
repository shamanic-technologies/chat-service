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
import { isProviderOutOfCredit } from "../lib/vendor-credit.js";
import { SOPHIE_CONFIG_KEY, SOPHIE_MODEL } from "./sophie.js";

/** Reasoning "on" = no reasoning-off field sent (the vendor's default), as measured. */
export const SOPHIE_BACKUP_MODEL = { provider: "deepseek", model: "deepseek-flash", reasoning: "on" } as const;

export interface SophieTurnModel {
  provider: Provider;
  modelAlias: ModelAlias;
  /** Set when the turn runs on the backup: the provider that is out of credit. */
  backupFor: Provider | null;
}

/** The model this turn runs on: the config's, or the backup while Sophie's vendor is out of credit. */
export function sophieTurnModel(configKey: string, primary: { provider: Provider; modelAlias: ModelAlias }): SophieTurnModel {
  const isSophie = configKey === SOPHIE_CONFIG_KEY && primary.provider === SOPHIE_MODEL.provider;
  if (isSophie && isProviderOutOfCredit(primary.provider)) {
    return { provider: SOPHIE_BACKUP_MODEL.provider as Provider, modelAlias: SOPHIE_BACKUP_MODEL.model as ModelAlias, backupFor: primary.provider };
  }
  return { ...primary, backupFor: null };
}
