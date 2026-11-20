import { describe, it, expect } from "vitest";
import { TransferBrandRequestSchema } from "../../src/schemas.js";

describe("TransferBrandRequestSchema", () => {
  it("accepts valid request with required fields only", () => {
    const result = TransferBrandRequestSchema.safeParse({
      sourceBrandId: "0b0b0b0b-0000-4000-8000-00000000000a",
      sourceOrgId: "0c0c0c0c-0000-4000-8000-00000000000a",
      targetOrgId: "0c0c0c0c-0000-4000-8000-00000000000b",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sourceBrandId).toBe("0b0b0b0b-0000-4000-8000-00000000000a");
      expect(result.data.sourceOrgId).toBe("0c0c0c0c-0000-4000-8000-00000000000a");
      expect(result.data.targetOrgId).toBe("0c0c0c0c-0000-4000-8000-00000000000b");
      expect(result.data.targetBrandId).toBeUndefined();
    }
  });

  it("accepts valid request with targetBrandId (conflict case)", () => {
    const result = TransferBrandRequestSchema.safeParse({
      sourceBrandId: "0b0b0b0b-0000-4000-8000-00000000000a",
      sourceOrgId: "0c0c0c0c-0000-4000-8000-00000000000a",
      targetOrgId: "0c0c0c0c-0000-4000-8000-00000000000b",
      targetBrandId: "0b0b0b0b-0000-4000-8000-00000000000b",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.targetBrandId).toBe("0b0b0b0b-0000-4000-8000-00000000000b");
    }
  });

  it("rejects missing sourceBrandId", () => {
    const result = TransferBrandRequestSchema.safeParse({
      sourceOrgId: "0c0c0c0c-0000-4000-8000-00000000000a",
      targetOrgId: "0c0c0c0c-0000-4000-8000-00000000000b",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing sourceOrgId", () => {
    const result = TransferBrandRequestSchema.safeParse({
      sourceBrandId: "0b0b0b0b-0000-4000-8000-00000000000a",
      targetOrgId: "0c0c0c0c-0000-4000-8000-00000000000b",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing targetOrgId", () => {
    const result = TransferBrandRequestSchema.safeParse({
      sourceBrandId: "0b0b0b0b-0000-4000-8000-00000000000a",
      sourceOrgId: "0c0c0c0c-0000-4000-8000-00000000000a",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty sourceBrandId", () => {
    const result = TransferBrandRequestSchema.safeParse({
      sourceBrandId: "",
      sourceOrgId: "0c0c0c0c-0000-4000-8000-00000000000a",
      targetOrgId: "0c0c0c0c-0000-4000-8000-00000000000b",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty targetBrandId when provided", () => {
    const result = TransferBrandRequestSchema.safeParse({
      sourceBrandId: "0b0b0b0b-0000-4000-8000-00000000000a",
      sourceOrgId: "0c0c0c0c-0000-4000-8000-00000000000a",
      targetOrgId: "0c0c0c0c-0000-4000-8000-00000000000b",
      targetBrandId: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra fields (strict mode)", () => {
    const result = TransferBrandRequestSchema.safeParse({
      sourceBrandId: "0b0b0b0b-0000-4000-8000-00000000000a",
      sourceOrgId: "0c0c0c0c-0000-4000-8000-00000000000a",
      targetOrgId: "0c0c0c0c-0000-4000-8000-00000000000b",
      extraField: "should-fail",
    });
    expect(result.success).toBe(false);
  });

  it("rejects old brandId field name", () => {
    const result = TransferBrandRequestSchema.safeParse({
      brandId: "0b0b0b0b-0000-4000-8000-00000000000a",
      sourceOrgId: "0c0c0c0c-0000-4000-8000-00000000000a",
      targetOrgId: "0c0c0c0c-0000-4000-8000-00000000000b",
    });
    expect(result.success).toBe(false);
  });

  // SEC-CHAT-IDENTITY-1120: the attacker's probes carried SQL in these fields.
  it("rejects ids that are not UUIDs", () => {
    const result = TransferBrandRequestSchema.safeParse({
      sourceBrandId: "x' OR 1=1--",
      sourceOrgId: "0c0c0c0c-0000-4000-8000-00000000000a' OR 1=1--",
      targetOrgId: "0c0c0c0c-0000-4000-8000-00000000000b",
    });
    expect(result.success).toBe(false);
  });
});
