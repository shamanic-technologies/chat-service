// ---------------------------------------------------------------------------
// Eval replies on Claude Code (EVAL-SPEND-CAP-1121, owner 2026-11-22: replies
// at $0, Jev kept as the judge, « max per month? » → $1, all of it Jev's).
// A replay's turn is answered by a Mac runner (the distribute app running
// `claude -p` on the subscription) through the local-runner queue /chat uses
// for a declaring org (LOCAL-CLAUDE-1116). The eval runner picks the declaring
// org whose runner was seen most recently, or the one named with --local-org;
// no runner seen lately = the run is refused before anything is queued.
// ---------------------------------------------------------------------------

import type { LocalLlmStore } from "../lib/local-llm-store.js";
import { resolveModel, type ModelAlias, type Provider } from "../lib/anthropic.js";

/** A runner not seen within this long is not answering: the run is refused rather than waiting out every replay. */
export const RUNNER_SEEN_WITHIN_MS = 10 * 60_000;

export async function pickRunnerOrg(store: LocalLlmStore, now: Date, requested?: string): Promise<{ orgId: string; runner: string }> {
  const ids = requested ? [requested] : await store.listDeclaredOrgIds();
  const rows = (await Promise.all(ids.map((id) => store.getOrg(id)))).filter((r) => r && r.declared && r.runnerLastSeenAt);
  rows.sort((a, b) => b!.runnerLastSeenAt!.getTime() - a!.runnerLastSeenAt!.getTime());
  const best = rows[0];
  if (!best || now.getTime() - best.runnerLastSeenAt!.getTime() > RUNNER_SEEN_WITHIN_MS) {
    const seen = best?.runnerLastSeenAt?.toISOString() ?? "never";
    throw new Error(
      `[evals] replies run on Claude Code at $0 and no Mac runner answered lately (${requested ? `org ${requested}` : "any declaring org"}: last seen ${seen}). ` +
        "Open the distribute app on the Mac (Claude Code signed in), then run again.",
    );
  }
  return { orgId: best.orgId, runner: `${best.runnerName ?? "runner"} ${best.runnerVersion ?? ""}`.trim() };
}

/** The Claude model a replay asks Claude Code for: a full Claude id, never another vendor (replies at $0 are Claude Code's). */
export function claudeCodeModel(provider: string, model: string, override?: string): string {
  if (override) {
    if (!override.startsWith("claude-")) throw new Error(`[evals] --local-model must be a Claude model id, got "${override}"`);
    return override;
  }
  if (provider !== "anthropic") {
    throw new Error(`[evals] replies run on Claude Code only ($0, owner 2026-11-22): "${provider}/${model}" is not a Claude model; pass --local-model claude-...`);
  }
  return resolveModel(provider as Provider, model as ModelAlias).apiModelId;
}
