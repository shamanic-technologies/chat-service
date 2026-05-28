import { describe, it, expect } from "vitest";
import {
  RagScoreRequestSchema,
  RAG_SCORE_DOCUMENTS_MAX,
  RAG_SCORE_BRAND_IDS_MAX,
} from "../../src/schemas.js";

const validBrandId = "550e8400-e29b-41d4-a716-446655440000";
const validBrandId2 = "660f9500-f30c-42e5-b827-557766551111";
const validBrandId3 = "770fa600-040d-43e5-a938-668877662222";

function makeDocs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `doc-${i}`,
    text: `body ${i}`,
  }));
}

function makeBrandIds(n: number) {
  // Deterministic, valid v4-shaped UUIDs (variant nibble 8/9/a/b — Zod is variant-strict).
  return Array.from({ length: n }, (_, i) => {
    const hex = i.toString(16).padStart(2, "0");
    return `aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee${hex}`;
  });
}

describe("RagScoreRequestSchema", () => {
  it("accepts a minimal valid request", () => {
    const result = RagScoreRequestSchema.safeParse({
      brandId: validBrandId,
      documents: [{ id: "a", text: "hello" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an optional query override", () => {
    const result = RagScoreRequestSchema.safeParse({
      brandId: validBrandId,
      documents: [{ id: "a", text: "hello" }],
      query: "B2B SaaS pricing experiments",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.query).toBe("B2B SaaS pricing experiments");
    }
  });

  it("rejects empty documents array", () => {
    const result = RagScoreRequestSchema.safeParse({
      brandId: validBrandId,
      documents: [],
    });
    expect(result.success).toBe(false);
  });

  it(`rejects documents.length > ${RAG_SCORE_DOCUMENTS_MAX}`, () => {
    const result = RagScoreRequestSchema.safeParse({
      brandId: validBrandId,
      documents: makeDocs(RAG_SCORE_DOCUMENTS_MAX + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toMatch(/at most/);
    }
  });

  it(`accepts documents.length == ${RAG_SCORE_DOCUMENTS_MAX} (boundary)`, () => {
    const result = RagScoreRequestSchema.safeParse({
      brandId: validBrandId,
      documents: makeDocs(RAG_SCORE_DOCUMENTS_MAX),
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-uuid brandId", () => {
    const result = RagScoreRequestSchema.safeParse({
      brandId: "not-a-uuid",
      documents: [{ id: "a", text: "hello" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty document.text", () => {
    const result = RagScoreRequestSchema.safeParse({
      brandId: validBrandId,
      documents: [{ id: "a", text: "" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty document.id", () => {
    const result = RagScoreRequestSchema.safeParse({
      brandId: validBrandId,
      documents: [{ id: "", text: "hello" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level fields (strict)", () => {
    const result = RagScoreRequestSchema.safeParse({
      brandId: validBrandId,
      documents: [{ id: "a", text: "hello" }],
      sneaky: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown document fields (strict)", () => {
    const result = RagScoreRequestSchema.safeParse({
      brandId: validBrandId,
      documents: [{ id: "a", text: "hello", extra: 1 }],
    });
    expect(result.success).toBe(false);
  });

  // --- Multi-brand (brandIds) ---

  it("accepts brandIds alone (preferred path)", () => {
    const result = RagScoreRequestSchema.safeParse({
      brandIds: [validBrandId, validBrandId2],
      documents: [{ id: "a", text: "hello" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.brandIds).toEqual([validBrandId, validBrandId2]);
      expect(result.data.brandId).toBeUndefined();
    }
  });

  it("accepts both brandIds and brandId (handler picks brandIds)", () => {
    const result = RagScoreRequestSchema.safeParse({
      brandIds: [validBrandId, validBrandId2],
      brandId: validBrandId3,
      documents: [{ id: "a", text: "hello" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.brandIds).toEqual([validBrandId, validBrandId2]);
      expect(result.data.brandId).toBe(validBrandId3);
    }
  });

  it("rejects when neither brandIds nor brandId is provided", () => {
    const result = RagScoreRequestSchema.safeParse({
      documents: [{ id: "a", text: "hello" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toMatch(/brandIds.*brandId/);
    }
  });

  it("rejects empty brandIds array", () => {
    const result = RagScoreRequestSchema.safeParse({
      brandIds: [],
      documents: [{ id: "a", text: "hello" }],
    });
    expect(result.success).toBe(false);
  });

  it(`rejects brandIds.length > ${RAG_SCORE_BRAND_IDS_MAX}`, () => {
    const result = RagScoreRequestSchema.safeParse({
      brandIds: makeBrandIds(RAG_SCORE_BRAND_IDS_MAX + 1),
      documents: [{ id: "a", text: "hello" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toMatch(/at most/);
    }
  });

  it(`accepts brandIds.length == ${RAG_SCORE_BRAND_IDS_MAX} (boundary)`, () => {
    const result = RagScoreRequestSchema.safeParse({
      brandIds: makeBrandIds(RAG_SCORE_BRAND_IDS_MAX),
      documents: [{ id: "a", text: "hello" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-uuid entries in brandIds", () => {
    const result = RagScoreRequestSchema.safeParse({
      brandIds: [validBrandId, "not-a-uuid"],
      documents: [{ id: "a", text: "hello" }],
    });
    expect(result.success).toBe(false);
  });
});
