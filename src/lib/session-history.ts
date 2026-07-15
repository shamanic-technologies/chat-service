// Read-only serialization of a stored session + its messages into the
// GET /sessions/:sessionId response shape. Pure function (no DB, no I/O) so a
// client holding a valid sessionId can rebuild the visible conversation exactly
// as the user last saw it: ordered turns with role, text, tool calls, and any
// reasoning/thinking blocks. This reads data already persisted by POST /chat —
// it introduces no new storage.

import type { Session, Message } from "../db/schema.js";

/**
 * A single tool invocation as surfaced to a history reader: the tool name, the
 * input arguments, and (when the call completed) its output. The internal
 * Gemini `thoughtSignature` replay token is intentionally dropped — it is
 * provider plumbing, not visible conversation content.
 */
export interface SessionHistoryToolCall {
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
}

export interface SessionHistoryMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  /** Plain-text rendering of the turn. */
  content: string;
  /**
   * Provider content blocks captured at persist time (Anthropic content blocks,
   * including `thinking` reasoning blocks). Null when the turn stored none.
   * Richer than `content` for clients that render reasoning; `content` is the
   * safe text fallback.
   */
  contentBlocks: unknown[] | null;
  /** Tool calls made on this turn, in order. Null when the turn made none. */
  toolCalls: SessionHistoryToolCall[] | null;
  /** Quick-reply buttons extracted from the assistant turn. Null when none. */
  buttons: { label: string; value: string }[] | null;
  tokenCount: number | null;
  createdAt: string;
}

export interface SessionHistoryResponse {
  sessionId: string;
  orgId: string;
  campaignId: string | null;
  brandIds: string[] | null;
  workflowSlug: string | null;
  featureSlug: string | null;
  audienceId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Full ordered conversation, oldest turn first. */
  messages: SessionHistoryMessage[];
}

/**
 * Build the history response from a session row and its messages (which the
 * caller must supply already ordered oldest-first by createdAt).
 */
export function serializeSessionHistory(
  session: Session,
  messages: Message[],
): SessionHistoryResponse {
  return {
    sessionId: session.id,
    orgId: session.orgId,
    campaignId: session.campaignId ?? null,
    brandIds: session.brandIds ?? null,
    workflowSlug: session.workflowSlug ?? null,
    featureSlug: session.featureSlug ?? null,
    audienceId: session.audienceId ?? null,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      contentBlocks: m.contentBlocks ?? null,
      toolCalls: m.toolCalls
        ? m.toolCalls.map((tc) => ({
            name: tc.name,
            args: tc.args,
            ...(tc.result !== undefined ? { result: tc.result } : {}),
          }))
        : null,
      buttons: m.buttons ?? null,
      tokenCount: m.tokenCount ?? null,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}
