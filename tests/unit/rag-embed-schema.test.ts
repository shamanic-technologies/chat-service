import { describe, it, expect } from "vitest";
import {
  RagEmbedRequestSchema,
  RAG_EMBED_DOCUMENTS_MAX,
  RAG_EMBED_TEXT_MAX_CHARS,
} from "../../src/schemas.js";

function makeDocs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `doc-${i}`,
    text: `body ${i}`,
  }));
}

describe("RagEmbedRequestSchema", () => {
  it("accepts a minimal valid request", () => {
    const result = RagEmbedRequestSchema.safeParse({
      documents: [{ id: "a", text: "hello" }],
    });
    expect(result.success).toBe(true);
  });

  it(`accepts documents.length == ${RAG_EMBED_DOCUMENTS_MAX} (boundary)`, () => {
    const result = RagEmbedRequestSchema.safeParse({
      documents: makeDocs(RAG_EMBED_DOCUMENTS_MAX),
    });
    expect(result.success).toBe(true);
  });

  it(`rejects documents.length > ${RAG_EMBED_DOCUMENTS_MAX}`, () => {
    const result = RagEmbedRequestSchema.safeParse({
      documents: makeDocs(RAG_EMBED_DOCUMENTS_MAX + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toMatch(/at most/);
    }
  });

  it("rejects empty documents array", () => {
    const result = RagEmbedRequestSchema.safeParse({
      documents: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty document.text", () => {
    const result = RagEmbedRequestSchema.safeParse({
      documents: [{ id: "a", text: "" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty document.id", () => {
    const result = RagEmbedRequestSchema.safeParse({
      documents: [{ id: "", text: "hello" }],
    });
    expect(result.success).toBe(false);
  });

  it(`rejects document.text > ${RAG_EMBED_TEXT_MAX_CHARS} chars`, () => {
    const result = RagEmbedRequestSchema.safeParse({
      documents: [{ id: "a", text: "x".repeat(RAG_EMBED_TEXT_MAX_CHARS + 1) }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toMatch(/at most/);
    }
  });

  it(`accepts document.text == ${RAG_EMBED_TEXT_MAX_CHARS} chars (boundary)`, () => {
    const result = RagEmbedRequestSchema.safeParse({
      documents: [{ id: "a", text: "x".repeat(RAG_EMBED_TEXT_MAX_CHARS) }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown top-level fields (strict)", () => {
    const result = RagEmbedRequestSchema.safeParse({
      documents: [{ id: "a", text: "hello" }],
      sneaky: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown document fields (strict)", () => {
    const result = RagEmbedRequestSchema.safeParse({
      documents: [{ id: "a", text: "hello", extra: 1 }],
    });
    expect(result.success).toBe(false);
  });
});
