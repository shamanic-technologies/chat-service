import { describe, it, expect } from "vitest";
import type {
  ChatRequest,
  SSETokenEvent,
  SSEButtonsEvent,
  SSEInputRequestEvent,
  SSEThinkingStartEvent,
  SSEThinkingDeltaEvent,
  SSEThinkingStopEvent,
  SSEToolCallEvent,
  SSEToolResultEvent,
  SSEErrorEvent,
} from "../../src/types.js";

describe("types", () => {
  it("ChatRequest shape requires only message", () => {
    const req: ChatRequest = { message: "hello" };
    expect(req.message).toBe("hello");
    expect(req.sessionId).toBeUndefined();
    expect(req.context).toBeUndefined();
  });

  it("ChatRequest with all optional fields", () => {
    const req: ChatRequest = {
      message: "hi",
      sessionId: "abc-123",
      context: { brandUrl: "https://example.com" },
    };
    expect(req.sessionId).toBe("abc-123");
    expect(req.context).toEqual({ brandUrl: "https://example.com" });
  });

  it("SSETokenEvent shape", () => {
    const event: SSETokenEvent = { type: "token", content: "Hello" };
    expect(event.type).toBe("token");
  });

  it("SSEButtonsEvent shape", () => {
    const event: SSEButtonsEvent = {
      type: "buttons",
      buttons: [{ label: "Go", value: "go" }],
    };
    expect(event.buttons).toHaveLength(1);
  });

  it("SSEInputRequestEvent shape", () => {
    const event: SSEInputRequestEvent = {
      type: "input_request",
      input_type: "url",
      label: "What's your brand URL?",
      placeholder: "https://yourbrand.com",
      field: "brand_url",
    };
    expect(event.type).toBe("input_request");
    expect(event.input_type).toBe("url");
    expect(event.field).toBe("brand_url");
  });

  it("SSEInputRequestEvent without optional placeholder", () => {
    const event: SSEInputRequestEvent = {
      type: "input_request",
      input_type: "text",
      label: "Enter a value",
      field: "some_field",
    };
    expect(event.placeholder).toBeUndefined();
  });

  it("SSEThinkingStartEvent shape", () => {
    const event: SSEThinkingStartEvent = { type: "thinking_start" };
    expect(event.type).toBe("thinking_start");
  });

  it("SSEThinkingDeltaEvent shape", () => {
    const event: SSEThinkingDeltaEvent = {
      type: "thinking_delta",
      thinking: "Let me analyze...",
    };
    expect(event.type).toBe("thinking_delta");
    expect(event.thinking).toBe("Let me analyze...");
  });

  it("SSEThinkingStopEvent shape", () => {
    const event: SSEThinkingStopEvent = { type: "thinking_stop" };
    expect(event.type).toBe("thinking_stop");
  });

  it("SSEToolCallEvent includes id field", () => {
    const event: SSEToolCallEvent = {
      type: "tool_call",
      id: "tc_abc-123",
      name: "search_leads",
      args: { query: "tech companies" },
    };
    expect(event.id).toBe("tc_abc-123");
    expect(event.name).toBe("search_leads");
  });

  it("SSEToolResultEvent includes matching id field", () => {
    const event: SSEToolResultEvent = {
      type: "tool_result",
      id: "tc_abc-123",
      name: "search_leads",
      result: { leads: [] },
    };
    expect(event.id).toBe("tc_abc-123");
    expect(event.name).toBe("search_leads");
  });

  it("SSEErrorEvent shape", () => {
    const event: SSEErrorEvent = {
      type: "error",
      message: "The AI model returned an empty response.",
    };
    expect(event.type).toBe("error");
    expect(event.message).toBe("The AI model returned an empty response.");
  });
});
