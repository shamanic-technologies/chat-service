import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

import { mergeConsecutiveMessages } from "../../src/lib/merge-messages.js";

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
