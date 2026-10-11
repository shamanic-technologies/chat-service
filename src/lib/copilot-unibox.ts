/**
 * Copilot chat turns land in distribute.you's staff Unibox (owner 2026-10-11:
 * "l'AI Chat fait partie de notre staff"). crm-service owns the person thread;
 * chat-service PUSHES each copilot turn once the assistant message is stored.
 * crm files it ONLY under the staff Unibox scope set on its own box, never in
 * the user's org; a duplicate messageId is ignored there, so a retry is safe.
 *
 * Fire-and-forget beside the turn: the user already has the answer, so a crm
 * failure is logged, never surfaced to the chat.
 */
import { fetchRequesterEmail } from "./staff-requests.js";

/** The config whose sessions are the Copilot (sessions.config_key in prod). */
export const COPILOT_CONFIG_KEY = "copilot";

export interface CopilotTurnMessage {
  messageId: string;
  role: "user" | "assistant";
  text: string;
  at: Date;
}

export interface CopilotTurn {
  orgId: string;
  userId: string;
  sessionId: string;
  messages: CopilotTurnMessage[];
}

export interface CopilotUniboxDeps {
  fetchEmail: (userId: string) => Promise<string | null>;
  fetchImpl: typeof fetch;
}

const defaultDeps: CopilotUniboxDeps = { fetchEmail: fetchRequesterEmail, fetchImpl: fetch };

/** crm's contract: role user|assistant, text 1..200000 chars, 1..50 messages. */
export function buildCopilotTurnBody(turn: CopilotTurn, email: string) {
  const messages = turn.messages
    .filter((m) => m.text.trim().length > 0)
    .map((m) => ({ messageId: m.messageId, role: m.role, text: m.text.slice(0, 200_000), at: m.at.toISOString() }));
  return { orgId: turn.orgId, userId: turn.userId, email, displayName: null, sessionId: turn.sessionId, messages };
}

export async function pushCopilotTurn(turn: CopilotTurn, deps: CopilotUniboxDeps = defaultDeps): Promise<void> {
  const url = process.env.CRM_SERVICE_URL;
  const key = process.env.CRM_SERVICE_API_KEY;
  if (!url || !key) throw new Error("CRM_SERVICE_URL / CRM_SERVICE_API_KEY not configured");
  const email = await deps.fetchEmail(turn.userId);
  if (!email) throw new Error(`no email for user "${turn.userId}": crm matches the person by email`);
  const body = buildCopilotTurnBody(turn, email);
  if (body.messages.length === 0) return;
  const res = await deps.fetchImpl(`${url}/internal/copilot/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`crm-service ${res.status}: ${await res.text().catch(() => "")}`);
}

/** The call site: only Copilot sessions, never awaited by the turn, failures logged. */
export function pushCopilotTurnInBackground(configKey: string, turn: CopilotTurn, deps?: CopilotUniboxDeps): void {
  if (configKey !== COPILOT_CONFIG_KEY) return;
  pushCopilotTurn(turn, deps).catch((err) => {
    console.error(`[chat-service] copilot turn not filed in the staff Unibox (session="${turn.sessionId}"):`, err);
  });
}
