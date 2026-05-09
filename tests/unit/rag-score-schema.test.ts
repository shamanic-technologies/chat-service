import { describe, it, expect } from "vitest";
import {
  RagScoreRequestSchema,
  RAG_SCORE_DOCUMENTS_MAX,
} from "../../src/schemas.js";

const validBrandId = "550e8400-e29b-41d4-a716-446655440000";

function makeDocs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `doc-${i}`,
    text: `body ${i}`,
  }));
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
});
