// ---------------------------------------------------------------------------
// The briefs of a replayed turn, read from the scenario's recorded tool
// answers (the same reads production makes before the turn).
//
// The client brief's "what they sell" is read in production by brand-service
// from the brand's website (extract-fields, two sentences, cached 30 days).
// A replay cannot ask brand-service for a client's brand, so it reads the
// public page itself and passes its opening text: same source, rawer form.
// ---------------------------------------------------------------------------

import { formatClientBrief, readClientBrief, readSiteFields } from "../lib/client-brief.js";
import type { SituationReader } from "../agent/situation.js";
import type { Scenario } from "./scenario.js";

function recorded(scenario: Scenario, tool: string): unknown {
  const answers = scenario.fixtures[tool];
  if (!answers) throw new Error(`no recorded ${tool}`);
  return answers[0];
}

/** The visible text of a public page, without markup. */
export async function fetchPageText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", accept: "text/html" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const html = await res.text();
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function fixtureSituationReader(scenario: Scenario): SituationReader {
  return {
    listBrands: async () => recorded(scenario, "list_brands"),
    listOffers: async () => recorded(scenario, "list_offers"),
    getOfferSettings: async () => recorded(scenario, "get_offer_settings"),
    listCampaigns: async () => recorded(scenario, "list_campaigns"),
    getOfferPerformance: async () => recorded(scenario, "get_offer_performance"),
    listRepliesToHandle: async () => recorded(scenario, "list_replies_to_handle"),
    getBillingAccount: async () => recorded(scenario, "get_billing_account"),
    getPaymentOutlook: async () => recorded(scenario, "get_payment_outlook"),
    // Only the answer recorded for THAT campaign (a session recorded it for the campaign its tool asked about);
    // none = nothing to add, as when production's brief did not read it yet.
    ...(scenario.fixtures.get_campaign_next_steps
      ? {
          getCampaignNextSteps: async (_brandId: string, campaignId: string) =>
            (scenario.fixtures.get_campaign_next_steps ?? []).find(
              (a) => (a as { salesFunnelCampaignId?: unknown } | null)?.salesFunnelCampaignId === campaignId,
            ) ?? null,
        }
      : {}),
  };
}

/** How much of the page a replay passes as "what they sell". */
const SITE_EXCERPT_CHARS = 600;

export async function fixtureClientBrief(scenario: Scenario): Promise<string> {
  const listed = recorded(scenario, "list_brands") as { brands?: Array<Record<string, unknown>> };
  const urlOf = (brandId: string): string | null => {
    const b = (listed.brands ?? []).find((x) => String(x.id) === brandId);
    const url = (b?.brandUrl as string | undefined) ?? (b?.domain ? `https://${String(b.domain)}` : undefined);
    return url ?? null;
  };
  const brands = await readClientBrief({
    listBrands: async () => listed,
    listOffers: async () => recorded(scenario, "list_offers"),
    readWebsite: async (brandId) => {
      const url = urlOf(brandId);
      if (!url) throw new Error("no website on file");
      return { whatTheySell: (await fetchPageText(url)).slice(0, SITE_EXCERPT_CHARS), whoBuys: null };
    },
  });
  return formatClientBrief(brands);
}

/** The extract-fields answer a scenario recorded (the site read as the plan org), keyed as the gateway names it. */
export const EXTRACT_FIELDS_KEY = "POST /v1/brands/extract-fields";

/**
 * A guest's plan brief (DISTRY-GUEST-CAPS-1119), as /chat builds it: once their
 * website opened their brand (a POST /v1/brands in the history), the brand,
 * its offers and what the site says, from the recorded extract-fields answer
 * (`_status` >= 400 = the site could not be read). No brand yet: no brief.
 */
export async function fixtureGuestPlanBrief(scenario: Scenario): Promise<string> {
  let brand: { id: string; domain: string | null } | null = null;
  for (const m of scenario.history) {
    for (const call of ((m as { toolCalls?: Array<{ args?: Record<string, unknown>; result?: unknown }> }).toolCalls ?? [])) {
      const a = call.args ?? {};
      if (String(a.method ?? "").toUpperCase() !== "POST" || String(a.path ?? "").replace(/\/+$/, "") !== "/v1/brands") continue;
      const data = (call.result as { data?: { brandId?: unknown; domain?: unknown } } | null)?.data;
      if (typeof data?.brandId === "string") brand = { id: data.brandId, domain: typeof data.domain === "string" ? data.domain : null };
    }
  }
  if (!brand) return "";
  const site = scenario.fixtures[EXTRACT_FIELDS_KEY]?.[0] as Record<string, unknown> | undefined;
  const brands = await readClientBrief({
    listBrands: async () => ({ brands: [{ id: brand!.id, name: null, domain: brand!.domain }] }),
    listOffers: async () => scenario.fixtures.list_offers?.[0] ?? { offers: [] },
    readWebsite: async () => {
      if (!site) throw new Error("no recorded site read");
      if (typeof site._status === "number" && site._status >= 400) throw new Error(`brand-service extract-fields ${site._status}: ${String(site.error ?? "")}`);
      return readSiteFields(site);
    },
  });
  return formatClientBrief(brands);
}

