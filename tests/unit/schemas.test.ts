import { describe, it, expect } from "vitest";
import { ChatRequestSchema } from "../../src/schemas.js";

describe("ChatRequestSchema", () => {
  it("accepts valid request with message", () => {
    const result = ChatRequestSchema.safeParse({
      message: "Hello",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message).toBe("Hello");
      expect(result.data.sessionId).toBeUndefined();
      expect(result.data.context).toBeUndefined();
    }
  });

  it("accepts valid request with all fields", () => {
    const result = ChatRequestSchema.safeParse({
      message: "Hello",
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      context: { brandUrl: "https://example.com", budget: 500 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.context).toEqual({
        brandUrl: "https://example.com",
        budget: 500,
      });
    }
  });

  it("rejects empty message", () => {
    const result = ChatRequestSchema.safeParse({
      message: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing message", () => {
    const result = ChatRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("does not require appId (removed from contract)", () => {
    const result = ChatRequestSchema.safeParse({ message: "Hello" });
    expect(result.success).toBe(true);
  });

  it("accepts sessionId: null (reset chat sends null)", () => {
    const result = ChatRequestSchema.safeParse({
      message: "Hello",
      sessionId: null,
      context: { type: "workflow-viewer", workflowId: "wf-123" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessionId).toBeNull();
      expect(result.data.context).toEqual({
        type: "workflow-viewer",
        workflowId: "wf-123",
      });
    }
  });

  it("rejects non-uuid sessionId", () => {
    const result = ChatRequestSchema.safeParse({
      message: "Hello",
      sessionId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("accepts context with any JSON structure", () => {
    const result = ChatRequestSchema.safeParse({
      message: "Hello",
      context: {
        nested: { deep: true },
        array: [1, 2, 3],
        nullVal: null,
      },
    });
    expect(result.success).toBe(true);
  });

  it("strips extra fields", () => {
    const result = ChatRequestSchema.safeParse({
      message: "Hello",
      extra: "field",
      appId: "leftover-app-id",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).extra).toBeUndefined();
      expect((result.data as Record<string, unknown>).appId).toBeUndefined();
    }
  });
});
