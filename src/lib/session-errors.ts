// SSE error event emitted when the caller passes a sessionId that does not
// exist or belongs to a different org. Lives next to the chat handler so the
// shape stays in lockstep with the documented protocol in README.md.

import type { SSEErrorEvent } from "../types.js";

// Single source of truth for the "unknown / cross-org session" message, shared
// by the streaming SSE event (POST /chat) and the JSON 404 (GET /sessions/:id)
// so both surfaces stay byte-identical.
export const SESSION_NOT_FOUND_MESSAGE =
  "Session not found. The provided sessionId does not exist or belongs to a different org. " +
  "Omit sessionId to start a new conversation.";

export const SESSION_NOT_FOUND_EVENT: SSEErrorEvent = {
  type: "error",
  code: "session_not_found",
  message: SESSION_NOT_FOUND_MESSAGE,
};
