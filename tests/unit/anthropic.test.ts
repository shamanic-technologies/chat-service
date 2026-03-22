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
  REQUEST_USER_INPUT_TOOL,
  UPDATE_WORKFLOW_TOOL,
  VALIDATE_WORKFLOW_TOOL,
  BUILTIN_TOOLS,
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
      BUILTIN_TOOLS,
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

  it("includes context usage rules that reference the context keys", () => {
    const result = buildSystemPrompt("Base prompt.", {
      workflowId: "wf-123",
      brandUrl: "https://example.com",
    });
    expect(result).toContain("## IMPORTANT: Context Usage Rules");
    expect(result).toContain("workflowId, brandUrl");
    expect(result).toContain("Do NOT call request_user_input");
  });

  it("instructs LLM to use workflowId directly from context", () => {
    const result = buildSystemPrompt("Base prompt.", {
      workflowId: "wf-abc-123",
    });
    expect(result).toContain("wf-abc-123");
    expect(result).toContain("workflowId");
    expect(result).toContain("use them directly when calling tools");
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

describe("BUILTIN_TOOLS", () => {
  it("includes all built-in tools", () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    expect(names).toContain("request_user_input");
    expect(names).toContain("update_workflow");
    expect(names).toContain("validate_workflow");
    expect(names).toContain("get_prompt_template");
    expect(names).toContain("update_prompt_template");
    expect(names).toContain("update_workflow_node_config");
    expect(names).toContain("list_available_services");
    expect(names).toContain("get_workflow_details");
    expect(names).toContain("get_workflow_required_providers");
    expect(names).toContain("list_workflows");
    expect(names).not.toContain("generate_workflow");
    expect(BUILTIN_TOOLS).toHaveLength(10);
  });

  it("all tools use Anthropic input_schema format", () => {
    for (const tool of BUILTIN_TOOLS) {
      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe("object");
      expect(tool).toHaveProperty("name");
      expect(tool).toHaveProperty("description");
    }
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
