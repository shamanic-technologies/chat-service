const BILLING_SERVICE_URL =
  process.env.BILLING_SERVICE_URL || "https://billing.mcpfactory.org";
const BILLING_SERVICE_API_KEY = process.env.BILLING_SERVICE_API_KEY;

export class BillingError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly upstreamBody: string,
  ) {
    super(message);
    this.name = "BillingError";
  }

  /** True when billing-service explicitly rejected the request (4xx) */
  get isClientError(): boolean {
    return this.statusCode >= 400 && this.statusCode < 500;
  }
}

export interface CreditItem {
  costName: string;
  quantity: number;
}

export interface AuthorizeCreditParams {
  items: CreditItem[];
  description: string;
  orgId: string;
  userId: string;
  runId: string;
  trackingHeaders?: Record<string, string>;
}

/**
 * Why billing refused a spend when the balance is NOT the cause: a sales funnel
 * campaign's MAX BUDGET (billing-service `AuthorizeResponse.reason`). Absent on a
 * balance refusal. The client must tell "raise the campaign's max budget" apart
 * from "add credit", so this travels to every caller (FUNNEL-CAP-REACHED-AT-2PCT-1015).
 */
export type BillingRefusalReason =
  | "sales_funnel_max_budget_reached"
  | "sales_funnel_max_budget_unreadable";

/** The cap that refused the spend, verbatim from billing (present only with `reason`). */
export interface SalesFunnelCap {
  salesFunnelId: string;
  salesFunnelCampaignId: string | null;
  amountCents: string;
  period: string;
  consumedCents: string | null;
  reservedCents: string;
}

export interface AuthorizeCreditResult {
  sufficient: boolean;
  balance_cents: number;
  required_cents: number;
  reason?: BillingRefusalReason;
  sales_funnel_cap?: SalesFunnelCap;
}

/**
 * Request credit authorization from billing-service.
 * Send costName + quantity items — billing-service resolves the price.
 * Returns { sufficient, balance_cents, required_cents, reason?, sales_funnel_cap? }.
 * Throws on network/server errors.
 */
export async function authorizeCredits(
  params: AuthorizeCreditParams,
): Promise<AuthorizeCreditResult> {
  if (!BILLING_SERVICE_API_KEY) {
    throw new Error(
      "[billing-client] BILLING_SERVICE_API_KEY is required for credit authorization",
    );
  }

  const { items, description, orgId, userId, runId, trackingHeaders } = params;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": BILLING_SERVICE_API_KEY,
    "x-org-id": orgId,
    "x-user-id": userId,
    "x-run-id": runId,
  };
  if (trackingHeaders) {
    for (const [k, v] of Object.entries(trackingHeaders)) {
      if (v) headers[k] = v;
    }
  }

  const res = await fetch(`${BILLING_SERVICE_URL}/v1/customer_balance/authorize`, {
    method: "POST",
    headers,
    body: JSON.stringify({ items, description }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BillingError(
      `[billing-client] POST /v1/customer_balance/authorize returned ${res.status}: ${text}`,
      res.status,
      text,
    );
  }

  return (await res.json()) as AuthorizeCreditResult;
}

/** billing-service's mark on an org opened through the API by an AI agent (prepaid only). */
export const AGENT_API_OFFER = "agent_api";

/**
 * True when billing marks the org `free_credit_offer: agent_api`: an org an AI
 * agent opened through the API, with no dashboard button to click. Such an org
 * gets a /chat refusal for lack of money as an HTTP 402 the gateway turns into
 * its prepay instructions. 404 (no billing account) = not an agent org.
 * Throws on any other failure.
 */
export async function isAgentApiOrg(orgId: string, userId: string, runId: string): Promise<boolean> {
  if (!BILLING_SERVICE_API_KEY) {
    throw new Error("[billing-client] BILLING_SERVICE_API_KEY is required to read the prepaid status");
  }
  const res = await fetch(`${BILLING_SERVICE_URL}/v1/accounts/prepaid_status`, {
    // billing requires x-run-id on every identity-scoped read (400 without it).
    headers: { "X-API-Key": BILLING_SERVICE_API_KEY, "x-org-id": orgId, "x-user-id": userId, "x-run-id": runId },
  });
  if (res.status === 404) return false;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BillingError(
      `[billing-client] GET /v1/accounts/prepaid_status returned ${res.status}: ${text}`,
      res.status,
      text,
    );
  }
  const body = (await res.json()) as { free_credit_offer?: string | null };
  return body.free_credit_offer === AGENT_API_OFFER;
}
