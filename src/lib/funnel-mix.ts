import { features } from "./declarations-client.js";

// ---------------------------------------------------------------------------
// A funnel is ONE kind: proactive or reactive (owner 2026-10-10). A funnel's
// budget caps ALL its pipes, so a reactive pipe WE run (AI meeting booking on a
// positive reply) inside a proactive funnel can starve the proactive part.
// The Copilot never campaigns or starts a MIXED funnel.
// Both the kind (`type`) and the verdict (`mixed`) are features-service's,
// served on every funnel; the Copilot never re-grades them from pipe modes
// (owner 2026-10-12: a pipe the customer's own team works, or a source
// answering inside another run, is no mix, and features-service is the one
// that knows it).
// ---------------------------------------------------------------------------

export class MixedFunnelError extends Error {
  constructor(public readonly funnelId: string) {
    super(
      `[funnel] features-service serves ${funnelId} as mixed: a proactive pipe and a reactive pipe we run in one funnel. ` +
        "A funnel's budget caps every pipe in it, so the reactive part can starve the proactive one. " +
        "Use one Proactive funnel (max budget / max volume) and, if the user wants replies handled, a separate Reactive funnel starting at the trigger step (asked as 'Up to $X' / 'Up to N' per period).",
    );
    this.name = "MixedFunnelError";
  }
}

export interface ServedFunnelKind {
  type: "proactive" | "reactive";
  /** features-service's own line: who works each leg, in order. Quoted to the user as what the funnel does. */
  line: string | null;
}

/**
 * Reads the funnel (features-service detail) and refuses a mixed one on the
 * SERVED verdict. Either `type` or `mixed` absent = a broken contract: fail loud.
 */
export async function assertFunnelNotMixed(salesFunnelId: string): Promise<ServedFunnelKind> {
  const funnel = (await features(
    "funnel_mix:read_funnel",
    "GET",
    `/internal/catalogue/sales-funnels/${encodeURIComponent(salesFunnelId)}`,
  )) as { type?: unknown; mixed?: unknown; line?: unknown };
  if (funnel.type !== "proactive" && funnel.type !== "reactive") {
    throw new Error(`[funnel] features-service served ${salesFunnelId} without its type (proactive | reactive)`);
  }
  if (typeof funnel.mixed !== "boolean") {
    throw new Error(`[funnel] features-service served ${salesFunnelId} without its mixed verdict`);
  }
  if (funnel.mixed) throw new MixedFunnelError(salesFunnelId);
  return { type: funnel.type, line: typeof funnel.line === "string" ? funnel.line : null };
}
