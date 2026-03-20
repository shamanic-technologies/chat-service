const BILLING_SERVICE_URL =
  process.env.BILLING_SERVICE_URL || "https://billing.mcpfactory.org";
const BILLING_SERVICE_API_KEY = process.env.BILLING_SERVICE_API_KEY;

export interface AuthorizeCreditParams {
  requiredCents: number;
  description: string;
  orgId: string;
  userId: string;
  runId: string;
  trackingHeaders?: Record<string, string>;
}

export interface AuthorizeCreditResult {
  sufficient: boolean;
  balance_cents: number;
}

/**
 * Estimate the cost in USD cents for a chat turn.
 *
 * Uses Claude Sonnet 4.6 pricing:
 *   Input:  $3  / 1M tokens → 0.0003 cents/token
 *   Output: $15 / 1M tokens → 0.0015 cents/token
 *
 * We estimate input tokens from the message length (~4 chars/token)
 * and use MAX_TOKENS (16 000) as the worst-case output budget.
 */
export function estimateChatCostCents(messageLength: number): number {
  const estimatedInputTokens = Math.max(Math.ceil(messageLength / 4), 500);
  const maxOutputTokens = 16_000;

  const inputCostCents = estimatedInputTokens * 0.0003;
  const outputCostCents = maxOutputTokens * 0.0015;

  return Math.ceil(inputCostCents + outputCostCents);
}

/**
 * Request credit authorization from billing-service.
 * Returns { sufficient, balance_cents }.
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

  const { requiredCents, description, orgId, userId, runId, trackingHeaders } =
    params;

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
    body: JSON.stringify({
      required_cents: requiredCents,
      description,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[billing-client] POST /v1/credits/authorize returned ${res.status}: ${text}`,
    );
  }

  return (await res.json()) as AuthorizeCreditResult;
}
