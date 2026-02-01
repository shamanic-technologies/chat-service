import { describe, it, expect } from "vitest";
import type { ChatRequest, SSETokenEvent, SSEButtonsEvent } from "../../src/types.js";

describe("types", () => {
  it("ChatRequest shape is valid", () => {
    const req: ChatRequest = { message: "hello" };
    expect(req.message).toBe("hello");
    expect(req.sessionId).toBeUndefined();
  });

  it("ChatRequest with sessionId", () => {
    const req: ChatRequest = { message: "hi", sessionId: "abc-123" };
    expect(req.sessionId).toBe("abc-123");
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
});
