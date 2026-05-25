import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

import {
  mergeConsecutiveMessages,
  rebuildAnthropicHistory,
  type RebuildableMessage,
} from "../../src/lib/merge-messages.js";

describe("mergeConsecutiveMessages", () => {
  it("passes through alternating messages unchanged", () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "how are you" },
    ];
    const result = mergeConsecutiveMessages(msgs);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: "user", content: "hello" });
    expect(result[1]).toEqual({ role: "assistant", content: "hi" });
    expect(result[2]).toEqual({ role: "user", content: "how are you" });
  });

  it("merges consecutive user messages (orphaned from failed requests)", () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: "user", content: "first attempt" },
      { role: "user", content: "second attempt" },
      { role: "assistant", content: "response" },
    ];
    const result = mergeConsecutiveMessages(msgs);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toEqual([
      { type: "text", text: "first attempt" },
      { type: "text", text: "second attempt" },
    ]);
    expect(result[1]).toEqual({ role: "assistant", content: "response" });
  });

  it("merges three consecutive user messages", () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
      { role: "user", content: "c" },
    ];
    const result = mergeConsecutiveMessages(msgs);
    expect(result).toHaveLength(1);
    expect(result[0].content).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
      { type: "text", text: "c" },
    ]);
  });

  it("handles array content blocks (contentBlocks from assistant)", () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "first part" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "second part" },
        ],
      },
    ];
    const result = mergeConsecutiveMessages(msgs);
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe("assistant");
    expect(result[1].content).toEqual([
      { type: "text", text: "first part" },
      { type: "text", text: "second part" },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(mergeConsecutiveMessages([])).toEqual([]);
  });

  it("does not mutate input array", () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ];
    const original = JSON.parse(JSON.stringify(msgs));
    mergeConsecutiveMessages(msgs);
    expect(msgs).toEqual(original);
  });
});

describe("rebuildAnthropicHistory", () => {
  it("returns empty for empty input", () => {
    expect(rebuildAnthropicHistory([])).toEqual([]);
  });

  it("passes through plain user/assistant text turns", () => {
    const msgs: RebuildableMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi", toolCalls: null },
      { role: "user", content: "how are you" },
    ];
    const result = rebuildAnthropicHistory(msgs);
    expect(result).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: "how are you" },
    ]);
  });

  it("rebuilds tool_use + tool_result pairs from toolCalls", () => {
    const msgs: RebuildableMessage[] = [
      { role: "user", content: "fetch workflow abc" },
      {
        role: "assistant",
        content: "Looking it up.",
        toolCalls: [
          {
            name: "get_workflow_details",
            args: { workflowId: "abc" },
            result: { id: "abc", name: "Test workflow" },
          },
        ],
      },
    ];
    const result = rebuildAnthropicHistory(msgs);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: "user", content: "fetch workflow abc" });

    expect(result[1].role).toBe("assistant");
    const assistantBlocks = result[1].content as Anthropic.ContentBlockParam[];
    expect(assistantBlocks).toHaveLength(2);
    expect(assistantBlocks[0]).toEqual({ type: "text", text: "Looking it up." });
    expect(assistantBlocks[1]).toMatchObject({
      type: "tool_use",
      name: "get_workflow_details",
      input: { workflowId: "abc" },
    });
    const toolUseId = (assistantBlocks[1] as Anthropic.ToolUseBlockParam).id;
    expect(toolUseId).toMatch(/^toolu_/);

    expect(result[2].role).toBe("user");
    const userBlocks = result[2].content as Anthropic.ToolResultBlockParam[];
    expect(userBlocks).toHaveLength(1);
    expect(userBlocks[0]).toEqual({
      type: "tool_result",
      tool_use_id: toolUseId,
      content: JSON.stringify({ id: "abc", name: "Test workflow" }),
    });
  });

  it("pairs multiple toolCalls in a single assistant message", () => {
    const msgs: RebuildableMessage[] = [
      { role: "user", content: "do two things" },
      {
        role: "assistant",
        content: "On it.",
        toolCalls: [
          { name: "tool_a", args: { x: 1 }, result: { ok: true } },
          { name: "tool_b", args: { y: 2 }, result: { ok: false } },
        ],
      },
    ];
    const result = rebuildAnthropicHistory(msgs);
    expect(result).toHaveLength(3);

    const assistantBlocks = result[1].content as Anthropic.ContentBlockParam[];
    expect(assistantBlocks).toHaveLength(3);
    const id0 = (assistantBlocks[1] as Anthropic.ToolUseBlockParam).id;
    const id1 = (assistantBlocks[2] as Anthropic.ToolUseBlockParam).id;
    expect(id0).not.toBe(id1);

    const userBlocks = result[2].content as Anthropic.ToolResultBlockParam[];
    expect(userBlocks).toHaveLength(2);
    expect(userBlocks[0].tool_use_id).toBe(id0);
    expect(userBlocks[1].tool_use_id).toBe(id1);
  });

  it("emits tool_use-only assistant message when text content is empty", () => {
    const msgs: RebuildableMessage[] = [
      { role: "user", content: "just call the tool" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ name: "tool_x", args: {}, result: { ok: true } }],
      },
    ];
    const result = rebuildAnthropicHistory(msgs);
    expect(result).toHaveLength(3);
    const assistantBlocks = result[1].content as Anthropic.ContentBlockParam[];
    expect(assistantBlocks).toHaveLength(1);
    expect(assistantBlocks[0].type).toBe("tool_use");
  });

  it("skips assistant messages with no text and no toolCalls", () => {
    const msgs: RebuildableMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: null },
      { role: "user", content: "still there?" },
    ];
    const result = rebuildAnthropicHistory(msgs);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: "hi" });
    expect(result[1]).toEqual({ role: "user", content: "still there?" });
  });

  it("filters toolCalls entries without a result (orphan tool calls)", () => {
    const msgs: RebuildableMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "Working.",
        toolCalls: [
          { name: "tool_ok", args: {}, result: { ok: true } },
          { name: "tool_orphan", args: {} },
        ],
      },
    ];
    const result = rebuildAnthropicHistory(msgs);
    const assistantBlocks = result[1].content as Anthropic.ContentBlockParam[];
    expect(assistantBlocks).toHaveLength(2);
    expect((assistantBlocks[1] as Anthropic.ToolUseBlockParam).name).toBe("tool_ok");

    const userBlocks = result[2].content as Anthropic.ToolResultBlockParam[];
    expect(userBlocks).toHaveLength(1);
  });

  it("skips role='tool' messages", () => {
    const msgs: RebuildableMessage[] = [
      { role: "user", content: "hi" },
      { role: "tool", content: "some tool dump" },
      { role: "assistant", content: "hello", toolCalls: null },
    ];
    const result = rebuildAnthropicHistory(msgs);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
  });

  it("preserves order across multiple agentic turns", () => {
    const msgs: RebuildableMessage[] = [
      { role: "user", content: "turn 1" },
      {
        role: "assistant",
        content: "result 1",
        toolCalls: [{ name: "t1", args: {}, result: "r1" }],
      },
      { role: "user", content: "turn 2" },
      {
        role: "assistant",
        content: "result 2",
        toolCalls: [{ name: "t2", args: {}, result: "r2" }],
      },
    ];
    const result = rebuildAnthropicHistory(msgs);
    expect(result).toHaveLength(6);
    expect(result[0]).toEqual({ role: "user", content: "turn 1" });
    expect(result[1].role).toBe("assistant");
    expect(result[2].role).toBe("user"); // synthetic tool_result
    expect(result[3]).toEqual({ role: "user", content: "turn 2" });
    expect(result[4].role).toBe("assistant");
    expect(result[5].role).toBe("user"); // synthetic tool_result

    const ids0 = (result[1].content as Anthropic.ContentBlockParam[])
      .filter((b) => b.type === "tool_use")
      .map((b) => (b as Anthropic.ToolUseBlockParam).id);
    const ids1 = (result[4].content as Anthropic.ContentBlockParam[])
      .filter((b) => b.type === "tool_use")
      .map((b) => (b as Anthropic.ToolUseBlockParam).id);
    expect(ids0[0]).not.toBe(ids1[0]);
  });
});
