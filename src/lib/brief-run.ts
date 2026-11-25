// Which run a client-brief website read rides (COPILOT-LATENCY-1125).

/**
 * The brand ids a run carries, from its `x-brand-id` header (comma-separated).
 */
export function brandIdsOfHeader(header: string | undefined): string[] {
  return (header ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Whether a read of `brandId`'s website may run under the turn's run.
 * runs-service refuses a child run whose brandIds differ from its parent's
 * (409 "Parent-child field conflict"): prod 2026-11-25, the Copilot on the
 * distribute.you brand read the org's other brand under its turn run, brand-
 * service's /complete was refused three times a turn and ~20 s went by before
 * the first model call (COPILOT-LATENCY-1125). Only a turn run with no brand,
 * or with exactly this one, can parent it; any other read gets its own run.
 */
export function briefReadsOnTurnRun(turnRunBrandIds: string[], brandId: string): boolean {
  return turnRunBrandIds.length === 0 || (turnRunBrandIds.length === 1 && turnRunBrandIds[0] === brandId);
}
