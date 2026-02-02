import type { ButtonRecord, ToolCallRecord } from "./db/schema.js";

export interface ChatRequest {
  message: string;
  sessionId?: string;
}

export interface SSETokenEvent {
  type: "token";
  content: string;
}

export interface SSEButtonsEvent {
  type: "buttons";
  buttons: ButtonRecord[];
}

export interface SSEToolCallEvent {
  type: "tool_call";
  name: string;
  args: Record<string, unknown>;
}

export interface SSEToolResultEvent {
  type: "tool_result";
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
