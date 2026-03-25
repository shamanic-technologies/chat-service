import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

import { stripToolUseBlocks } from "../../src/lib/merge-messages.js";

describe("stripToolUseBlocks", () => {
  it("removes tool_use blocks from content", () => {
    const blocks: Anthropic.ContentBlockParam[] = [
      { type: "text", text: "Let me check that." },
      {
        type: "tool_use",
        id: "toolu_01ECkCYdeGo3aYJUiVXNzGru",
        name: "get_workflow_details",
        input: { workflowId: "abc-123" },
      },
      {
        type: "tool_use",
        id: "toolu_01GBCV9Ja2yqZb2m2WXHcHeQ",
        name: "request_user_input",
        input: { input_type: "text", label: "URL?", field: "url" },
      },
    ];

    const result = stripToolUseBlocks(blocks);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "text", text: "Let me check that." });
  });

  it("returns all blocks when none are tool_use", () => {
    const blocks: Anthropic.ContentBlockParam[] = [
      { type: "text", text: "Hello" },
      { type: "text", text: "World" },
    ];

    const result = stripToolUseBlocks(blocks);
    expect(result).toEqual(blocks);
  });

  it("returns empty array when all blocks are tool_use", () => {
    const blocks: Anthropic.ContentBlockParam[] = [
      {
        type: "tool_use",
        id: "toolu_abc",
        name: "some_tool",
        input: {},
      },
    ];

    const result = stripToolUseBlocks(blocks);
    expect(result).toHaveLength(0);
  });

  it("preserves thinking blocks alongside text", () => {
    const blocks: Anthropic.ContentBlockParam[] = [
      { type: "thinking", thinking: "reasoning here" } as Anthropic.ContentBlockParam,
      { type: "text", text: "My response" },
      {
        type: "tool_use",
        id: "toolu_xyz",
        name: "request_user_input",
        input: { input_type: "url", label: "Enter URL", field: "url" },
      },
    ];

    const result = stripToolUseBlocks(blocks);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("thinking");
    expect(result[1].type).toBe("text");
  });
});
