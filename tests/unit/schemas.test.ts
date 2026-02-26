import { describe, it, expect } from "vitest";
import { ChatRequestSchema } from "../../src/schemas.js";

describe("ChatRequestSchema", () => {
  it("accepts valid request with message and appId", () => {
    const result = ChatRequestSchema.safeParse({
      message: "Hello",
      appId: "my-app",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message).toBe("Hello");
      expect(result.data.appId).toBe("my-app");
      expect(result.data.sessionId).toBeUndefined();
      expect(result.data.context).toBeUndefined();
    }
  });

  it("accepts valid request with all fields", () => {
    const result = ChatRequestSchema.safeParse({
      message: "Hello",
      appId: "my-app",
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
      appId: "my-app",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing message", () => {
    const result = ChatRequestSchema.safeParse({ appId: "my-app" });
    expect(result.success).toBe(false);
  });

  it("rejects missing appId", () => {
    const result = ChatRequestSchema.safeParse({ message: "Hello" });
    expect(result.success).toBe(false);
  });

  it("rejects empty appId", () => {
    const result = ChatRequestSchema.safeParse({
      message: "Hello",
      appId: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-uuid sessionId", () => {
    const result = ChatRequestSchema.safeParse({
      message: "Hello",
      appId: "my-app",
      sessionId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("accepts context with any JSON structure", () => {
    const result = ChatRequestSchema.safeParse({
      message: "Hello",
      appId: "my-app",
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
      appId: "my-app",
      extra: "field",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).extra).toBeUndefined();
    }
  });
});
