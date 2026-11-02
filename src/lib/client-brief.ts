// ---------------------------------------------------------------------------
// The client brief (SOPHIE-JCURVE-1102, prod 2026-11-01).
//
// A returning signup (Jcurve, a NetSuite partner) opened the Copilot and got
// "The one piece I cannot invent is what Jcurve sells and who buys it": the
// brand carried its website, but nothing the Copilot read before answering said
// what the company sells (offer description null, no profile), so it asked the
// client. What we can read, we never ask (owner).
//
// Before a turn that speaks for us to an account holder, chat-service reads the
// account's brands, their offers and, from each brand's own website (brand-
// service extract-fields, cached 30 days per brand), what it sells and who buys
// it. The block joins the turn's context (after the user's message on the
// cache-priced models, never the cached system prompt): the agent starts from
// it and proposes the next step. A read that fails is SAID in the block, never
// dropped: the agent then knows the gap is ours, not the client's.
// ---------------------------------------------------------------------------

/** Brands described per turn: an account rarely has more, and each costs a read. */
export const CLIENT_BRIEF_MAX_BRANDS = 3;
const MAX_OFFERS_PER_BRAND = 5;
/**
 * A first read of a site scrapes it (seconds to tens of seconds); brand-service
 * keeps going past our timeout and caches it, so the next turn reads it at once.
 */
export const CLIENT_BRIEF_SITE_TIMEOUT_MS = 40_000;

/** extract-fields keys + descriptions: stable strings, they key brand-service's 30-day cache. */
export const CLIENT_BRIEF_FIELDS = [
  {
    key: "whatTheySell",
    description:
      "What this company sells: its products or services, in two or three plain sentences, as its own website states them.",
  },
  {
    key: "whoBuys",
    description:
      "Who buys from this company: the kinds of companies or people it sells to (industry, size, role, country), as its website shows. One or two sentences.",
  },
] as const;

export interface BriefBrand {
  id: string;
  name: string | null;
  website: string | null;
  offers: Array<{ name: string; description: string | null }>;
  /** Read from the brand's website; `error` when the read failed this turn. */
  site: { whatTheySell: string | null; whoBuys: string | null } | { error: string };
}

export interface ClientBriefDeps {
  listBrands: () => Promise<unknown>;
  listOffers: (brandId: string) => Promise<unknown>;
  readWebsite: (brandId: string) => Promise<{ whatTheySell: string | null; whoBuys: string | null }>;
}

function asText(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (Array.isArray(v)) {
    const parts = v.map(asText).filter((x): x is string => Boolean(x));
    return parts.length > 0 ? parts.join("; ") : null;
  }
  if (v && typeof v === "object") return JSON.stringify(v);
  return null;
}

/** The two answers out of a brand-service extract-fields response. */
export function readSiteFields(response: unknown): { whatTheySell: string | null; whoBuys: string | null } {
  const fields = ((response ?? {}) as { fields?: Record<string, { value?: unknown }> }).fields ?? {};
  return { whatTheySell: asText(fields.whatTheySell?.value), whoBuys: asText(fields.whoBuys?.value) };
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still reading after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Reads what the brief says. A failed brand or offer list throws: the brief would lie by omission. */
export async function readClientBrief(deps: ClientBriefDeps, timeoutMs = CLIENT_BRIEF_SITE_TIMEOUT_MS): Promise<BriefBrand[]> {
  const listed = (await deps.listBrands()) as { brands?: Array<Record<string, unknown>> };
  const brands = (Array.isArray(listed?.brands) ? listed.brands : []).slice(0, CLIENT_BRIEF_MAX_BRANDS);
  return Promise.all(
    brands.map(async (b): Promise<BriefBrand> => {
      const id = String(b.id);
      const [offersRes, site] = await Promise.all([
        deps.listOffers(id),
        withTimeout(deps.readWebsite(id), timeoutMs).catch((err: unknown) => ({ error: errorText(err) })),
      ]);
      const offers = ((offersRes as { offers?: Array<Record<string, unknown>> })?.offers ?? [])
        .filter((o) => o.status === undefined || o.status === "active")
        .slice(0, MAX_OFFERS_PER_BRAND)
        .map((o) => ({ name: String(o.name ?? "Unnamed offer"), description: asText(o.description) }));
      const website = asText(b.brandUrl) ?? asText(b.domain);
      return { id, name: asText(b.name), website, offers, site };
    }),
  );
}

/** The block the agent reads: what we know about the client's business, then how to use it. */
export function formatClientBrief(brands: BriefBrand[]): string {
  const lines = [
    "\n\n---\n## Your client's business (read for this turn from their website and their account)",
    "Start from it: say back in a few words what they sell and to whom, then propose the next concrete step and take it. " +
      "Their business, their buyers and their offer are things you read, here or with your tools; your questions are for what only they can decide (a budget, a yes, a choice between options you found).",
  ];
  if (brands.length === 0) {
    lines.push("They have no brand yet: set it up from their website (the new-account skill).");
    return lines.join("\n");
  }
  for (const b of brands) {
    lines.push(`### ${b.name ?? "Unnamed brand"}${b.website ? ` (${b.website})` : ""}, brandId ${b.id}`);
    if ("error" in b.site) {
      lines.push(`Their website could not be read for this turn (${b.site.error}): read it with your tools before anything else.`);
    } else {
      lines.push(`What they sell: ${b.site.whatTheySell ?? "their website does not say."}`);
      lines.push(`Who buys from them: ${b.site.whoBuys ?? "their website does not say."}`);
    }
    if (b.offers.length === 0) {
      lines.push("Offers: none yet.");
    } else {
      for (const o of b.offers) {
        lines.push(
          `Offer "${o.name}": ${o.description ?? "no description yet; describe it from what they sell when you set up their campaign"}.`,
        );
      }
    }
  }
  return lines.join("\n");
}

/** The block when the account itself could not be read: the agent knows the gap is ours. */
export function clientBriefUnavailable(err: unknown): string {
  return (
    "\n\n---\n## Your client's business\n" +
    `Their account could not be read for this turn (${errorText(err)}): read their brands, offers and website with your tools before answering; never ask them what you can read.`
  );
}
