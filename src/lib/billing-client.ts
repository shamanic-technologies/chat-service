const BILLING_SERVICE_URL =
  process.env.BILLING_SERVICE_URL || "https://billing.mcpfactory.org";
const BILLING_SERVICE_API_KEY = process.env.BILLING_SERVICE_API_KEY;

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

export interface AuthorizeCreditResult {
  sufficient: boolean;
  balance_cents: number;
  required_cents: number;
}

/**
 * Request credit authorization from billing-service.
 * Send costName + quantity items — billing-service resolves the price.
 * Returns { sufficient, balance_cents, required_cents }.
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

  const res = await fetch(`${BILLING_SERVICE_URL}/v1/credits/authorize`, {
    method: "POST",
    headers,
    body: JSON.stringify({ items, description }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[billing-client] POST /v1/credits/authorize returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as AuthorizeCreditResult;
}
