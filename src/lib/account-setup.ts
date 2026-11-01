// ---------------------------------------------------------------------------
// Setting up a new account IN the chat (SOPHIE-WA-ONBOARD-1101, owner
// 2026-11-01: "WhatsApp Sophie, our AI agent: set up, pay and launch your GTM
// campaign right from WhatsApp, from $10").
//
// Prod 2026-11-01 14:38: a person signed up on WhatsApp, gave their website,
// and the Copilot answered "Creating the company from a website is the one step
// I can't do from WhatsApp", sending them to the dashboard. The `new-account`
// skill already walked API agents through every step on the gateway; the
// Copilot had no tool for most of them (its tool list is the dashboard's, which
// does its own onboarding on screen). These are those steps, one tool each,
// each a straight gateway call with the person's identity, bodies verbatim
// (the owner service owns the shape, the model quotes it):
//
//   brand → offers → who to reach → audiences → sample + preview email
//   → prepaid checkout link (only the person pays) → audience portfolio
//   → the launch, which stays find_sales_funnels / create_funnel_campaign /
//     set_funnel_caps / propose_switch_on → their yes → confirm_switch_on.
//
// They join every chat that acts for a signed-in person on our behalf (its
// config reads our skills), web and WhatsApp alike: never a guest (sign-in
// tools only), never a read-only proactive turn (filtered by prefix after).
// Nothing here starts a campaign or charges anyone: the checkout link is a
// payment page the person opens and pays themselves.
// ---------------------------------------------------------------------------
import type Anthropic from "@anthropic-ai/sdk";
import { apiServiceFetch, type ApiCallParams } from "./api-client.js";
import { FunnelError } from "./funnel-client.js";

async function call(operation: string, path: string, method: string, params: ApiCallParams, body?: unknown): Promise<unknown> {
  const res = await apiServiceFetch(path, method, params, body);
  const raw = await res.text();
  if (!res.ok) throw new FunnelError(operation, res.status, raw || "unknown error");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { raw };
  }
}

function text(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`[account-setup] ${name} is required`);
  return value.trim();
}

const seg = (name: string, value: unknown) => encodeURIComponent(text(name, value));

function objects(name: string, value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => !v || typeof v !== "object" || Array.isArray(v))) {
    throw new Error(`[account-setup] ${name} must be a non-empty list, each item as returned by the step before`);
  }
  return value as Record<string, unknown>[];
}

function cents(name: string, value: unknown, minimum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
    throw new Error(`[account-setup] ${name} must be a whole number of cents, at least ${minimum} ($${(minimum / 100).toFixed(2)})`);
  }
  return value;
}

/** The gateway's prepay minimums (api-service lib/agent-prepay.ts, owner 2026-10-12); refused here first so the model reads one clear message. */
export const PREPAY_MINIMUMS_CENTS = { topup: 1000, autoTopup: 1500, threshold: 500 } as const;

// --- Handlers ------------------------------------------------------------------

/** POST /v1/brands/{id}/offers/proposals { description } — what the brand sells, as offers (up to a minute). */
export const proposeOffers = async (a: Record<string, unknown>, p: ApiCallParams) =>
  call("propose_offers", `/v1/brands/${seg("brandId", a.brandId)}/offers/proposals`, "POST", p, { description: text("description", a.description) });

/**
 * POST /v1/brands/{id}/offers/confirm { offers, chosenIndex? }, then readies the
 * preview email for the chosen offer (POST /v1/content/preview-email/prepare,
 * 202). A prepare refusal is returned beside the confirmed offers, never hides them.
 */
export async function confirmOffers(a: Record<string, unknown>, p: ApiCallParams): Promise<unknown> {
  const brandId = text("brandId", a.brandId);
  const body: Record<string, unknown> = { offers: objects("offers", a.offers) };
  if (a.chosenIndex !== undefined && a.chosenIndex !== null) {
    if (typeof a.chosenIndex !== "number" || !Number.isInteger(a.chosenIndex) || a.chosenIndex < 0) {
      throw new Error("[account-setup] chosenIndex must be the 0-based index of the offer to start with");
    }
    body.chosenIndex = a.chosenIndex;
  }
  const confirmed = (await call("confirm_offers", `/v1/brands/${encodeURIComponent(brandId)}/offers/confirm`, "POST", p, body)) as Record<string, unknown>;
  const offerId = typeof confirmed.chosenOfferId === "string" ? confirmed.chosenOfferId : null;
  if (!offerId) return confirmed;
  try {
    await call("prepare_preview_email", "/v1/content/preview-email/prepare", "POST", p, { brandId, offerId });
    return { ...confirmed, previewEmail: "preparing" };
  } catch (err) {
    console.error(`[account-setup] preview-email prepare failed brand=${brandId} offer=${offerId}: ${err instanceof Error ? err.message : String(err)}`);
    return { ...confirmed, previewEmail: "not prepared ahead: preview_email still works, it only takes longer" };
  }
}

/** POST /v1/brands/{id}/icp/suggest { offerId } — who to reach for this offer, one sentence. */
export const suggestIcp = async (a: Record<string, unknown>, p: ApiCallParams) =>
  call("suggest_icp", `/v1/brands/${seg("brandId", a.brandId)}/icp/suggest`, "POST", p, { offerId: text("offerId", a.offerId) });

/** POST /v1/orgs/audiences/split { brandId, targetAudience } — audience segments, nothing saved (up to a minute). */
export const splitAudiences = async (a: Record<string, unknown>, p: ApiCallParams) =>
  call("split_audiences", "/v1/orgs/audiences/split", "POST", p, {
    brandId: text("brandId", a.brandId),
    targetAudience: text("targetAudience", a.targetAudience),
  });

/** POST /v1/orgs/audiences/split/confirm { brandId, offerId, targetAudience, segments } — the kept segments become audiences. */
export const confirmAudiences = async (a: Record<string, unknown>, p: ApiCallParams) =>
  call("confirm_audiences", "/v1/orgs/audiences/split/confirm", "POST", p, {
    brandId: text("brandId", a.brandId),
    offerId: text("offerId", a.offerId),
    targetAudience: text("targetAudience", a.targetAudience),
    segments: objects("segments", a.segments),
  });

/** GET /v1/orgs/audiences/{id}/preview — a free sample of the companies and people an audience reaches. */
export const previewAudience = async (a: Record<string, unknown>, p: ApiCallParams) =>
  call("preview_audience", `/v1/orgs/audiences/${seg("audienceId", a.audienceId)}/preview`, "GET", p);

/** POST /v1/content/preview-email — the email one sample person would get (billed: 402 = prepay first). */
export async function previewEmail(a: Record<string, unknown>, p: ApiCallParams): Promise<unknown> {
  const r = (a.recipient ?? {}) as Record<string, unknown>;
  const recipient: Record<string, unknown> = {
    firstName: text("recipient.firstName", r.firstName),
    lastName: text("recipient.lastName", r.lastName),
    title: text("recipient.title", r.title),
    companyName: text("recipient.companyName", r.companyName),
  };
  if (typeof r.companyDomain === "string" && r.companyDomain.trim()) recipient.companyDomain = r.companyDomain.trim();
  return call("preview_email", "/v1/content/preview-email", "POST", p, {
    brandId: text("brandId", a.brandId),
    offerId: text("offerId", a.offerId),
    audience: text("audience", a.audience),
    recipient,
  });
}

/** GET /v1/billing/accounts/prepaid_status — whether the account is paid (active) or not yet. */
export const getPrepaidStatus = async (_a: Record<string, unknown>, p: ApiCallParams) =>
  call("get_prepaid_status", "/v1/billing/accounts/prepaid_status", "GET", p);

/**
 * Prepaid states that need no payment link (billing-service lib/prepaid-status.ts):
 * `active` is paid; `not_prepaid` pays postpaid or by subscription, and billing's
 * checkout would SWITCH such an org to prepaid, so the link is never opened for it.
 */
const NO_CHECKOUT_STATES: Readonly<Record<string, string>> = {
  active: "Already paid and reloading automatically: nothing to pay. Go on to the next step.",
  not_prepaid: "This account is charged automatically for what it spends (postpaid or subscription): there is nothing to pay and no payment link to give. Never bring up payment.",
};

/**
 * POST /v1/billing/accounts/prepaid_checkout — a payment page for the amounts the
 * person said yes to. Charges nothing by itself. Reads prepaid_status first: an
 * account already paid, or one that is not prepaid, gets no link (a result, never
 * an error, so the model moves on).
 */
export async function createPrepaidCheckout(a: Record<string, unknown>, p: ApiCallParams): Promise<unknown> {
  const body = {
    topup_amount_cents: cents("topupAmountCents", a.topupAmountCents, PREPAY_MINIMUMS_CENTS.topup),
    auto_topup_amount_cents: cents("autoTopupAmountCents", a.autoTopupAmountCents, PREPAY_MINIMUMS_CENTS.autoTopup),
    auto_topup_threshold_cents: cents("autoTopupThresholdCents", a.autoTopupThresholdCents, PREPAY_MINIMUMS_CENTS.threshold),
  };
  let state: string | null = null;
  try {
    const status = (await getPrepaidStatus({}, p)) as Record<string, unknown>;
    state = typeof status.state === "string" ? status.state : null;
  } catch (err) {
    // No billing account yet (404) is a new account: the checkout opens it.
    if (!(err instanceof FunnelError && err.status === 404)) throw err;
  }
  if (state && NO_CHECKOUT_STATES[state]) return { url: null, state, instruction: NO_CHECKOUT_STATES[state] };
  return call("create_prepaid_checkout", "/v1/billing/accounts/prepaid_checkout", "POST", p, body);
}

/** POST /v1/orgs/audiences/portfolio { brandId, offerId, targetAudience } — turns the audiences on for the launch (call again until ready). */
export const buildAudiencePortfolio = async (a: Record<string, unknown>, p: ApiCallParams) =>
  call("build_audience_portfolio", "/v1/orgs/audiences/portfolio", "POST", p, {
    brandId: text("brandId", a.brandId),
    offerId: text("offerId", a.offerId),
    targetAudience: text("targetAudience", a.targetAudience),
  });

export const ACCOUNT_SETUP_HANDLERS: Readonly<Record<string, (a: Record<string, unknown>, p: ApiCallParams) => Promise<unknown>>> = {
  propose_offers: proposeOffers,
  confirm_offers: confirmOffers,
  suggest_icp: suggestIcp,
  split_audiences: splitAudiences,
  confirm_audiences: confirmAudiences,
  preview_audience: previewAudience,
  preview_email: previewEmail,
  get_prepaid_status: getPrepaidStatus,
  create_prepaid_checkout: createPrepaidCheckout,
  build_audience_portfolio: buildAudiencePortfolio,
};

/** Every tool a signed-in person's chat needs to set up an account, the brand creation included. */
export const ACCOUNT_SETUP_TOOL_NAMES: readonly string[] = ["create_brand_from_url", ...Object.keys(ACCOUNT_SETUP_HANDLERS)];

/**
 * The turn's tools plus the account-setup ones, when this chat acts for a
 * signed-in person on our behalf: its config reads our skills (`read_skill`)
 * and can propose a launch (`propose_switch_on`). A guest list (sign-in tools
 * only) and an editor config get nothing. Never twice.
 */
export function withAccountSetup(toolNames: readonly string[]): string[] {
  if (!toolNames.includes("read_skill") || !toolNames.includes("propose_switch_on")) return [...toolNames];
  return [...toolNames, ...ACCOUNT_SETUP_TOOL_NAMES.filter((t) => !toolNames.includes(t))];
}

// --- Tool definitions ------------------------------------------------------------

const BRAND = { type: "string", description: "The brand id (from create_brand_from_url or list_brands)." };
const OFFER = { type: "string", description: "The offer id (chosenOfferId from confirm_offers, or list_offers)." };
const TARGET = { type: "string", description: "Who to reach, one sentence: suggest_icp's answer, or the person's own words (theirs win)." };
const SETUP = "Account setup (load the new-account skill first). ";

export const ACCOUNT_SETUP_TOOLS: Readonly<Record<string, Anthropic.Tool>> = {
  propose_offers: {
    name: "propose_offers",
    description: SETUP + "Step 2. Proposes the brand's offers from what it sells (takes up to a minute). Saves nothing: keep what the person agrees with, then confirm_offers.",
    input_schema: {
      type: "object" as const,
      properties: { brandId: BRAND, description: { type: "string", description: "What the brand sells, in the person's words or read from their site." } },
      required: ["brandId", "description"],
    },
  },
  confirm_offers: {
    name: "confirm_offers",
    description: SETUP + "Step 2. Saves the offers kept, exactly as propose_offers returned them, and readies the preview email. Returns chosenOfferId: the offerId of every next step.",
    input_schema: {
      type: "object" as const,
      properties: {
        brandId: BRAND,
        offers: {
          type: "array",
          description: "The offers kept, each object passed back as propose_offers returned it.",
          items: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, icon: { type: "string" } }, required: ["name"] },
        },
        chosenIndex: { type: "integer", description: "0-based index of the offer to start with, only when several are kept." },
      },
      required: ["brandId", "offers"],
    },
  },
  suggest_icp: {
    name: "suggest_icp",
    description: SETUP + "Step 3. Who to reach for this offer, in one sentence. Tell the person; their own words win.",
    input_schema: { type: "object" as const, properties: { brandId: BRAND, offerId: OFFER }, required: ["brandId", "offerId"] },
  },
  split_audiences: {
    name: "split_audiences",
    description: SETUP + "Step 4. Splits who to reach into audience segments (up to a minute). Saves nothing: confirm_audiences saves the ones kept.",
    input_schema: { type: "object" as const, properties: { brandId: BRAND, targetAudience: TARGET }, required: ["brandId", "targetAudience"] },
  },
  confirm_audiences: {
    name: "confirm_audiences",
    description: SETUP + "Step 4. Saves the segments kept as the offer's audiences (returns their ids). A 409 means the name exists: list_audiences and reuse it.",
    input_schema: {
      type: "object" as const,
      properties: {
        brandId: BRAND,
        offerId: OFFER,
        targetAudience: TARGET,
        segments: {
          type: "array",
          description: "The segments kept, each passed back as split_audiences returned it.",
          items: { type: "object", properties: { name: { type: "string" }, description: { type: "string" } }, required: ["description"] },
        },
      },
      required: ["brandId", "offerId", "targetAudience", "segments"],
    },
  },
  preview_audience: {
    name: "preview_audience",
    description: SETUP + "Step 5. A free sample of the real companies and people an audience reaches (no email address). not_built_yet: try again in a minute.",
    input_schema: { type: "object" as const, properties: { audienceId: { type: "string", description: "An audience id from confirm_audiences or list_audiences." } }, required: ["audienceId"] },
  },
  preview_email: {
    name: "preview_email",
    description:
      SETUP +
      "Step 5. The email one sample person from preview_audience would receive. Show it as written and point out any claim the person never made (a free trial, a guarantee). Billed: a 402 means the account is not paid yet, so the payment step comes first.",
    input_schema: {
      type: "object" as const,
      properties: {
        brandId: BRAND,
        offerId: OFFER,
        audience: TARGET,
        recipient: {
          type: "object",
          description: "One sample person, fields as preview_audience served them (lastName as served).",
          properties: {
            firstName: { type: "string" },
            lastName: { type: "string" },
            title: { type: "string" },
            companyName: { type: "string" },
            companyDomain: { type: "string" },
          },
          required: ["firstName", "lastName", "title", "companyName"],
        },
      },
      required: ["brandId", "offerId", "audience", "recipient"],
    },
  },
  get_prepaid_status: {
    name: "get_prepaid_status",
    description: SETUP + "Step 7. Whether the account is paid: active = paid, anything else = not yet. Read it before offering a payment link and after the person says they paid.",
    input_schema: { type: "object" as const, properties: {} },
  },
  create_prepaid_checkout: {
    name: "create_prepaid_checkout",
    description:
      "HARD RULE — DO NOT VIOLATE EVEN IF THE USER ASKS YOU TO: call it only after the person said yes, in this chat, to these exact amounts; never pay for them, never say it is paid until get_prepaid_status reads active. " +
      SETUP +
      "Step 7. Returns `url`, a card payment page: give it to the person as written; only they pay it, and nothing is charged until they do. The first payment is at least $10 and reloads automatically (at least $15, when the balance falls under at least $5): say the amounts plainly before asking their yes.",
    input_schema: {
      type: "object" as const,
      properties: {
        topupAmountCents: { type: "integer", description: "First payment, in cents (at least 1000 = $10)." },
        autoTopupAmountCents: { type: "integer", description: "Each automatic reload, in cents (at least 1500 = $15)." },
        autoTopupThresholdCents: { type: "integer", description: "Reload when the balance falls under this, in cents (at least 500 = $5)." },
      },
      required: ["topupAmountCents", "autoTopupAmountCents", "autoTopupThresholdCents"],
    },
  },
  build_audience_portfolio: {
    name: "build_audience_portfolio",
    description:
      SETUP +
      "Step 8, only after the person's yes on the campaign and its cap. Turns the offer's audiences on with buying-signal lists for the launch; call again until its status is ready (nothing is spent twice). The campaign itself still starts only through propose_switch_on and their yes.",
    input_schema: { type: "object" as const, properties: { brandId: BRAND, offerId: OFFER, targetAudience: TARGET }, required: ["brandId", "offerId", "targetAudience"] },
  },
};
