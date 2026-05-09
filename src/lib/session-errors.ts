// SSE error event emitted when the caller passes a sessionId that does not
// exist or belongs to a different org. Lives next to the chat handler so the
// shape stays in lockstep with the documented protocol in README.md.

import type { SSEErrorEvent } from "../types.js";

export const SESSION_NOT_FOUND_EVENT: SSEErrorEvent = {
  type: "error",
  code: "session_not_found",
  message:
    "Session not found. The provided sessionId does not exist or belongs to a different org. " +
    "Omit sessionId to start a new conversation.",
};
