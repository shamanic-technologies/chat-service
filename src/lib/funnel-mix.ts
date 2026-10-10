import { features } from "./declarations-client.js";

// ---------------------------------------------------------------------------
// A funnel is ONE kind: proactive or reactive (owner 2026-10-10). A funnel's
// budget caps ALL its pipes, so a reactive pipe (AI meeting booking on a
// positive reply) inside a proactive funnel can starve the proactive part.
// The Copilot never composes, campaigns or starts a MIXED funnel: one
// Proactive funnel (max budget / max volume), and if the user wants replies
// handled, a separate Reactive funnel starting at the trigger step.
// The pipes' `mode` is features-service's; a bare leg (the buyer acts) counts
// for nothing.
// ---------------------------------------------------------------------------

export class MixedFunnelError extends Error {
  constructor(public readonly funnelId: string, proactive: string[], reactive: string[]) {
    super(
      `[funnel] ${funnelId} mixes proactive pipes (${proactive.join(", ")}) and reactive pipes (${reactive.join(", ")}). ` +
        "A funnel's budget caps every pipe in it, so the reactive part can starve the proactive one. " +
        "Use one Proactive funnel (max budget / max volume) and, if the user wants replies handled, a separate Reactive funnel starting at the trigger step (asked as 'Up to $X' / 'Up to N' per period).",
    );
    this.name = "MixedFunnelError";
  }
}

export interface PipeModeLite {
  id: string;
  mode?: unknown;
}

/** PURE: the proactive and reactive pipe ids among a funnel's pipes. */
export function splitByMode(pipes: readonly PipeModeLite[]): { proactive: string[]; reactive: string[] } {
  return {
    proactive: pipes.filter((p) => p.mode === "proactive").map((p) => p.id),
    reactive: pipes.filter((p) => p.mode === "reactive").map((p) => p.id),
  };
}

/** PURE: throws MixedFunnelError when the pipes hold both modes. */
export function assertNotMixed(funnelId: string, pipes: readonly PipeModeLite[]): void {
  const { proactive, reactive } = splitByMode(pipes);
  if (proactive.length > 0 && reactive.length > 0) throw new MixedFunnelError(funnelId, proactive, reactive);
}

/**
 * Reads the funnel (features-service detail) and refuses a mixed one. The
 * funnel's kind is features-service's served `type` (proactive when any pipe
 * is proactive), never re-derived here; a funnel of `type` proactive that
 * still carries a reactive pipe is the mix this rule forbids.
 */
export async function assertFunnelNotMixed(salesFunnelId: string): Promise<"proactive" | "reactive"> {
  const funnel = (await features(
    "funnel_mix:read_funnel",
    "GET",
    `/internal/catalogue/sales-funnels/${encodeURIComponent(salesFunnelId)}`,
  )) as { type?: unknown; legs?: Array<{ pipe: PipeModeLite | null }> };
  if (funnel.type !== "proactive" && funnel.type !== "reactive") {
    throw new Error(`[funnel] features-service served ${salesFunnelId} without its type (proactive | reactive)`);
  }
  if (!Array.isArray(funnel.legs)) throw new Error(`[funnel] features-service served ${salesFunnelId} without legs`);
  const pipes = funnel.legs.flatMap((l) => (l.pipe ? [l.pipe] : []));
  const offType = pipes.filter((p) => p.mode !== undefined && p.mode !== funnel.type);
  if (offType.length > 0) assertNotMixed(salesFunnelId, pipes);
  return funnel.type;
}
