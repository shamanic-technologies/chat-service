/**
 * Post a call's ACTUAL cost, then release its provisioned hold.
 *
 * When the actual post fails, the hold stays and is what the org is charged:
 * a size estimate (the whole prompt at the uncached rate + an output guess),
 * usually above the real cost. Prod 2026-11-01 (CHAT-COST-1101): six Copilot
 * turns of one new client kept $2.46 of holds because costs-service answered
 * 500 for a few seconds (its database had no free connection), and nothing
 * ever posted the real cost.
 *
 * So the post is retried, but ONLY on the refusal that proves nothing was
 * written: runs-service answering that costs-service is unavailable (it prices
 * a line BEFORE storing it). Any other failure is not retried, because the
 * lines may already be stored and a second post would bill them twice.
 */
export const RECONCILE_RETRY_DELAYS_MS: readonly number[] = [2_000, 10_000, 30_000];

export function isUnwrittenCostRefusal(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /costs-service unavailable/i.test(msg);
}

export interface ReconcileDeps {
  postActual: () => Promise<unknown>;
  releaseHolds: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  delaysMs?: readonly number[];
}

/** Throws the last error when the actual post never lands (the hold then stays, as before). */
export async function reconcileProvisionedCosts(deps: ReconcileDeps): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delays = deps.delaysMs ?? RECONCILE_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      await deps.postActual();
      break;
    } catch (err) {
      if (attempt >= delays.length || !isUnwrittenCostRefusal(err)) throw err;
      await sleep(delays[attempt]);
    }
  }
  await deps.releaseHolds();
}
