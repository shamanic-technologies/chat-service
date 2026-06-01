import { describe, it, expect } from "vitest";
import {
  sanitizeGeminiToolResponse,
  toGeminiHistory,
  type GeminiHistoryInput,
} from "../../src/lib/gemini-chat.js";

describe("sanitizeGeminiToolResponse — neutralize $ref so Gemini 3 doesn't treat it as a part reference", () => {
  it("renames a top-level $ref key to ref", () => {
    expect(sanitizeGeminiToolResponse({ $ref: "#/components/schemas/OrgId" })).toEqual({
      ref: "#/components/schemas/OrgId",
    });
  });

  it("renames $ref nested in objects and arrays", () => {
    const input = {
      paths: {
        "/v1/orgs": {
          get: {
            parameters: [{ schema: { $ref: "#/components/schemas/OrgId" } }],
          },
        },
      },
    };
    const out = sanitizeGeminiToolResponse(input) as any;
    expect(out.paths["/v1/orgs"].get.parameters[0].schema).toEqual({
      ref: "#/components/schemas/OrgId",
    });
    expect(JSON.stringify(out)).not.toContain('"$ref"');
  });

  it("preserves the $ref value (information not lost)", () => {
    const out = sanitizeGeminiToolResponse({ $ref: "#/components/schemas/Foo" }) as any;
    expect(out.ref).toBe("#/components/schemas/Foo");
  });

  it("falls back to schemaRef when a sibling ref key already exists", () => {
    const out = sanitizeGeminiToolResponse({ $ref: "#/a", ref: "keep" }) as any;
    expect(out.ref).toBe("keep");
    expect(out.schemaRef).toBe("#/a");
  });

  it("leaves non-$ref data untouched", () => {
    const input = { name: "x", count: 3, nested: { ok: true }, list: [1, 2] };
    expect(sanitizeGeminiToolResponse(input)).toEqual(input);
  });

  it("passes primitives through", () => {
    expect(sanitizeGeminiToolResponse("hello")).toBe("hello");
    expect(sanitizeGeminiToolResponse(42)).toBe(42);
    expect(sanitizeGeminiToolResponse(null)).toBe(null);
  });

  it("does NOT touch a plain string value that merely contains a ref-like path", () => {
    // Only the `$ref` KEY form triggers Gemini's part-resolution; a bare string is fine.
    const input = { error: "bad input at #/components/schemas/OrgId" };
    expect(sanitizeGeminiToolResponse(input)).toEqual(input);
  });
});

describe("toGeminiHistory — replayed tool results are $ref-sanitized", () => {
  it("strips $ref from a stored functionResponse on replay (Gemini 3 400 guard)", () => {
    const msgs: GeminiHistoryInput = [
      { role: "user", content: "list endpoints" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            name: "get_endpoint_details",
            args: {},
            result: { schema: { $ref: "#/components/schemas/OrgId" } },
          },
        ],
      },
    ];
    const result = toGeminiHistory(msgs);
    const responsePart = result[2].parts[0] as { functionResponse: { response: unknown } };
    expect(JSON.stringify(responsePart.functionResponse.response)).not.toContain('"$ref"');
    expect(responsePart.functionResponse.response).toEqual({
      schema: { ref: "#/components/schemas/OrgId" },
    });
  });
});
