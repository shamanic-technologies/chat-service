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
 * their tools pass through untouched. Since SCHEMA-ANY-VENDOR-1116 Gemini gets
 * the tool on `parametersJsonSchema`, which took HEAVY and CALL_API whole
 * (200, probed live 2026-11-16): nothing is dropped any more.
 */
const post = vi.fn();
vi.mock("../../src/lib/openai-compatible.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/openai-compatible.js")>();
  return { ...real, postVendorChatCompletion: (args: unknown) => post(args) };
});

const { toGeminiFunctionDeclarations } = await import("../../src/lib/gemini-chat.js");
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

describe("google: brand tool schemas reach Gemini whole (parametersJsonSchema)", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("keeps the call_api tool's propertyNames / additionalProperties (the 2026-11-12 400 is gone with the field)", () => {
    const [decl] = toGeminiFunctionDeclarations([CALL_API]);
    expect(decl.name).toBe(CALL_API.name);
    expect(decl.parametersJsonSchema).toEqual({ type: "object", properties: CALL_API.input_schema.properties, required: ["method", "path"] });
  });

  it("sends HEAVY as is, only its dangling $ref dropped and its untyped const typed", () => {
    const [decl] = toGeminiFunctionDeclarations([HEAVY]);
    const props = decl.parametersJsonSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.ref).toEqual({});
    expect(props.mode).toEqual({ const: "x", type: "string" });
    const { ref: _r, mode: _m, ...rest } = HEAVY.input_schema.properties;
    const { ref: _r2, mode: _m2, ...sentRest } = props;
    expect(sentRest).toEqual(rest);
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
