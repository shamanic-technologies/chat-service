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
}

export interface SSESessionEvent {
  sessionId: string;
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
  | SSESessionEvent;

export interface GeminiTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
