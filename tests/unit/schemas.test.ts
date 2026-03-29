import { describe, it, expect } from "vitest";
import { ChatRequestSchema } from "../../src/schemas.js";

describe("ChatRequestSchema", () => {
  it("accepts valid request with configKey and message", () => {
    const result = ChatRequestSchema.safeParse({
      configKey: "workflow",
      message: "Hello",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.configKey).toBe("workflow");
      expect(result.data.message).toBe("Hello");
      expect(result.data.sessionId).toBeUndefined();
      expect(result.data.context).toBeUndefined();
    }
  });

  it("accepts valid request with all fields", () => {
    const result = ChatRequestSchema.safeParse({
      configKey: "workflow",
      message: "Hello",
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      context: { workflowId: "wf-123", brandUrl: "https://example.com" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.configKey).toBe("workflow");
      expect(result.data.context).toEqual({
        workflowId: "wf-123",
        brandUrl: "https://example.com",
      });
    }
  });

  it("defaults configKey to 'default' when omitted", () => {
    const result = ChatRequestSchema.safeParse({
      message: "Hello",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.configKey).toBe("default");
    }
  });

  it("rejects empty configKey", () => {
    const result = ChatRequestSchema.safeParse({
      configKey: "",
      message: "Hello",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty message", () => {
    const result = ChatRequestSchema.safeParse({
      configKey: "workflow",
      message: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing message", () => {
    const result = ChatRequestSchema.safeParse({
      configKey: "workflow",
    });
    expect(result.success).toBe(false);
  });

  it("accepts sessionId: null (reset chat sends null)", () => {
    const result = ChatRequestSchema.safeParse({
      configKey: "feature",
      message: "Hello",
      sessionId: null,
      context: { featureSlug: "cold-email-outreach" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessionId).toBeNull();
    }
  });

  it("rejects non-uuid sessionId", () => {
    const result = ChatRequestSchema.safeParse({
      configKey: "workflow",
      message: "Hello",
      sessionId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("accepts context with any JSON structure", () => {
    const result = ChatRequestSchema.safeParse({
      configKey: "workflow",
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
      configKey: "workflow",
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
