import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock stream object returned by client.messages.stream()
function createMockStream(events: unknown[], finalMsg: unknown) {
  return {
    [Symbol.asyncIterator]: () => {
      let i = 0;
      return {
        async next() {
          if (i < events.length) return { value: events[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
    finalMessage: vi.fn().mockResolvedValue(finalMsg),
  };
}

const mockStream = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      stream: mockStream,
    },
  })),
}));

import {
  createAnthropicClient,
  buildSystemPrompt,
  MODEL,
  COST_PREFIX,
  SUPPORTED_MODELS,
  costPrefixForModel,
  REQUEST_USER_INPUT_TOOL,
  UPDATE_WORKFLOW_TOOL,
  VALIDATE_WORKFLOW_TOOL,
  CREATE_FEATURE_TOOL,
  UPDATE_FEATURE_TOOL,
  LIST_FEATURES_TOOL,
  GET_FEATURE_TOOL,
  LIST_SERVICES_TOOL,
  LIST_SERVICE_ENDPOINTS_TOOL,
  LIST_ORG_KEYS_TOOL,
  GET_KEY_SOURCE_TOOL,
  LIST_KEY_SOURCES_TOOL,
  CHECK_PROVIDER_REQUIREMENTS_TOOL,
  TOOL_REGISTRY,
  AVAILABLE_TOOL_NAMES,
  resolveToolSet,
} from "../../src/lib/anthropic.js";

const TEST_PROMPT = "You are a test assistant.";

describe("COST_PREFIX", () => {
  it("follows costs-service naming convention: {provider}-{model}-tokens-{direction}", () => {
    // costs-service expects "anthropic-sonnet-4.6", not "claude-sonnet-4-6"
    expect(COST_PREFIX).toBe("anthropic-sonnet-4.6");
    // Must NOT match the Anthropic API model ID (which uses claude- prefix and hyphens)
    expect(COST_PREFIX).not.toBe(MODEL);
    expect(COST_PREFIX).not.toContain("claude-");
    expect(COST_PREFIX).toMatch(/^anthropic-/);
  });
});

describe("SUPPORTED_MODELS", () => {
  it("maps all supported model IDs to cost prefixes", () => {
    expect(SUPPORTED_MODELS["claude-sonnet-4-6"]).toBe("anthropic-sonnet-4.6");
    expect(SUPPORTED_MODELS["claude-haiku-4-5"]).toBe("anthropic-haiku-4.5");
  });

  it("includes the default model", () => {
    expect(SUPPORTED_MODELS[MODEL]).toBe(COST_PREFIX);
  });
});

describe("costPrefixForModel", () => {
  it("returns correct prefix for known models", () => {
    expect(costPrefixForModel("claude-sonnet-4-6")).toBe("anthropic-sonnet-4.6");
    expect(costPrefixForModel("claude-haiku-4-5")).toBe("anthropic-haiku-4.5");
  });

  it("falls back to default COST_PREFIX for unknown models", () => {
    expect(costPrefixForModel("unknown-model")).toBe(COST_PREFIX);
  });
});

describe("createAnthropicClient", () => {
  beforeEach(() => {
    mockStream.mockReturnValue(
      createMockStream([], {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    );
  });

  it("exposes the correct model", () => {
    const client = createAnthropicClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });
    expect(client.model).toBe("claude-sonnet-4-6");
  });

  it("passes model and systemPrompt to stream", () => {
    const client = createAnthropicClient({
      apiKey: "test-key",
      systemPrompt: "Custom prompt.",
    });
    client.createStream(
      [{ role: "user", content: "hello" }],
    );

    const callArgs = mockStream.mock.calls.at(-1)?.[0];
    expect(callArgs.model).toBe(MODEL);
    expect(callArgs.system).toEqual([
      {
        type: "text",
        text: "Custom prompt.",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("uses adaptive thinking", () => {
    const client = createAnthropicClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });
    client.createStream([{ role: "user", content: "hello" }]);

    const callArgs = mockStream.mock.calls.at(-1)?.[0];
    expect(callArgs.thinking).toEqual({ type: "adaptive" });
  });

  it("includes context management for compaction", () => {
    const client = createAnthropicClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });
    client.createStream([{ role: "user", content: "hello" }]);

    const callArgs = mockStream.mock.calls.at(-1)?.[0];
    expect(callArgs.context_management).toBeDefined();
    expect(callArgs.context_management.edits).toHaveLength(3);

    const editTypes = callArgs.context_management.edits.map(
      (e: { type: string }) => e.type,
    );
    // clear_thinking must be first per API requirement
    expect(editTypes).toEqual([
      "clear_thinking_20251015",
      "compact_20260112",
      "clear_tool_uses_20250919",
    ]);
  });

  it("passes beta headers for compaction", () => {
    const client = createAnthropicClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });
    client.createStream([{ role: "user", content: "hello" }]);

    const opts = mockStream.mock.calls.at(-1)?.[1];
    expect(opts.headers["anthropic-beta"]).toContain("compact-2026-01-12");
    expect(opts.headers["anthropic-beta"]).toContain(
      "context-management-2025-06-27",
    );
  });

  it("forwards abort signal to stream options", () => {
    const client = createAnthropicClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });
    const ac = new AbortController();
    client.createStream([{ role: "user", content: "hello" }], undefined, ac.signal);

    const opts = mockStream.mock.calls.at(-1)?.[1];
    expect(opts.signal).toBe(ac.signal);
  });

  it("passes tools when provided", () => {
    const client = createAnthropicClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });
    const tools = [
      {
        name: "test_tool",
        description: "test",
        input_schema: { type: "object" as const, properties: {} },
      },
    ];
    client.createStream(
      [{ role: "user", content: "hello" }],
      tools,
    );

    const callArgs = mockStream.mock.calls.at(-1)?.[0];
    expect(callArgs.tools).toEqual(tools);
  });

  it("omits tools when empty array provided", () => {
    const client = createAnthropicClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });
    client.createStream([{ role: "user", content: "hello" }], []);

    const callArgs = mockStream.mock.calls.at(-1)?.[0];
    expect(callArgs.tools).toBeUndefined();
  });
});

describe("streaming events", () => {
  it("streams thinking and text events correctly", async () => {
    const events = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "thinking_delta",
          thinking: "Let me think about this...",
        },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Here is my response." },
      },
      { type: "content_block_stop", index: 1 },
    ];

    const finalMsg = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Here is my response." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 20 },
    };

    mockStream.mockReturnValue(createMockStream(events, finalMsg));

    const client = createAnthropicClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });
    const stream = client.createStream([
      { role: "user", content: "hello" },
    ]);

    const collected: unknown[] = [];
    for await (const event of stream) {
      collected.push(event);
    }

    // Verify thinking events are present
    expect(collected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "content_block_start",
          content_block: expect.objectContaining({ type: "thinking" }),
        }),
        expect.objectContaining({
          type: "content_block_delta",
          delta: expect.objectContaining({
            type: "thinking_delta",
            thinking: "Let me think about this...",
          }),
        }),
      ]),
    );

    // Verify text events
    expect(collected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "content_block_delta",
          delta: expect.objectContaining({
            type: "text_delta",
            text: "Here is my response.",
          }),
        }),
      ]),
    );

    // Verify finalMessage
    const final = await stream.finalMessage();
    expect(final.usage.input_tokens).toBe(10);
    expect(final.usage.output_tokens).toBe(20);
    expect(final.stop_reason).toBe("end_turn");
  });

  it("streams tool_use events", async () => {
    const events = [
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "toolu_123",
          name: "get_workflow_details",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"workflowId":"wf-1"}',
        },
      },
      { type: "content_block_stop", index: 0 },
    ];

    const finalMsg = {
      id: "msg_2",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_123",
          name: "get_workflow_details",
          input: { workflowId: "wf-1" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 50, output_tokens: 100 },
    };

    mockStream.mockReturnValue(createMockStream(events, finalMsg));

    const client = createAnthropicClient({
      apiKey: "test-key",
      systemPrompt: TEST_PROMPT,
    });
    const stream = client.createStream(
      [{ role: "user", content: "show workflow" }],
      resolveToolSet(AVAILABLE_TOOL_NAMES),
    );

    for await (const _ of stream) {
      /* drain */
    }

    const final = await stream.finalMessage();
    expect(final.stop_reason).toBe("tool_use");

    const toolUseBlocks = final.content.filter(
      (b: { type: string }) => b.type === "tool_use",
    );
    expect(toolUseBlocks).toHaveLength(1);
    expect(toolUseBlocks[0].name).toBe("get_workflow_details");
  });
});

describe("buildSystemPrompt", () => {
  it("returns base prompt when no context", () => {
    expect(buildSystemPrompt("You are helpful.")).toBe("You are helpful.");
  });

  it("returns base prompt when context is empty object", () => {
    expect(buildSystemPrompt("You are helpful.", {})).toBe("You are helpful.");
  });

  it("appends context section when context is provided", () => {
    const result = buildSystemPrompt("You are helpful.", {
      brandUrl: "https://example.com",
    });
    expect(result).toContain("You are helpful.");
    expect(result).toContain("## Additional Context (this request only)");
    expect(result).toContain("https://example.com");
  });

  it("includes context JSON with all provided fields", () => {
    const result = buildSystemPrompt("Base prompt.", {
      workflowId: "wf-123",
      brandUrl: "https://example.com",
    });
    expect(result).toContain('"workflowId": "wf-123"');
    expect(result).toContain('"brandUrl": "https://example.com"');
  });

  it("appends campaign context section when provided", () => {
    const result = buildSystemPrompt("Base.", undefined, {
      angle: "sustainability",
      geography: "US",
    });
    expect(result).toContain("## Campaign Context");
    expect(result).toContain("sustainability");
    expect(result).toContain("US");
  });

  it("skips campaign context when null", () => {
    const result = buildSystemPrompt("Base.", undefined, null);
    expect(result).toBe("Base.");
  });

  it("skips campaign context when empty object", () => {
    const result = buildSystemPrompt("Base.", undefined, {});
    expect(result).toBe("Base.");
  });

  it("includes both campaign context and additional context", () => {
    const result = buildSystemPrompt(
      "Base.",
      { workflowId: "wf-1" },
      { angle: "growth" },
    );
    expect(result).toContain("## Campaign Context");
    expect(result).toContain("growth");
    expect(result).toContain("## Additional Context");
    expect(result).toContain("wf-1");
    // Campaign context should come before additional context
    const campaignIdx = result.indexOf("## Campaign Context");
    const additionalIdx = result.indexOf("## Additional Context");
    expect(campaignIdx).toBeLessThan(additionalIdx);
  });
});

describe("REQUEST_USER_INPUT_TOOL", () => {
  it("has correct name and required parameters", () => {
    expect(REQUEST_USER_INPUT_TOOL.name).toBe("request_user_input");
    expect(REQUEST_USER_INPUT_TOOL.input_schema).toBeDefined();

    const schema = REQUEST_USER_INPUT_TOOL.input_schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.properties).toHaveProperty("input_type");
    expect(schema.properties).toHaveProperty("label");
    expect(schema.properties).toHaveProperty("field");
    expect(schema.properties).toHaveProperty("placeholder");
    expect(schema.properties).toHaveProperty("value");
    expect(schema.required).toEqual(["input_type", "label", "field"]);
  });

  it("description warns against using for confirmations", () => {
    expect(REQUEST_USER_INPUT_TOOL.description).toContain(
      "NEVER use this for confirmations",
    );
    expect(REQUEST_USER_INPUT_TOOL.description).toContain(
      "genuinely need information",
    );
  });
});

describe("UPDATE_WORKFLOW_TOOL", () => {
  it("has correct name and required workflowId parameter", () => {
    expect(UPDATE_WORKFLOW_TOOL.name).toBe("update_workflow");
    const schema = UPDATE_WORKFLOW_TOOL.input_schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.properties).toHaveProperty("workflowId");
    expect(schema.properties).toHaveProperty("name");
    expect(schema.properties).toHaveProperty("description");
    expect(schema.properties).toHaveProperty("tags");
    expect(schema.required).toEqual(["workflowId"]);
  });

  it("description instructs to use context workflowId directly", () => {
    expect(UPDATE_WORKFLOW_TOOL.description).toContain(
      "do not use input_request",
    );
  });
});

describe("VALIDATE_WORKFLOW_TOOL", () => {
  it("has correct name and required workflowId parameter", () => {
    expect(VALIDATE_WORKFLOW_TOOL.name).toBe("validate_workflow");
    const schema = VALIDATE_WORKFLOW_TOOL.input_schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.properties).toHaveProperty("workflowId");
    expect(schema.required).toEqual(["workflowId"]);
  });
});

describe("TOOL_REGISTRY", () => {
  it("contains all expected tools", () => {
    expect(AVAILABLE_TOOL_NAMES).toContain("request_user_input");
    expect(AVAILABLE_TOOL_NAMES).toContain("update_workflow");
    expect(AVAILABLE_TOOL_NAMES).toContain("validate_workflow");
    expect(AVAILABLE_TOOL_NAMES).toContain("get_prompt_template");
    expect(AVAILABLE_TOOL_NAMES).toContain("update_prompt_template");
    expect(AVAILABLE_TOOL_NAMES).toContain("update_workflow_node_config");
    expect(AVAILABLE_TOOL_NAMES).toContain("get_workflow_details");
    expect(AVAILABLE_TOOL_NAMES).toContain("generate_workflow");
    expect(AVAILABLE_TOOL_NAMES).toContain("get_workflow_required_providers");
    expect(AVAILABLE_TOOL_NAMES).toContain("list_workflows");
    expect(AVAILABLE_TOOL_NAMES).toContain("list_services");
    expect(AVAILABLE_TOOL_NAMES).toContain("list_service_endpoints");
    expect(AVAILABLE_TOOL_NAMES).toContain("list_org_keys");
    expect(AVAILABLE_TOOL_NAMES).toContain("get_key_source");
    expect(AVAILABLE_TOOL_NAMES).toContain("list_key_sources");
    expect(AVAILABLE_TOOL_NAMES).toContain("check_provider_requirements");
    expect(AVAILABLE_TOOL_NAMES).toContain("create_feature");
    expect(AVAILABLE_TOOL_NAMES).toContain("update_feature");
  });

  it("does NOT contain call_api (removed for security)", () => {
    expect(AVAILABLE_TOOL_NAMES).not.toContain("call_api");
  });

  it("all tools use Anthropic input_schema format", () => {
    for (const tool of Object.values(TOOL_REGISTRY)) {
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe("object");
      expect(tool).toHaveProperty("name");
      expect(tool).toHaveProperty("description");
    }
  });
});

describe("API Registry progressive disclosure tools", () => {
  it("LIST_SERVICES_TOOL has no required params", () => {
    expect(LIST_SERVICES_TOOL.name).toBe("list_services");
    expect(LIST_SERVICES_TOOL.description).toContain("START HERE");
  });

  it("LIST_SERVICE_ENDPOINTS_TOOL requires service", () => {
    expect(LIST_SERVICE_ENDPOINTS_TOOL.name).toBe("list_service_endpoints");
    const schema = LIST_SERVICE_ENDPOINTS_TOOL.input_schema as {
      required: string[];
    };
    expect(schema.required).toEqual(["service"]);
  });

  it("call_api is NOT in the tool registry (removed for security)", () => {
    expect(TOOL_REGISTRY["call_api"]).toBeUndefined();
  });
});

describe("Key-service read tools", () => {
  it("LIST_ORG_KEYS_TOOL has no required params", () => {
    expect(LIST_ORG_KEYS_TOOL.name).toBe("list_org_keys");
    expect(LIST_ORG_KEYS_TOOL.description).toContain("masked keys");
    expect(LIST_ORG_KEYS_TOOL.description).toContain("never the actual secret");
  });

  it("GET_KEY_SOURCE_TOOL requires provider", () => {
    expect(GET_KEY_SOURCE_TOOL.name).toBe("get_key_source");
    const schema = GET_KEY_SOURCE_TOOL.input_schema as {
      required: string[];
    };
    expect(schema.required).toEqual(["provider"]);
  });

  it("LIST_KEY_SOURCES_TOOL has no required params", () => {
    expect(LIST_KEY_SOURCES_TOOL.name).toBe("list_key_sources");
  });

  it("CHECK_PROVIDER_REQUIREMENTS_TOOL requires endpoints array", () => {
    expect(CHECK_PROVIDER_REQUIREMENTS_TOOL.name).toBe("check_provider_requirements");
    const schema = CHECK_PROVIDER_REQUIREMENTS_TOOL.input_schema as {
      required: string[];
      properties: Record<string, { type: string }>;
    };
    expect(schema.required).toEqual(["endpoints"]);
    expect(schema.properties.endpoints.type).toBe("array");
  });
});

describe("Feature-creator tools", () => {
  it("CREATE_FEATURE_TOOL has icon required and full input/output schemas", () => {
    expect(CREATE_FEATURE_TOOL.name).toBe("create_feature");
    const schema = CREATE_FEATURE_TOOL.input_schema as {
      properties: Record<string, { items?: { required?: string[]; properties?: Record<string, unknown> } }>;
      required: string[];
    };
    expect(schema.properties).toHaveProperty("slug");
    expect(schema.properties).toHaveProperty("icon");
    // slug optional, icon required
    expect(schema.required).not.toContain("slug");
    expect(schema.required).toContain("icon");
    expect(schema.required).toContain("name");
    expect(schema.required).toContain("inputs");
    expect(schema.required).toContain("outputs");
    expect(schema.required).toContain("charts");
    expect(schema.required).toContain("entities");

    // Charts: array with oneOf (funnel-bar, breakdown-bar)
    const chartsSchema = schema.properties.charts as { type: string; items: { oneOf: { properties: Record<string, unknown>; required: string[] }[] } };
    expect(chartsSchema.type).toBe("array");
    const chartVariants = chartsSchema.items.oneOf;
    expect(chartVariants).toHaveLength(2);
    // funnel-bar variant
    const funnelVariant = chartVariants.find((v) => (v.properties.type as { enum: string[] }).enum[0] === "funnel-bar")!;
    expect(funnelVariant.required).toContain("steps");
    // breakdown-bar variant
    const breakdownVariant = chartVariants.find((v) => (v.properties.type as { enum: string[] }).enum[0] === "breakdown-bar")!;
    expect(breakdownVariant.required).toContain("segments");

    // Entities: array of strings
    const entitiesSchema = schema.properties.entities as { type: string; items: { type: string } };
    expect(entitiesSchema.type).toBe("array");
    expect(entitiesSchema.items.type).toBe("string");

    // Input items: 6 required fields
    const inputItems = schema.properties.inputs.items!;
    expect(inputItems.required).toEqual(["key", "label", "type", "placeholder", "description", "extractKey"]);
    expect(inputItems.properties).toHaveProperty("options");

    // Output items: 2 required fields (key + displayOrder), optional defaultSort + sortDirection
    const outputItems = schema.properties.outputs.items!;
    expect(outputItems.required).toEqual(["key", "displayOrder"]);
    expect(outputItems.properties).toHaveProperty("defaultSort");
    expect(outputItems.properties).toHaveProperty("sortDirection");
  });

  it("UPDATE_FEATURE_TOOL requires only slug, has icon field", () => {
    expect(UPDATE_FEATURE_TOOL.name).toBe("update_feature");
    const schema = UPDATE_FEATURE_TOOL.input_schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required).toEqual(["slug"]);
    expect(schema.properties).toHaveProperty("name");
    expect(schema.properties).toHaveProperty("icon");
    expect(schema.properties).toHaveProperty("inputs");
    expect(schema.properties).toHaveProperty("charts");
    expect(schema.properties).toHaveProperty("entities");
    // charts and entities are optional for updates
    expect(schema.required).not.toContain("charts");
    expect(schema.required).not.toContain("entities");
  });

  it("LIST_FEATURES_TOOL has no required parameters", () => {
    expect(LIST_FEATURES_TOOL.name).toBe("list_features");
    const schema = LIST_FEATURES_TOOL.input_schema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.required).toBeUndefined();
    expect(schema.properties).toHaveProperty("category");
    expect(schema.properties).toHaveProperty("channel");
  });

  it("GET_FEATURE_TOOL requires slug", () => {
    expect(GET_FEATURE_TOOL.name).toBe("get_feature");
    const schema = GET_FEATURE_TOOL.input_schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required).toEqual(["slug"]);
  });
});

describe("resolveToolSet", () => {
  it("resolves a subset of tools from the registry", () => {
    const tools = resolveToolSet(["request_user_input", "create_feature", "update_feature"]);
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(["request_user_input", "create_feature", "update_feature"]);
  });

  it("skips unknown tool names gracefully", () => {
    const tools = resolveToolSet(["request_user_input", "nonexistent_tool"]);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("request_user_input");
  });
});

describe("prompt caching", () => {
  it("sets cache_control on system prompt", () => {
    const client = createAnthropicClient({
      apiKey: "test-key",
      systemPrompt: "Cached system prompt.",
    });
    client.createStream([{ role: "user", content: "hello" }]);

    const callArgs = mockStream.mock.calls.at(-1)?.[0];
    expect(callArgs.system[0].cache_control).toEqual({ type: "ephemeral" });
  });
});
