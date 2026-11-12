import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * GEMINI-BRAND-TOOLS-1112 (prod 2026-11-12, distribute.you brand, LinkedIn post
 * script on gemini-flash-lite): the brand's MCP tool `call_api` carries a Zod
 * record (`propertyNames` + `additionalProperties`), Gemini answered 400
 * `Unknown name "propertyNames" at 'tools[0].function_declarations[27]...'` and
 * the completion 502'd. Every provider the Rating can pick must take the brand's
 * tools; the dialect is chat-service's to handle, per provider.
 *
 * Probed live 2026-11-12 with HEAVY below: DeepSeek V4.1 Flash, GLM-5.3 Flash,
 * Kimi K2.6 and GPT-6.1 Terra accept every keyword (200, tool call made), so
 * their tools pass through untouched; Gemini takes only its own Schema fields.
 */
const post = vi.fn();
vi.mock("../../src/lib/openai-compatible.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/openai-compatible.js")>();
  return { ...real, postVendorChatCompletion: (args: unknown) => post(args) };
});

const { toGeminiFunctionDeclarations } = await import("../../src/lib/gemini-chat.js");
const { sanitizeGeminiSchema } = await import("../../src/lib/gemini.js");
const { toVendorTools, streamVendorChat } = await import("../../src/lib/vendor-chat.js");

/** The distribute.you MCP `call_api` tool as listed live (index 27 of 28). */
const CALL_API = {
  name: "distribute_you_mcp__distribute_call_api",
  description: "Call any gateway operation.",
  input_schema: {
    type: "object" as const,
    properties: {
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      path: { type: "string", description: "Gateway path" },
      headers: { type: "object", propertyNames: { type: "string" }, additionalProperties: { type: "string" } },
    },
    required: ["method", "path"],
  },
};

/** Every JSON Schema keyword family Gemini's Schema has no field for. */
const HEAVY = {
  name: "heavy",
  description: "Every keyword.",
  input_schema: {
    type: "object" as const,
    properties: {
      headers: { type: "object", propertyNames: { type: "string" }, additionalProperties: { type: "string" } },
      mode: { const: "x" },
      maybe: { type: ["string", "null"] },
      either: { type: ["string", "number"] },
      ref: { $ref: "#/$defs/thing" },
      pat: { type: "object", patternProperties: { "^a": { type: "string" } }, unevaluatedProperties: false },
      cond: { type: "string", if: { minLength: 2 }, then: { pattern: "^a" }, else: { pattern: "^b" } },
      neg: { not: { type: "number" } },
      one: { oneOf: [{ type: "string" }, { type: "number" }] },
      all: { allOf: [{ type: "string" }, { minLength: 1 }] },
      num: { type: "number", exclusiveMinimum: 0, multipleOf: 2 },
      list: { type: "array", items: { type: "object", properties: { k: { type: "string", examples: ["e"] } } }, uniqueItems: true, contains: { type: "string" } },
      default: { type: "string", default: "d", readOnly: true, deprecated: true },
      const: { type: "string", $comment: "c" },
    },
    required: ["mode"],
  },
};

const GEMINI_FIELDS = new Set([
  "type", "format", "title", "description", "nullable", "enum", "maxItems", "minItems", "properties", "required",
  "minProperties", "maxProperties", "minLength", "maxLength", "pattern", "example", "anyOf", "propertyOrdering",
  "items", "minimum", "maximum",
]);

/** Every key of a schema node that is not a property NAME. */
function keywordsOf(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const n of node) keywordsOf(n, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    out.push(k);
    if (k === "properties" && v && typeof v === "object") for (const sub of Object.values(v as Record<string, unknown>)) keywordsOf(sub, out);
    else if (k === "items" || k === "anyOf") keywordsOf(v, out);
  }
  return out;
}

describe("google: brand tool schemas carry only Gemini's Schema fields", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("drops propertyNames from the call_api tool, keeps the tool, and logs it by name", () => {
    const [decl] = toGeminiFunctionDeclarations([CALL_API]);
    expect(decl.name).toBe(CALL_API.name);
    expect(JSON.stringify(decl.parameters)).not.toContain("propertyNames");
    expect(JSON.stringify(decl.parameters)).not.toContain("additionalProperties");
    expect((decl.parameters.properties as Record<string, unknown>).headers).toEqual({ type: "object" });
    expect(decl.parameters.required).toEqual(["method", "path"]);
    const line = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(line).toContain(CALL_API.name);
    expect(line).toContain("propertyNames");
  });

  it("leaves no keyword Gemini refuses, at any depth", () => {
    const [decl] = toGeminiFunctionDeclarations([HEAVY]);
    const unknown = keywordsOf(decl.parameters).filter((k) => !GEMINI_FIELDS.has(k));
    expect(unknown).toEqual([]);
  });

  it("keeps a property NAMED like a keyword (default, const)", () => {
    const [decl] = toGeminiFunctionDeclarations([HEAVY]);
    const props = decl.parameters.properties as Record<string, Record<string, unknown>>;
    expect(props.default).toEqual({ type: "string" });
    expect(props.const).toEqual({ type: "string" });
  });

  it("turns a JSON Schema type array into one type + nullable, or anyOf", () => {
    const [decl] = toGeminiFunctionDeclarations([HEAVY]);
    const props = decl.parameters.properties as Record<string, Record<string, unknown>>;
    expect(props.maybe).toEqual({ nullable: true, type: "string" });
    expect(props.either).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
  });

  it("is the same pass on /complete's responseSchema, and names what it removed", () => {
    const { schema, removed } = sanitizeGeminiSchema(HEAVY.input_schema as unknown as Record<string, unknown>);
    expect(keywordsOf(schema).filter((k) => !GEMINI_FIELDS.has(k))).toEqual([]);
    expect(removed).toEqual(expect.arrayContaining(["propertyNames", "additionalProperties", "const", "$ref", "if", "not", "oneOf", "allOf", "multipleOf"]));
  });
});

describe("deepseek / zai / moonshot / openai: full JSON Schema passes untouched (probed live)", () => {
  it("sends the brand tool's schema byte-equal", () => {
    for (const tool of [CALL_API, HEAVY]) {
      const [t] = toVendorTools([tool]);
      const fn = t.function as { parameters: Record<string, unknown> };
      expect(fn.parameters).toEqual({ type: "object", properties: tool.input_schema.properties, required: tool.input_schema.required });
    }
  });
});

describe("openai: tools need reasoning_effort none on chat/completions", () => {
  beforeEach(() => post.mockReset());

  const run = (vendor: "openai" | "deepseek", model: string, tools: typeof CALL_API[]) =>
    streamVendorChat({
      vendor,
      apiKey: "k",
      model,
      costPrefix: "p",
      systemPrompt: "SYS",
      turnContext: "",
      history: [],
      userMessage: "hi",
      tools,
      res: {} as never,
      sendSSE: () => {},
      executeTool: vi.fn(),
      signal: new AbortController().signal,
      beforeProviderCall: async () => {},
    });

  const reply = (model: string) => ({ model, choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } });

  it("adds it for gpt-6.1-terra when tools are declared", async () => {
    post.mockResolvedValue(reply("gpt-6.1-terra"));
    await run("openai", "gpt-6.1-terra", [CALL_API]);
    expect(post.mock.calls[0][0].body.reasoning_effort).toBe("none");
  });

  it("adds nothing without tools, nor on another vendor", async () => {
    post.mockResolvedValue(reply("gpt-6.1-terra"));
    await run("openai", "gpt-6.1-terra", []);
    expect(post.mock.calls[0][0].body.reasoning_effort).toBeUndefined();
    post.mockReset();
    post.mockResolvedValue(reply("deepseek-flash"));
    await run("deepseek", "deepseek-flash", [CALL_API]);
    expect(post.mock.calls[0][0].body.reasoning_effort).toBeUndefined();
  });
});
