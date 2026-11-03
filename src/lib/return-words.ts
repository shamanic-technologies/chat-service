/**
 * The ONLY two returns a client is ever told (ROI-CONSISTENCY-1103, owner 2026-11-03: a return
 * exists only where a value lands):
 *  1. EXPECTED: features-service `expectedReturn.roiMultiple` (campaign, offer, brand), always said "Expected".
 *  2. REALIZED: features-service `costEconomics.realizedReturn` = revenue of the Paid clients our
 *     outreach caused over money actually spent, whole history.
 * Retired, never stated again: the pipeline-based `costEconomics.roiMultiple`, its flash / mature
 * variants ("so far, still learning"), % CAC, $ CAC, and any per pipe / workflow / step / channel /
 * audience return. Every sentence of this service that states a return is built here.
 *
 * "Expected 18x · no paid client yet ($94 spent)" (brand Beyond Logic, before: "30x so far (still learning, not mature)").
 */

export interface ExpectedReturnBody {
  roiMultiple?: number | null;
  unavailableReason?: string | null;
}

export interface RealizedReturnBody {
  closedWonCount?: number | null;
  closedWonRevenueUsd?: number | null;
  roiMultiple?: number | null;
  spentUsd?: number | null;
}

/** As the dashboard prints it: whole from 10x, else one decimal ("2.4x", "18x"). */
export function multipleWords(x: number): string {
  return `${x >= 10 ? Math.round(x) : Number(x.toFixed(1))}x`;
}

/** As the dashboard prints it: whole dollars from $10, else cents ("$94", "$4.20"). */
export function moneyWords(usd: number): string {
  return usd >= 10 ? `$${Math.round(usd).toLocaleString("en-US")}` : `$${usd.toFixed(2)}`;
}

const EXPECTED_UNAVAILABLE: Record<string, string> = {
  expected_model_unavailable: "could not be read right now",
  expected_model_computing: "being computed, ready on the next read",
  no_priced_sales_path: "no path we can price yet",
  own_sales_path_unpriced: "this funnel's path has no price yet",
};

/** "Expected 18x", or why there is none. Null when features-service served no expected return at all. */
export function expectedReturnWords(er: ExpectedReturnBody | null | undefined): string | null {
  if (!er || typeof er !== "object") return null;
  if (typeof er.roiMultiple === "number") return `Expected ${multipleWords(er.roiMultiple)}`;
  const why = er.unavailableReason ? (EXPECTED_UNAVAILABLE[er.unavailableReason] ?? er.unavailableReason) : "not served";
  return `Expected return not known (${why})`;
}

/**
 * "no paid client yet ($94 spent)" / "Realized 3.1x: 2 paid clients worth $8,000 for $2,600 spent".
 * Null when this read did not measure it (features-service serves null, or a block without `spentUsd`,
 * which is the retired mature-cohort basis): never a guess.
 */
export function realizedReturnWords(rr: RealizedReturnBody | null | undefined): string | null {
  if (!rr || typeof rr !== "object" || typeof rr.spentUsd !== "number" || typeof rr.closedWonCount !== "number") return null;
  const spent = `${moneyWords(rr.spentUsd)} spent`;
  if (rr.closedWonCount === 0) return `no paid client yet (${spent})`;
  const clients = `${rr.closedWonCount} paid client${rr.closedWonCount === 1 ? "" : "s"}`;
  const worth = typeof rr.closedWonRevenueUsd === "number" ? ` worth ${moneyWords(rr.closedWonRevenueUsd)}` : "";
  if (typeof rr.roiMultiple !== "number") return `${clients}${worth}, nothing spent yet`;
  return `Realized ${multipleWords(rr.roiMultiple)}: ${clients}${worth} for ${spent}`;
}

/** Both returns in one line, the expected first: "Expected 18x · no paid client yet ($94 spent)". */
export function returnLine(er: ExpectedReturnBody | null | undefined, rr: RealizedReturnBody | null | undefined): string {
  const parts = [expectedReturnWords(er), realizedReturnWords(rr)].filter((p): p is string => p !== null);
  return parts.length ? parts.join(" · ") : "no return served yet";
}
