import { randomUUID } from "crypto";
import { apiServiceFetch, type ApiCallParams } from "./api-client.js";
import { FunnelError } from "./funnel-client.js";
import { requireStatedMaxBudget, startFunnelCampaign } from "./funnel-campaign-client.js";
import type { ToolCallRecord } from "../db/schema.js";

// ---------------------------------------------------------------------------
// Copilot entity tools — ONE read per entity of the platform (channels, legs,
// triggers, sales paths, sources, connected accounts, budgets, campaigns) and
// the DATA writes whose owner routes exist, all through the api-service
// gateway with the caller's identity. Bodies are returned verbatim: the owner
// service owns the shape, the model quotes it.
//
// Nothing here switches anything ON directly. Every action that starts work
// (and so spends) goes through propose_switch_on → the user answers in the
// chat → confirm_switch_on, and confirm only accepts a token proposed in an
// EARLIER turn of the same session (see resolveSwitchOnProposal): the model
// cannot propose and confirm in one breath, so a person's reply always sits
// between "here is what I would turn on" and "it is on".
// ---------------------------------------------------------------------------

async function call(operation: string, path: string, method: string, params: ApiCallParams, body?: unknown): Promise<unknown> {
  const res = await apiServiceFetch(path, method, params, body);
  const raw = await res.text();
  if (!res.ok) throw new FunnelError(operation, res.status, raw || "unknown error");
  if (!raw) return {};
  return JSON.parse(raw) as unknown;
}

function id(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`[copilot] ${name} is required`);
  return encodeURIComponent(value.trim());
}

function rawId(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`[copilot] ${name} is required`);
  return value.trim();
}

function cents(name: string, value: unknown): number {
  const n = Number(value);
  if (value === undefined || value === null || !Number.isInteger(n) || n < 1) {
    throw new Error(`[copilot] ${name} must be a positive integer number of cents (a budget cap is mandatory)`);
  }
  return n;
}

function stringList(name: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
    throw new Error(`[copilot] ${name} must be an array of non-empty strings`);
  }
  return (value as string[]).map((v) => v.trim());
}

const offerPath = (brandId: unknown, offerId: unknown) => `/v1/brands/${id("brandId", brandId)}/offers/${id("offerId", offerId)}`;

// --- Reads (free) ------------------------------------------------------------


/** GET /v1/brands/{id}/offers/{offerId}/channels — the channels this offer accepts. */
export const getOfferChannels = (a: Record<string, unknown>, p: ApiCallParams) =>
  call("get_offer_channels", `${offerPath(a.brandId, a.offerId)}/channels`, "GET", p);

/** GET /v1/brands/{id}/offers/{offerId}/sales-path — the offer's steps and the legs it sells through. */
export const getOfferLegs = (a: Record<string, unknown>, p: ApiCallParams) =>
  call("get_offer_legs", `${offerPath(a.brandId, a.offerId)}/sales-path`, "GET", p);

/** GET /v1/brands/{id}/leg-rates — the brand's conversion rate per leg. */
export const getLegRates = (a: Record<string, unknown>, p: ApiCallParams) =>
  call("get_leg_rates", `/v1/brands/${id("brandId", a.brandId)}/leg-rates`, "GET", p);

/** GET /v1/offers/{offerId}/sales-paths?brandId — every sales path, ranked by ROI. */
export const listSalesPaths = (a: Record<string, unknown>, p: ApiCallParams) =>
  call("list_sales_paths", `/v1/offers/${id("offerId", a.offerId)}/sales-paths?brandId=${id("brandId", a.brandId)}`, "GET", p);

/** GET /v1/brands/{id}/offers/{offerId}/selected-sales-paths — the paths the user ticked. */
export const getSelectedSalesPaths = (a: Record<string, unknown>, p: ApiCallParams) =>
  call("get_selected_sales_paths", `${offerPath(a.brandId, a.offerId)}/selected-sales-paths`, "GET", p);

/** GET /v1/offers/{offerId}/trigger-events/summary?brandId — per trigger type: fired / ran / skipped (with reasons). */
export const getTriggerEvents = (a: Record<string, unknown>, p: ApiCallParams) =>
  call("get_trigger_events", `/v1/offers/${id("offerId", a.offerId)}/trigger-events/summary?brandId=${id("brandId", a.brandId)}`, "GET", p);

/** GET /v1/public/sourcing-origins — where leads can come from. */
export const listSourcingOrigins = (p: ApiCallParams) => call("list_sourcing_origins", "/v1/public/sourcing-origins", "GET", p);

/** GET /v1/offers/{offerId}/sourcing?brandId — the offer's lead sources with cost and ROI per origin. */
export const getOfferSourcing = (a: Record<string, unknown>, p: ApiCallParams) =>
  call("get_offer_sourcing", `/v1/offers/${id("offerId", a.offerId)}/sourcing?brandId=${id("brandId", a.brandId)}`, "GET", p);

/** GET /v1/brands/{brandId}/offers/{offerId}/campaign-budgets — the daily cap per (channel x leg). */
export const getCampaignBudgets = (a: Record<string, unknown>, p: ApiCallParams) =>
  call("get_campaign_budgets", `/v1/brands/${id("brandId", a.brandId)}/offers/${id("offerId", a.offerId)}/campaign-budgets`, "GET", p);

/** GET /v1/campaigns/{id} — one campaign: offer, leg, channel, status. */
export const getCampaign = (a: Record<string, unknown>, p: ApiCallParams) =>
  call("get_campaign", `/v1/campaigns/${id("campaignId", a.campaignId)}`, "GET", p);

/**
 * Every connected account of the org, one block per provider, each read from
 * its owner route. A provider whose read fails carries its error in place, so
 * one dead provider does not hide the others (and the failure is visible).
 */
export async function listConnectedAccounts(a: Record<string, unknown>, p: ApiCallParams): Promise<unknown> {
  const reads: Array<[string, string]> = [
    ["google_mailboxes", "/v1/orgs/google/accounts"],
    ["messaging_connections", "/v1/orgs/matrix/connections"],
    ["gohighlevel", "/v1/orgs/gohighlevel/connections"],
    ["posthog", "/v1/orgs/posthog/connections"],
    ["stripe", "/v1/orgs/stripe/connections"],
  ];
  if (typeof a.brandId === "string" && a.brandId.trim()) {
    reads.push(["messaging_links_for_brand", `/v1/orgs/matrix/links?brandId=${id("brandId", a.brandId)}`]);
  }
  const results = await Promise.all(
    reads.map(async ([key, path]) => {
      try {
        return [key, await call(`list_connected_accounts:${key}`, path, "GET", p)] as const;
      } catch (err) {
        return [key, { error: err instanceof Error ? err.message : String(err) }] as const;
      }
    }),
  );
  return {
    ...Object.fromEntries(results),
    note: "No route connects a LinkedIn account today; cold-email inboxes are managed by the platform.",
  };
}

// --- Data writes (no spend, nothing switched on) ------------------------------

/** POST /v1/brands/{id}/offers { name } — a new offer (data only). */
export const createOffer = (a: Record<string, unknown>, p: ApiCallParams) =>
  call("create_offer", `/v1/brands/${id("brandId", a.brandId)}/offers`, "POST", p, { name: rawId("name", a.name) });

/** PUT /v1/brands/{id}/offers/{offerId}/channels { channelSlugs } — REPLACES the offer's channel list. */
export const setOfferChannels = (a: Record<string, unknown>, p: ApiCallParams) =>
  call("set_offer_channels", `${offerPath(a.brandId, a.offerId)}/channels`, "PUT", p, {
    channelSlugs: stringList("channelSlugs", a.channelSlugs),
  });

/** PUT .../selected-sales-paths { combinationKeys } — REPLACES the ticked paths. Turns nothing on. */
export const setSelectedSalesPaths = (a: Record<string, unknown>, p: ApiCallParams) =>
  call("set_selected_sales_paths", `${offerPath(a.brandId, a.offerId)}/selected-sales-paths`, "PUT", p, {
    combinationKeys: stringList("combinationKeys", a.combinationKeys),
  });

/**
 * PUT /v1/brands/{brandId}/campaign-budget { offerId, legKey, featureSlug, dailyBudgetCents }
 * — the daily CAP of one (offer x leg x channel) campaign. Creates no campaign
 * and starts nothing ("money never starts anything", campaign-service).
 */
export const setCampaignBudget = (a: Record<string, unknown>, p: ApiCallParams) =>
  call("set_campaign_budget", `/v1/brands/${id("brandId", a.brandId)}/campaign-budget`, "PUT", p, {
    offerId: rawId("offerId", a.offerId),
    legKey: rawId("legKey", a.legKey),
    featureSlug: rawId("featureSlug", a.featureSlug),
    dailyBudgetCents: cents("dailyBudgetCents", a.dailyBudgetCents),
  });

// --- Switch ON: propose (this turn) → confirm (a later turn) ------------------

export const SWITCH_ON_ACTIONS = ["start_funnel_campaign", "start_campaign", "activate_campaign", "switch_on_reactive_legs"] as const;
export type SwitchOnAction = (typeof SWITCH_ON_ACTIONS)[number];

export interface SwitchOnProposal {
  confirmationToken: string;
  action: SwitchOnAction;
  target: Record<string, string | number>;
  /** start_funnel_campaign: the caps as stated when proposed (shown to the user). */
  caps?: unknown;
  summary: string;
  status: "awaiting_user_confirmation";
  instruction: string;
}

/**
 * Validate and record what WOULD be switched on. For `start_campaign` the
 * daily budget cap is mandatory and is SET now (the cap is data; the campaign
 * is not created). Returns a token the model hands to confirm_switch_on in a
 * LATER turn, after the user said yes.
 */
export async function proposeSwitchOn(a: Record<string, unknown>, p: ApiCallParams): Promise<SwitchOnProposal & { budget?: unknown }> {
  const action = a.action as SwitchOnAction;
  if (!SWITCH_ON_ACTIONS.includes(action)) {
    throw new Error(`[copilot] action must be one of ${SWITCH_ON_ACTIONS.join(", ")}`);
  }
  const summary = rawId("summary", a.summary);
  const base = {
    confirmationToken: randomUUID(),
    action,
    summary,
    status: "awaiting_user_confirmation" as const,
    instruction:
      "Nothing is on yet. Show the user exactly what will start and its daily cap, and ask them to confirm (present_choices). Only after they say yes, in a later message, call confirm_switch_on with this confirmationToken.",
  };
  if (action === "start_campaign") {
    const target = {
      brandId: rawId("brandId", a.brandId),
      offerId: rawId("offerId", a.offerId),
      legKey: rawId("legKey", a.legKey),
      featureSlug: rawId("featureSlug", a.featureSlug),
      dailyBudgetCents: cents("dailyBudgetCents", a.dailyBudgetCents),
    };
    const budget = await setCampaignBudget(target, p);
    return { ...base, target, budget };
  }
  if (action === "start_funnel_campaign") {
    // A funnel campaign's money is ONLY its caps: no max budget = held unfunded,
    // so the proposal is refused until the user stated one (set_funnel_caps).
    const target = {
      brandId: rawId("brandId", a.brandId),
      offerId: rawId("offerId", a.offerId),
      salesFunnelId: rawId("salesFunnelId", a.salesFunnelId),
    };
    const caps = await requireStatedMaxBudget(target, p);
    return { ...base, target, caps };
  }
  if (action === "activate_campaign") {
    return { ...base, target: { campaignId: rawId("campaignId", a.campaignId) } };
  }
  return { ...base, target: { brandId: rawId("brandId", a.brandId), offerId: rawId("offerId", a.offerId) } };
}

export class SwitchOnConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwitchOnConfirmationError";
  }
}

interface HistoryMessage {
  role: string;
  toolCalls: ToolCallRecord[] | null;
}

/**
 * Find the proposal behind a token in the session history recorded BEFORE this
 * turn (so a proposal from the current turn is invisible), and refuse a token
 * already confirmed. This is the structural guarantee that a user message sits
 * between the proposal and the switch-on.
 */
export function resolveSwitchOnProposal(token: unknown, priorHistory: readonly HistoryMessage[]): SwitchOnProposal {
  if (typeof token !== "string" || token.trim() === "") {
    throw new SwitchOnConfirmationError("confirmationToken is required (from propose_switch_on in an earlier turn).");
  }
  let proposal: SwitchOnProposal | null = null;
  for (const m of priorHistory) {
    for (const tc of m.toolCalls ?? []) {
      const r = tc.result as Partial<SwitchOnProposal> | undefined;
      if (tc.name === "propose_switch_on" && r?.confirmationToken === token) {
        proposal = r as SwitchOnProposal;
      }
      if (tc.name === "confirm_switch_on" && (tc.args as Record<string, unknown>)?.confirmationToken === token) {
        const res = tc.result as Record<string, unknown> | undefined;
        if (res && res.switchedOn === true) {
          throw new SwitchOnConfirmationError("This confirmation token was already used: that action is already on.");
        }
      }
    }
  }
  if (!proposal) {
    throw new SwitchOnConfirmationError(
      "Unknown confirmation token for this conversation. Call propose_switch_on, show the user what will start, and wait for their answer before confirming.",
    );
  }
  // priorHistory ends before this turn's user message, so a proposal found here
  // always has at least that user message after it.
  return proposal;
}

/** Execute a confirmed proposal through its owner route. */
export async function executeSwitchOn(proposal: SwitchOnProposal, p: ApiCallParams): Promise<unknown> {
  const t = proposal.target;
  let result: unknown;
  if (proposal.action === "start_funnel_campaign") {
    result = await startFunnelCampaign(
      { brandId: String(t.brandId), offerId: String(t.offerId), salesFunnelId: String(t.salesFunnelId) },
      p,
    );
  } else if (proposal.action === "start_campaign") {
    result = await call("confirm_switch_on:start_campaign", "/v1/campaigns/start-funded-pair", "POST", p, {
      brandId: t.brandId,
      offerId: t.offerId,
      legKey: t.legKey,
      featureSlug: t.featureSlug,
    });
  } else if (proposal.action === "activate_campaign") {
    result = await call("confirm_switch_on:activate_campaign", `/v1/campaigns/${encodeURIComponent(String(t.campaignId))}`, "PATCH", p, {
      status: "activate",
    });
  } else {
    result = await call(
      "confirm_switch_on:switch_on_reactive_legs",
      `/v1/offers/${encodeURIComponent(String(t.offerId))}/reactive-defaults`,
      "POST",
      p,
      { brandId: t.brandId },
    );
  }
  return { switchedOn: true, action: proposal.action, target: t, result };
}
