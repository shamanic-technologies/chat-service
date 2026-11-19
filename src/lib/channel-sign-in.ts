/**
 * Sign-in in the conversation, on any channel (SOPHIE-COPILOT-WA-1018, owner
 * 2026-10-18; DISTRY-ONE-AI-1118, owner 2026-11-18: « on peut onboarder des gens
 * depuis le widget sans qu'ils aient besoin d'aller sur la page signup »).
 *
 * A person no account of ours acts for is a GUEST. They prove an email with the
 * existing agent-signup code (client-service: the email's account is returned,
 * created on first sight): the answer that follows at once, and every next
 * message, act with that account. One path, the signup the API and MCP use.
 *
 * What the channel physically changes is the phone only:
 *  - WhatsApp: the sender's number IS their identity (WhatsApp verified it). It
 *    comes from the session row (written only by a lead turn, from the person
 *    the workflow writes to), never from the model, and the completion ties it
 *    to the account in the same call (`whatsappPhone`).
 *  - our website: nothing verified a number, so the visitor TYPES one (every
 *    signup leaves a number for urgent matters) and it is NEVER tied as a
 *    WhatsApp identity: no `whatsappPhone` is sent, no number changes hands.
 */
import type Anthropic from "@anthropic-ai/sdk";

export const START_SIGN_IN_TOOL_NAME = "start_sign_in";
export const COMPLETE_SIGN_IN_TOOL_NAME = "complete_sign_in";
export const SIGN_IN_TOOL_NAMES: readonly string[] = [START_SIGN_IN_TOOL_NAME, COMPLETE_SIGN_IN_TOOL_NAME];

export const START_SIGN_IN_TOOL: Anthropic.Tool = {
  name: START_SIGN_IN_TOOL_NAME,
  description:
    "Sign the person you are talking to up, or in, to distribute.you, right here in this conversation: emails a 6-digit code to the address they give you. " +
    "Works for a new person (their account is created when they give the code back) and for someone who already has an account (they get into it). " +
    "Use the email we already know for them when this conversation names one (never ask a known person for it); otherwise ask for their email once. " +
    "An account keeps one phone number for urgent matters: when this conversation is on WhatsApp the number is already known, leave `phone` out; anywhere else ask for it once, with its country code, and pass it. " +
    "Then call this, ask them for the code from that email and call complete_sign_in. A refusal comes back as {ok: false, error, message}: say what it asks for.",
  input_schema: {
    type: "object" as const,
    properties: {
      email: { type: "string", description: "The email the person gave you." },
      phone: { type: "string", description: "Their phone number in international form with the country code (+33612345678). Only where this conversation does not already hold their number." },
    },
    required: ["email"],
  },
};

export const COMPLETE_SIGN_IN_TOOL: Anthropic.Tool = {
  name: COMPLETE_SIGN_IN_TOOL_NAME,
  description:
    "Finish the sign-in with the 6-digit code the person received by email. On success this conversation is tied to that account, " +
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

const E164 = /^\+[1-9]\d{6,14}$/;

/** PURE: a number the person typed, in international form, or the refusal the model reads. */
export function parseTypedPhone(value: unknown): { ok: true; phone: string } | { ok: false; refused: { ok: false; error: string; message: string } } {
  const raw = typeof value === "string" ? value : "";
  const phone = raw.replace(/[\s().-]/g, "").replace(/^00/, "+");
  if (E164.test(phone)) return { ok: true, phone };
  return {
    ok: false,
    refused: {
      ok: false,
      error: raw.trim() ? "unreadable_number" : "phone_needed",
      message: raw.trim()
        ? `"${raw}" is not a phone number in international form (+ then the country code and number). Ask for it once more, with the country code.`
        : "This conversation holds no phone number for them: ask for one for urgent matters, with its country code, then call start_sign_in again with email and phone.",
    },
  };
}

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
 * Proves the email. On WhatsApp the same call makes the verified number resolve
 * to that account (client-service `whatsappPhone`, taken off any previous
 * holder). `whatsappPhone: null` (our website: the number was typed, nothing
 * verified it) sends none, so no number changes hands. The caller re-keys the session.
 */
export async function completeSignIn(
  email: unknown,
  code: unknown,
  whatsappPhone: string | null,
  deps: ClientServiceDeps = defaultDeps,
): Promise<{ ok: true; account: SignedInAccount } | ReturnType<typeof refusal>> {
  if (typeof email !== "string" || !email.trim()) throw new Error("complete_sign_in requires the email");
  if (typeof code !== "string" && typeof code !== "number") throw new Error("complete_sign_in requires the code");
  const { status, json } = await post(
    "/internal/agent-signups/complete",
    { email: email.trim().toLowerCase(), code: String(code).replace(/\s+/g, ""), ...(whatsappPhone ? { whatsappPhone } : {}) },
    deps,
  );
  if (status === 200) {
    if (typeof json.orgId !== "string" || typeof json.userId !== "string" || (whatsappPhone !== null && json.whatsappPhone !== whatsappPhone)) {
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
