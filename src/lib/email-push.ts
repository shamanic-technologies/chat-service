import { apiServiceFetch, type ApiCallParams } from "./api-client.js";
import { features } from "./declarations-client.js";
import { FunnelError } from "./funnel-client.js";
import { budgetWords, fundingOf, getFunnelCaps, listFunnelCampaigns, volumeWords } from "./funnel-campaign-client.js";
import { withCostUnits } from "./catalogue-client.js";

// ---------------------------------------------------------------------------
// Push an email the CLIENT wrote, sent as written (COPILOT-PUSH-EMAIL-1014).
//
// No new send path: the client's own reactive campaign answering the trigger
// `email_pushed_via_api` sends it from our inboxes, through the gateway's
// POST /v1/trigger-events (the same operation the client calls with its API
// key). The Copilot pushes ONE email per person, only after the user's yes:
// propose_switch_on (action push_email) shows the preview and returns a
// token, confirm_switch_on in a LATER turn pushes it (copilot-client gate).
// Prod 2026-10-14 (Definite Jobs): the Copilot filed two feature requests for
// this while their "Dulcet" campaign already did it.
// ---------------------------------------------------------------------------

export const EMAIL_PUSH_TRIGGER = "email_pushed_via_api";

/** The sender is picked by the sending step when it runs: never name one before. */
export const SENDER_WORDS =
  "One of our sending inboxes, picked when the email goes out: the exact address is not known before sending. It shows on the email once sent.";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function req(name: string, v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") throw new Error(`[email-push] ${name} is required`);
  return v.trim();
}

function opt(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

interface ServedFunnel {
  name?: string;
  line?: string | null;
  type?: string;
  trigger?: { slug?: string; name?: string } | null;
  legs?: Array<{ pipe?: Record<string, unknown> | null }>;
}

/** features-service's funnel detail: its trigger, line and first leg's pipe (the step the trigger runs). */
export async function readServedFunnel(salesFunnelId: string): Promise<ServedFunnel> {
  return (await features("email_push:read_funnel", "GET", `/internal/catalogue/sales-funnels/${encodeURIComponent(salesFunnelId)}`)) as ServedFunnel;
}

/** The catalogue's price for the step the trigger runs, in words, or plainly that it has none yet. */
export function oneSendCost(funnel: ServedFunnel): string {
  const pipe = funnel.legs?.[0]?.pipe;
  const priced = pipe ? (withCostUnits(pipe) as { cost?: unknown; status?: unknown }) : null;
  if (priced && typeof priced.cost === "string") return priced.cost;
  return `Not priced yet: the catalogue has no measured cost for this step${priced?.status ? ` (${String(priced.status)})` : ""}. It is billed at what the send really costs, within the campaign's caps.`;
}

interface FunnelCampaignLite {
  id: string;
  brandId?: string;
  offerId: string;
  salesFunnelId: string;
  salesFunnelName?: string | null;
  status: string;
}

/** Every funnel campaign of the offer, with the trigger features-service serves for its funnel. */
async function campaignsOnTrigger(brandId: string, offerId: string, p: ApiCallParams) {
  const body = (await listFunnelCampaigns({ brandId, offerId }, p)) as { salesFunnelCampaigns?: FunnelCampaignLite[] };
  if (!Array.isArray(body.salesFunnelCampaigns)) throw new Error("[email-push] campaign-service answered without salesFunnelCampaigns");
  const rows = await Promise.all(
    body.salesFunnelCampaigns.map(async (c) => ({ campaign: c, funnel: await readServedFunnel(c.salesFunnelId) })),
  );
  return rows.filter((r) => r.funnel.trigger?.slug === EMAIL_PUSH_TRIGGER);
}

export interface EmailPushTarget {
  brandId: string;
  offerId: string;
  email: string;
  name?: string;
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
}

export function emailPushTarget(a: Record<string, unknown>): EmailPushTarget {
  const email = req("email", a.email);
  if (!EMAIL_SHAPE.test(email)) throw new Error(`[email-push] email "${email}" is not an email address`);
  const bodyText = opt(a.bodyText);
  const bodyHtml = opt(a.bodyHtml);
  if (!bodyText && !bodyHtml) throw new Error("[email-push] the email needs a body: bodyText and/or bodyHtml, exactly as the user wrote it");
  const name = opt(a.name);
  return {
    brandId: req("brandId", a.brandId),
    offerId: req("offerId", a.offerId),
    email,
    ...(name ? { name } : {}),
    subject: req("subject", a.subject),
    ...(bodyText ? { bodyText } : {}),
    ...(bodyHtml ? { bodyHtml } : {}),
  };
}

/** No live campaign sends a pushed email: what to propose instead (never a feature request). */
export interface NoLiveEmailPushCampaign {
  status: "no_live_campaign";
  stoppedCampaigns: Array<{ id: string; name: string; salesFunnelId: string }>;
  instruction: string;
}

export interface EmailPushPreview {
  to: string;
  subject: string;
  body: string;
  sentBy: Array<{ campaignId: string; name: string; does: string | null; budget: string; volume: string | null; funded: boolean }>;
  sender: string;
  costOfOneSend: string;
}

/**
 * The preview for propose_switch_on push_email: who receives it, the email as
 * written, which LIVE campaigns send it (every one answering the trigger runs),
 * each one's caps, the catalogue's cost of one send, and the sender rule.
 */
export async function previewEmailPush(t: EmailPushTarget, p: ApiCallParams): Promise<EmailPushPreview | NoLiveEmailPushCampaign> {
  const matching = await campaignsOnTrigger(t.brandId, t.offerId, p);
  const live = matching.filter((m) => m.campaign.status === "ongoing");
  if (live.length === 0) {
    return {
      status: "no_live_campaign",
      stoppedCampaigns: matching.map((m) => ({ id: m.campaign.id, name: m.campaign.salesFunnelName ?? m.funnel.name ?? m.campaign.salesFunnelId, salesFunnelId: m.campaign.salesFunnelId })),
      instruction:
        "No running campaign of this offer sends a pushed email yet, so nothing was proposed. Never file a feature request for it: it exists. " +
        "If stoppedCampaigns lists one, offer to turn it back on (state a cap with set_funnel_caps, then propose_switch_on start_funnel_campaign). " +
        "Else find a funnel that starts on the trigger 'Email Pushed Via API' (find_sales_funnels containsChannels email-sending), create_funnel_campaign, ask its caps, and propose to start it. Then propose this email again.",
    };
  }
  const sentBy = await Promise.all(
    live.map(async ({ campaign, funnel }) => {
      const caps = (await getFunnelCaps({ brandId: t.brandId, offerId: t.offerId, salesFunnelId: campaign.salesFunnelId }, p)) as Parameters<typeof fundingOf>[0];
      const funded = fundingOf(caps);
      return {
        campaignId: campaign.id,
        name: campaign.salesFunnelName ?? funnel.name ?? campaign.salesFunnelId,
        does: funnel.line ?? null,
        budget: budgetWords(caps.salesFunnelType, caps.maxBudget ?? null, funded),
        volume: volumeWords(caps.salesFunnelType, caps.maxVolume ?? null, caps.volumeUnit),
        funded,
      };
    }),
  );
  return {
    to: t.name ? `${t.name} <${t.email}>` : t.email,
    subject: t.subject,
    body: t.bodyText ?? t.bodyHtml ?? "",
    sentBy,
    sender: SENDER_WORDS,
    costOfOneSend: oneSendCost(live[0].funnel),
  };
}

/** POST /v1/trigger-events: the push itself, the client's own operation. Idempotent on the proposal token. */
export async function pushEmail(t: EmailPushTarget, token: string, p: ApiCallParams): Promise<unknown> {
  const body = {
    triggerId: EMAIL_PUSH_TRIGGER,
    brandId: t.brandId,
    offerId: t.offerId,
    person: { email: t.email, ...(t.name ? { name: t.name } : {}) },
    item: { subject: t.subject, ...(t.bodyText ? { bodyText: t.bodyText } : {}), ...(t.bodyHtml ? { bodyHtml: t.bodyHtml } : {}) },
    idempotencyKey: `copilot-email-push-${token}`,
  };
  const res = await apiServiceFetch("/v1/trigger-events", "POST", p, body);
  const raw = await res.text();
  if (!res.ok) throw new FunnelError("confirm_switch_on:push_email", res.status, raw || "unknown error");
  const answer = JSON.parse(raw) as { event?: { id?: string; status?: string; outcome?: string | null; skipReason?: string | null } };
  return {
    ...answer,
    tellUser:
      "Say what the event reads: outcome 'ran' = the campaign is sending it; 'skipped' + skipReason = why nothing went out (say it plainly); status 'pending' = still being filed, it fires within minutes (get_trigger_events shows it later).",
  };
}
