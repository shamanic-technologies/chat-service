import { describe, it, expect } from "vitest";
import { parseGeminiSSEBuffer } from "../../src/lib/gemini-chat.js";

const textChunk = (t: string) =>
  JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] });

describe("parseGeminiSSEBuffer — SSE framing (mirrors @google/genai)", () => {
  it("parses \\r\\n\\r\\n-framed events (the real Gemini wire format — regression)", () => {
    // Before the fix the parser split only on "\n\n" and produced ZERO chunks
    // for this framing, yielding an empty chat response.
    const buf = `data: ${textChunk("Hello")}\r\n\r\ndata: ${textChunk(" world")}\r\n\r\n`;
    const { chunks, rest } = parseGeminiSSEBuffer(buf);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].candidates?.[0]?.content?.parts?.[0]?.text).toBe("Hello");
    expect(chunks[1].candidates?.[0]?.content?.parts?.[0]?.text).toBe(" world");
    expect(rest).toBe("");
  });

  it("parses \\r\\r-framed events", () => {
    const buf = `data: ${textChunk("a")}\r\rdata: ${textChunk("b")}\r\r`;
    const { chunks } = parseGeminiSSEBuffer(buf);
    expect(chunks.map((c) => c.candidates?.[0]?.content?.parts?.[0]?.text)).toEqual(["a", "b"]);
  });

  it("still parses \\n\\n-framed events", () => {
    const buf = `data: ${textChunk("x")}\n\n`;
    const { chunks } = parseGeminiSSEBuffer(buf);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].candidates?.[0]?.content?.parts?.[0]?.text).toBe("x");
  });

  it("tolerates `data:` with no trailing space", () => {
    const buf = `data:${textChunk("nospace")}\r\n\r\n`;
    const { chunks } = parseGeminiSSEBuffer(buf);
    expect(chunks[0].candidates?.[0]?.content?.parts?.[0]?.text).toBe("nospace");
  });

  it("preserves a partial trailing event in rest", () => {
    const buf = `data: ${textChunk("done")}\r\n\r\ndata: ${textChunk("partial")}`;
    const { chunks, rest } = parseGeminiSSEBuffer(buf);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].candidates?.[0]?.content?.parts?.[0]?.text).toBe("done");
    expect(rest).toBe(`data: ${textChunk("partial")}`);
  });

  it("skips the [DONE] sentinel", () => {
    const buf = `data: ${textChunk("y")}\r\n\r\ndata: [DONE]\r\n\r\n`;
    const { chunks } = parseGeminiSSEBuffer(buf);
    expect(chunks).toHaveLength(1);
  });

  it("surfaces an in-band error payload (HTTP 200 + error chunk)", () => {
    const buf = `data: ${JSON.stringify({ error: { code: 400, message: "bad thinkingConfig" } })}\r\n\r\n`;
    const { chunks, errorMessage } = parseGeminiSSEBuffer(buf);
    expect(chunks).toHaveLength(0);
    expect(errorMessage).toBe("bad thinkingConfig");
  });

  it("extracts usageMetadata chunks", () => {
    const buf = `data: ${JSON.stringify({ usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5 } })}\r\n\r\n`;
    const { chunks } = parseGeminiSSEBuffer(buf);
    expect(chunks[0].usageMetadata?.promptTokenCount).toBe(12);
  });
});
