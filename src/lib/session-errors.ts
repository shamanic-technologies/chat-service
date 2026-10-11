// SSE error event emitted when the caller passes a sessionId that does not
// exist or belongs to someone else (another org, or another user of the same org). Lives next to the chat handler so the
// shape stays in lockstep with the documented protocol in README.md.

import type { SSEErrorEvent } from "../types.js";

// Single source of truth for the "unknown / not yours session" message, shared
// by the streaming SSE event (POST /chat) and the JSON 404 (GET /sessions/:id)
// so both surfaces stay byte-identical.
export const SESSION_NOT_FOUND_MESSAGE =
  "Session not found. The provided sessionId does not exist or belongs to another user. " +
  "Omit sessionId to start a new conversation.";

export const SESSION_NOT_FOUND_EVENT: SSEErrorEvent = {
  type: "error",
  code: "session_not_found",
  message: SESSION_NOT_FOUND_MESSAGE,
};

// A chat session is private to the user who opened it: same org is not enough
// (prod 2026-10-11, owner: a teammate must never read or continue my Copilot
// chat). Every user-scoped path that touches a session BY ID asks this, and a
// false answer is the SAME not-found as an unknown id, so existence never leaks.
// A legacy session with no recorded user (22 rows, all before 2026-02-04) has
// no owner anyone can prove, so it is nobody's: fail closed.
export function isSessionOwner(
  session: { orgId: string; userId: string | null },
  caller: { orgId: string; userId: string },
): boolean {
  return session.orgId === caller.orgId && session.userId !== null && session.userId === caller.userId;
}
