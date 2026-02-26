import { describe, it, expect } from "vitest";
import { ChatRequestSchema } from "../../src/schemas.js";

describe("ChatRequestSchema", () => {
  it("accepts valid request with message only", () => {
    const result = ChatRequestSchema.safeParse({ message: "Hello", appId: "mcpfactory" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message).toBe("Hello");
      expect(result.data.appId).toBe("mcpfactory");
      expect(result.data.sessionId).toBeUndefined();
    }
  });

  it("accepts valid request with message and sessionId", () => {
    const result = ChatRequestSchema.safeParse({
      message: "Hello",
      appId: "mcpfactory",
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty message", () => {
    const result = ChatRequestSchema.safeParse({ message: "", appId: "mcpfactory" });
    expect(result.success).toBe(false);
  });

  it("rejects missing message", () => {
    const result = ChatRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects missing appId", () => {
    const result = ChatRequestSchema.safeParse({ message: "Hello" });
    expect(result.success).toBe(false);
  });

  it("rejects non-uuid sessionId", () => {
    const result = ChatRequestSchema.safeParse({
      message: "Hello",
      appId: "mcpfactory",
      sessionId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("strips extra fields", () => {
    const result = ChatRequestSchema.safeParse({
      message: "Hello",
      appId: "mcpfactory",
      extra: "field",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).extra).toBeUndefined();
    }
  });
});
