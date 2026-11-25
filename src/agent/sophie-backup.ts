import type { ToolCallRecord } from "../db/schema.js";
// ---------------------------------------------------------------------------
// Where Distry's turn runs when its model cannot serve.
//
// SOPHIE-HAIKU-BACKUP-1112 (prod 2026-11-11 18:59 UTC): the DeepSeek platform
// balance ran out and every Copilot turn failed, 47 client messages unanswered
// overnight. The fix was ONE fixed backup model (DeepSeek V4.1 Flash since
// SOPHIE-ON-HAIKU-1113).
//
// DISTRY-THINKING-1122 (owner 2026-11-22: « mettre dans l'ordre des fallbacks de
// Distry le meilleur model x thinking en terme de index/$ (dynamiquement), parmi
// les providers qu'on a, plutôt que DeepSeek »): the backup is now an ORDERED
// list read from the models panel (`rankFallbacks`, intelligence-index.ts):
// every model x thinking level Distry can run now with tools, best intelligence
// per dollar first, unscored models after. Nothing typed by hand.
//
// Two moments use it:
//   - before the turn: the configured model's vendor is out of credit (the
//     stored fact of vendor-credit.ts, red on Monitoring) = the turn starts on
//     the first candidate;
//   - during the turn: the model fails before any tool ran and before any word
//     reached the person = the turn runs again on the next candidate
//     (handleChatTurn in index.ts), each attempt on its own run, billed under
//     the model that ran. Fail loud only when no candidate is left.
// A Sophie turn never probes an empty vendor: the outage closes when any other
// call on that vendor succeeds.
//
// FALLBACK-REFUSED-1124 (owner 2026-11-24: « il faut prendre le deuxième
// meilleur quand ça arrive »): an EMPTY BALANCE moves EVERY chat config down
// this same order, before the turn and during it; only the retry on another
// kind of failure stays Distry's own.
// ---------------------------------------------------------------------------

import type { ModelAlias, Provider } from "../lib/anthropic.js";
import { fallbackKey, fallbackWords, type FallbackCandidate } from "../lib/intelligence-index.js";
import { isProviderOutOfCredit, PROVIDER_LABELS } from "../lib/vendor-credit.js";
import { SOPHIE_CONFIG_KEY } from "./sophie.js";

/** How many models a failing turn tries before it fails loud (the configured one included). */
export const MAX_DISTRY_ATTEMPTS = 4;

export interface SophieTurnModel {
  provider: Provider;
  modelAlias: ModelAlias;
  /** Set when the turn runs on a fallback: the configured model's provider. */
  backupFor: Provider | null;
  /** The fallback's thinking level (null = its default); only meaningful when `backupFor` is set. */
  backupLevel: string | null;
}

/** A failed attempt carried into the next one (index.ts re-runs the turn on the next candidate). */
export interface DistryAttempt {
  /** provider:modelId of every model this turn already tried. */
  tried: string[];
  /** The configured model's provider (the turn's `backupFor`). */
  primaryProvider: Provider;
  /** The model the next attempt runs on. */
  next: FallbackCandidate;
  /** The session and the user's message already stored by the first attempt (never stored twice). */
  sessionId: string;
  userMessageId: string;
  /**
   * The lookups this turn already made before a model went silent (COPILOT-LATENCY-1125): the next
   * model reads them (the `carried-work` part) and they are stored with the answer, never run twice.
   */
  carried: ToolCallRecord[];
}

/**
 * The model this turn runs on, for every chat config: a forced next candidate (a retry), else the first
 * fallback while the configured vendor is out of credit, else the configured model. `order` reads the
 * ranked list (only called when needed).
 */
export async function sophieTurnModel(
  configKey: string,
  primary: { provider: Provider; modelAlias: ModelAlias; modelId: string },
  order: (exclude: ReadonlySet<string>) => Promise<FallbackCandidate[]>,
  attempt?: DistryAttempt,
): Promise<SophieTurnModel> {
  const base = { provider: primary.provider, modelAlias: primary.modelAlias, backupFor: null, backupLevel: null };
  if (attempt) return toTurnModel(attempt.next, attempt.primaryProvider);
  if (!isProviderOutOfCredit(primary.provider)) return base;
  const [first] = await order(new Set([fallbackKey(primary.provider, primary.modelId)]));
  // No candidate serves: the turn runs on the configured model and fails loud.
  return first ? toTurnModel(first, primary.provider) : base;
}

function toTurnModel(c: FallbackCandidate, primaryProvider: Provider): SophieTurnModel {
  return { provider: c.provider, modelAlias: c.model as ModelAlias, backupFor: primaryProvider, backupLevel: c.level };
}

/**
 * What happens to a Distry turn on this provider right now, in words: null while it serves; else that its
 * vendor is out of credit (the stored fact, red on Monitoring) and that turns go down the fallback order.
 */
export function distryOutageSentence(provider: Provider): string | null {
  if (!isProviderOutOfCredit(provider)) return null;
  return `${PROVIDER_LABELS[provider]} is out of credit on our account (red on Monitoring): Distry's turns on it run on the next model of the fallback order until it serves again.`;
}

/**
 * Whether a failed turn runs again, and on which model (null = it fails loud). Distry on any failure, every
 * other config only when its vendor refused for an empty balance (`outOfCredit`); on our platform key (an
 * org's own key is the org's account), never a billing refusal, and only when the failure left nothing
 * behind: no tool ran, no word reached the person. At most MAX_DISTRY_ATTEMPTS models.
 */
export async function nextDistryAttempt(args: {
  configKey: string;
  platformKey: boolean;
  billingRefusal: boolean;
  sessionId: string | null;
  userMessageId: string | null;
  toolCount: number;
  textSent: boolean;
  failed: { provider: Provider; modelId: string };
  /** The failure is our platform key refused for an empty balance. */
  outOfCredit?: boolean;
  /**
   * The model went silent past the turn's limit (`VendorSilentError`): the turn moves on even after
   * tools ran, carrying what they returned (`carried`), as long as no word reached the person.
   */
  silentModel?: boolean;
  /** The lookups made so far this turn (carried ones included), kept for the next model. */
  carried?: ToolCallRecord[];
  previous?: DistryAttempt;
  order: (exclude: ReadonlySet<string>) => Promise<FallbackCandidate[]>;
}): Promise<DistryAttempt | null> {
  const { configKey, platformKey, billingRefusal, sessionId, userMessageId, toolCount, textSent, failed, previous, order } = args;
  if ((configKey !== SOPHIE_CONFIG_KEY && !args.outOfCredit) || !platformKey || billingRefusal || !sessionId || !userMessageId || textSent) return null;
  if (toolCount > 0 && !args.silentModel) return null;
  const tried = [...(previous?.tried ?? []), fallbackKey(failed.provider, failed.modelId)];
  if (tried.length >= MAX_DISTRY_ATTEMPTS) return null;
  const [next] = await order(new Set(tried));
  if (!next) return null;
  return { tried, primaryProvider: previous?.primaryProvider ?? failed.provider, next, sessionId, userMessageId, carried: args.carried ?? previous?.carried ?? [] };
}

/** The log line of a turn moving to a fallback. */
export function fallbackLine(c: FallbackCandidate): string {
  return fallbackWords(c);
}
