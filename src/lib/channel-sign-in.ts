/**
 * Sign-in from a WhatsApp chat (SOPHIE-COPILOT-WA-1018, owner 2026-10-18).
 *
 * The sender's WhatsApp number IS their identity (WhatsApp verified it, no
 * extra SMS check). A number no account holds yet is a GUEST session: the
 * Copilot sees no account and gets these two tools only. The person proves an
 * email with the existing agent-signup code (client-service: the email's
 * account is returned, created on first sight, and the number is tied to it in
 * the same call): the answer that follows at once, and every next message,
 * act with that account.
 *
 * The number always comes from the session row (written only by
 * POST /internal/copilot/lead-turns from the person the workflow writes to), never
 * from the model or the request: a web caller cannot tie a number it does not
 * hold.
 */
import type Anthropic from "@anthropic-ai/sdk";

export const START_SIGN_IN_TOOL_NAME = "start_sign_in";
export const COMPLETE_SIGN_IN_TOOL_NAME = "complete_sign_in";
export const SIGN_IN_TOOL_NAMES: readonly string[] = [START_SIGN_IN_TOOL_NAME, COMPLETE_SIGN_IN_TOOL_NAME];

export const START_SIGN_IN_TOOL: Anthropic.Tool = {
  name: START_SIGN_IN_TOOL_NAME,
  description:
    "Sign the person you are talking to on WhatsApp up, or in, to distribute.you: emails a 6-digit code to the address they give you. " +
    "Works for a new person (their account is created when they give the code back) and for someone who already has an account (they get into it). " +
    "Use the email we already know for them when the channel names one (never ask a known person for it); otherwise ask for their email once. Then call this, ask them for the code from that email and call complete_sign_in.",
  input_schema: {
    type: "object" as const,
    properties: { email: { type: "string", description: "The email the person gave you." } },
    required: ["email"],
  },
};

export const COMPLETE_SIGN_IN_TOOL: Anthropic.Tool = {
  name: COMPLETE_SIGN_IN_TOOL_NAME,
  description:
    "Finish the sign-in with the 6-digit code the person received by email. On success their WhatsApp number is tied to that account, " +
    "and right after your reply you answer again, automatically, with that account's access (campaigns, brands, everything they can do on the web): " +
    "so in this reply just say in a few words that they are in. Never ask them to send anything to continue.",
  input_schema: {
    type: "object" as const,
    properties: {
      email: { type: "string", description: "The same email as start_sign_in." },
      code: { type: "string", description: "The 6 digits from the email." },
    },
    required: ["email", "code"],
  },
};

export interface SignedInAccount {
  orgId: string;
  userId: string;
  email: string;
  created: boolean;
}

export interface ClientServiceDeps {
  fetchImpl: typeof fetch;
}

const defaultDeps: ClientServiceDeps = { fetchImpl: fetch };

function clientService(): { url: string; key: string } {
  const url = process.env.CLIENT_SERVICE_URL;
  const key = process.env.CLIENT_SERVICE_API_KEY;
  if (!url || !key) throw new Error("CLIENT_SERVICE_URL / CLIENT_SERVICE_API_KEY not configured");
  return { url, key };
}

async function post(path: string, body: unknown, deps: ClientServiceDeps): Promise<{ status: number; json: Record<string, unknown> }> {
  const { url, key } = clientService();
  const res = await deps.fetchImpl(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/** A refusal the person can act on (wrong code, expired) reaches the model as data, never a throw. */
function refusal(json: Record<string, unknown>) {
  return {
    ok: false as const,
    error: typeof json.error === "string" ? json.error : "sign_in_failed",
    message: typeof json.message === "string" ? json.message : "The sign-in did not go through.",
    ...(typeof json.attemptsLeft === "number" ? { attemptsLeft: json.attemptsLeft } : {}),
  };
}

export async function startSignIn(email: unknown, phone: string, deps: ClientServiceDeps = defaultDeps) {
  if (typeof email !== "string" || !email.trim()) throw new Error("start_sign_in requires the person's email");
  const { status, json } = await post("/internal/agent-signups/start", { email: email.trim().toLowerCase(), phone }, deps);
  if (status === 200) return { ok: true as const, codeSentTo: email.trim().toLowerCase(), expiresAt: json.expiresAt ?? null };
  if (status === 400) return refusal(json);
  throw new Error(`client-service agent-signups/start ${status}: ${JSON.stringify(json)}`);
}

/**
 * Proves the email and, in the same call, makes the WhatsApp number resolve to
 * that account (client-service `whatsappPhone`, taken off any previous holder).
 * The caller re-keys the session.
 */
export async function completeSignIn(
  email: unknown,
  code: unknown,
  whatsappPhone: string,
  deps: ClientServiceDeps = defaultDeps,
): Promise<{ ok: true; account: SignedInAccount } | ReturnType<typeof refusal>> {
  if (typeof email !== "string" || !email.trim()) throw new Error("complete_sign_in requires the email");
  if (typeof code !== "string" && typeof code !== "number") throw new Error("complete_sign_in requires the code");
  const { status, json } = await post(
    "/internal/agent-signups/complete",
    { email: email.trim().toLowerCase(), code: String(code).replace(/\s+/g, ""), whatsappPhone },
    deps,
  );
  if (status === 200) {
    if (typeof json.orgId !== "string" || typeof json.userId !== "string" || json.whatsappPhone !== whatsappPhone) {
      throw new Error(`client-service agent-signups/complete answered without orgId/userId or without binding the number: ${JSON.stringify(json)}`);
    }
    return {
      ok: true,
      account: { orgId: json.orgId, userId: json.userId, email: String(json.email ?? email), created: json.created === true },
    };
  }
  if ([400, 404, 410, 429].includes(status)) return refusal(json);
  throw new Error(`client-service agent-signups/complete ${status}: ${JSON.stringify(json)}`);
}
