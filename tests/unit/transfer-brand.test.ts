import { describe, it, expect } from "vitest";
import { TransferBrandRequestSchema } from "../../src/schemas.js";

describe("TransferBrandRequestSchema", () => {
  it("accepts valid request with required fields only", () => {
    const result = TransferBrandRequestSchema.safeParse({
      sourceBrandId: "brand-abc",
      sourceOrgId: "org-source",
      targetOrgId: "org-target",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sourceBrandId).toBe("brand-abc");
      expect(result.data.sourceOrgId).toBe("org-source");
      expect(result.data.targetOrgId).toBe("org-target");
      expect(result.data.targetBrandId).toBeUndefined();
    }
  });

  it("accepts valid request with targetBrandId (conflict case)", () => {
    const result = TransferBrandRequestSchema.safeParse({
      sourceBrandId: "brand-abc",
      sourceOrgId: "org-source",
      targetOrgId: "org-target",
      targetBrandId: "brand-xyz",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.targetBrandId).toBe("brand-xyz");
    }
  });

  it("rejects missing sourceBrandId", () => {
    const result = TransferBrandRequestSchema.safeParse({
      sourceOrgId: "org-source",
      targetOrgId: "org-target",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing sourceOrgId", () => {
    const result = TransferBrandRequestSchema.safeParse({
      sourceBrandId: "brand-abc",
      targetOrgId: "org-target",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing targetOrgId", () => {
    const result = TransferBrandRequestSchema.safeParse({
      sourceBrandId: "brand-abc",
      sourceOrgId: "org-source",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty sourceBrandId", () => {
    const result = TransferBrandRequestSchema.safeParse({
      sourceBrandId: "",
      sourceOrgId: "org-source",
      targetOrgId: "org-target",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty targetBrandId when provided", () => {
    const result = TransferBrandRequestSchema.safeParse({
      sourceBrandId: "brand-abc",
      sourceOrgId: "org-source",
      targetOrgId: "org-target",
      targetBrandId: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra fields (strict mode)", () => {
    const result = TransferBrandRequestSchema.safeParse({
      sourceBrandId: "brand-abc",
      sourceOrgId: "org-source",
      targetOrgId: "org-target",
      extraField: "should-fail",
    });
    expect(result.success).toBe(false);
  });

  it("rejects old brandId field name", () => {
    const result = TransferBrandRequestSchema.safeParse({
      brandId: "brand-abc",
      sourceOrgId: "org-source",
      targetOrgId: "org-target",
    });
    expect(result.success).toBe(false);
  });
});
