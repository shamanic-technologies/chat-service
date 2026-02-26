import { describe, it, expect } from "vitest";
import type {
  ChatRequest,
  SSETokenEvent,
  SSEButtonsEvent,
  SSEInputRequestEvent,
} from "../../src/types.js";

describe("types", () => {
  it("ChatRequest shape requires appId", () => {
    const req: ChatRequest = { message: "hello", appId: "my-app" };
    expect(req.message).toBe("hello");
    expect(req.appId).toBe("my-app");
    expect(req.sessionId).toBeUndefined();
    expect(req.context).toBeUndefined();
  });

  it("ChatRequest with all optional fields", () => {
    const req: ChatRequest = {
      message: "hi",
      appId: "my-app",
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
});
