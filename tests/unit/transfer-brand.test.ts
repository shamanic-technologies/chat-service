import { describe, it, expect } from "vitest";
import { TransferBrandRequestSchema } from "../../src/schemas.js";

describe("TransferBrandRequestSchema", () => {
  it("accepts valid request with all required fields", () => {
    const result = TransferBrandRequestSchema.safeParse({
      brandId: "brand-abc",
      sourceOrgId: "org-source",
      targetOrgId: "org-target",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.brandId).toBe("brand-abc");
      expect(result.data.sourceOrgId).toBe("org-source");
      expect(result.data.targetOrgId).toBe("org-target");
    }
  });

  it("rejects missing brandId", () => {
    const result = TransferBrandRequestSchema.safeParse({
      sourceOrgId: "org-source",
      targetOrgId: "org-target",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing sourceOrgId", () => {
    const result = TransferBrandRequestSchema.safeParse({
      brandId: "brand-abc",
      targetOrgId: "org-target",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing targetOrgId", () => {
    const result = TransferBrandRequestSchema.safeParse({
      brandId: "brand-abc",
      sourceOrgId: "org-source",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty brandId", () => {
    const result = TransferBrandRequestSchema.safeParse({
      brandId: "",
      sourceOrgId: "org-source",
      targetOrgId: "org-target",
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra fields (strict mode)", () => {
    const result = TransferBrandRequestSchema.safeParse({
      brandId: "brand-abc",
      sourceOrgId: "org-source",
      targetOrgId: "org-target",
      extraField: "should-fail",
    });
    expect(result.success).toBe(false);
  });
});
