import type { ButtonRecord, ToolCallRecord } from "./db/schema.js";

export interface ChatRequest {
  message: string;
  sessionId?: string;
  context?: Record<string, unknown>;
}

export interface SSETokenEvent {
  type: "token";
  content: string;
}

export interface SSEThinkingStartEvent {
  type: "thinking_start";
}

export interface SSEThinkingDeltaEvent {
  type: "thinking_delta";
  thinking: string;
}

export interface SSEThinkingStopEvent {
  type: "thinking_stop";
}

export interface SSEButtonsEvent {
  type: "buttons";
  buttons: ButtonRecord[];
}

export interface SSEToolCallEvent {
  type: "tool_call";
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface SSEToolResultEvent {
  type: "tool_result";
  id: string;
  name: string;
  result: unknown;
}

export interface SSEInputRequestEvent {
  type: "input_request";
  input_type: "url" | "text" | "email";
  label: string;
  placeholder?: string;
  field: string;
  value?: string;
}

export interface SSEErrorEvent {
  type: "error";
  code: string;
  message: string;
}

export interface SSESessionEvent {
  sessionId: string;
}

export interface SSEContextUsageEvent {
  type: "context_usage";
  inputTokens: number;
  outputTokens: number;
  maxTokens: number;
  percent: number;
}

/** Billing refused the turn for lack of credits: no model call, a fixed message and an "Add credits" action. */
export interface SSECreditsRequiredEvent {
  type: "credits_required";
  message: string;
  /** What the client's button does: open its credit top-up. */
  action: "add_credits";
  label: string;
}

export type SSEEvent =
  | SSETokenEvent
  | SSEThinkingStartEvent
  | SSEThinkingDeltaEvent
  | SSEThinkingStopEvent
  | SSEButtonsEvent
  | SSEToolCallEvent
  | SSEToolResultEvent
  | SSEInputRequestEvent
  | SSEErrorEvent
  | SSESessionEvent
  | SSEContextUsageEvent
  | SSECreditsRequiredEvent;
