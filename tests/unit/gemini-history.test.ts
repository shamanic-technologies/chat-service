import { describe, it, expect } from "vitest";

import {
  toGeminiHistory,
  type GeminiHistoryInput,
} from "../../src/lib/gemini-chat.js";

describe("toGeminiHistory", () => {
  it("returns empty for empty input", () => {
    expect(toGeminiHistory([])).toEqual([]);
  });

  it("passes through plain user/assistant text turns", () => {
    const msgs: GeminiHistoryInput = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "thanks" },
    ];
    const result = toGeminiHistory(msgs);
    expect(result).toEqual([
      { role: "user", parts: [{ text: "hello" }] },
      { role: "model", parts: [{ text: "hi" }] },
      { role: "user", parts: [{ text: "thanks" }] },
    ]);
  });

  it("merges consecutive same-role messages", () => {
    const msgs: GeminiHistoryInput = [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
      { role: "assistant", content: "ok" },
    ];
    const result = toGeminiHistory(msgs);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      role: "user",
      parts: [{ text: "a" }, { text: "b" }],
    });
    expect(result[1]).toEqual({ role: "model", parts: [{ text: "ok" }] });
  });

  it("rebuilds functionCall + functionResponse pairs from toolCalls", () => {
    const msgs: GeminiHistoryInput = [
      { role: "user", content: "fetch X" },
      {
        role: "assistant",
        content: "Looking it up.",
        toolCalls: [
          { name: "get_x", args: { id: "abc" }, result: { value: 42 } },
        ],
      },
    ];
    const result = toGeminiHistory(msgs);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: "user", parts: [{ text: "fetch X" }] });

    expect(result[1].role).toBe("model");
    expect(result[1].parts).toHaveLength(2);
    expect(result[1].parts[0]).toEqual({ text: "Looking it up." });
    expect(result[1].parts[1]).toEqual({
      functionCall: { name: "get_x", args: { id: "abc" } },
      thoughtSignature: "skip_thought_signature_validator",
    });

    expect(result[2].role).toBe("user");
    expect(result[2].parts).toEqual([
      { functionResponse: { name: "get_x", response: { value: 42 } } },
    ]);
  });

  it("emits functionCall-only model message when text is empty", () => {
    const msgs: GeminiHistoryInput = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ name: "tool_x", args: {}, result: { ok: true } }],
      },
    ];
    const result = toGeminiHistory(msgs);
    expect(result).toHaveLength(3);
    expect(result[1].role).toBe("model");
    expect(result[1].parts).toHaveLength(1);
    expect(result[1].parts[0]).toEqual({
      functionCall: { name: "tool_x", args: {} },
      thoughtSignature: "skip_thought_signature_validator",
    });
  });

  it("echoes a stored thoughtSignature on the functionCall part", () => {
    const msgs: GeminiHistoryInput = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { name: "tool_z", args: {}, result: { ok: true }, thoughtSignature: "real-sig-abc" },
        ],
      },
    ];
    const result = toGeminiHistory(msgs);
    expect(result[1].parts[0]).toEqual({
      functionCall: { name: "tool_z", args: {} },
      thoughtSignature: "real-sig-abc",
    });
  });

  it("injects the dummy bypass signature when none was stored (Gemini-3 400 guard)", () => {
    // Regression: replaying a stored tool call without a thoughtSignature 400'd
    // on Gemini 3 (`Function call ... is missing a thought_signature`).
    const msgs: GeminiHistoryInput = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ name: "validate_workflow", args: {}, result: { ok: true } }],
      },
    ];
    const result = toGeminiHistory(msgs);
    expect(result[1].parts[0]).toMatchObject({
      thoughtSignature: "skip_thought_signature_validator",
    });
  });

  it("filters toolCalls entries without a result", () => {
    const msgs: GeminiHistoryInput = [
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
    const result = toGeminiHistory(msgs);
    const modelParts = result[1].parts;
    expect(modelParts).toHaveLength(2);
    expect(modelParts[1]).toEqual({
      functionCall: { name: "tool_ok", args: {} },
      thoughtSignature: "skip_thought_signature_validator",
    });

    const responseParts = result[2].parts;
    expect(responseParts).toHaveLength(1);
  });

  it("skips assistant messages with no text and no toolCalls", () => {
    const msgs: GeminiHistoryInput = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "" },
      { role: "user", content: "still there?" },
    ];
    const result = toGeminiHistory(msgs);
    expect(result).toEqual([
      { role: "user", parts: [{ text: "hi" }, { text: "still there?" }] },
    ]);
  });

  it("merges synthetic functionResponse user with a following plain user message", () => {
    const msgs: GeminiHistoryInput = [
      { role: "user", content: "first" },
      {
        role: "assistant",
        content: "calling",
        toolCalls: [{ name: "tool_y", args: {}, result: "r" }],
      },
      { role: "user", content: "follow up" },
    ];
    const result = toGeminiHistory(msgs);
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("model");
    expect(result[2].role).toBe("user");
    expect(result[2].parts).toHaveLength(2);
    expect(result[2].parts[0]).toEqual({
      functionResponse: { name: "tool_y", response: "r" },
    });
    expect(result[2].parts[1]).toEqual({ text: "follow up" });
  });

  it("preserves multiple turns with tool calls in order (merging consecutive user roles)", () => {
    const msgs: GeminiHistoryInput = [
      { role: "user", content: "turn 1" },
      {
        role: "assistant",
        content: "r1",
        toolCalls: [{ name: "t1", args: {}, result: "v1" }],
      },
      { role: "user", content: "turn 2" },
      {
        role: "assistant",
        content: "r2",
        toolCalls: [{ name: "t2", args: {}, result: "v2" }],
      },
    ];
    const result = toGeminiHistory(msgs);
    // synthetic functionResponse user from turn 1 merges with real "turn 2" user
    expect(result).toHaveLength(5);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("model");
    expect(result[2].role).toBe("user"); // merged: [fr:t1, text:turn2]
    expect(result[3].role).toBe("model");
    expect(result[4].role).toBe("user"); // synthetic functionResponse t2

    expect(result[2].parts).toHaveLength(2);
    expect(result[2].parts[0]).toEqual({
      functionResponse: { name: "t1", response: "v1" },
    });
    expect(result[2].parts[1]).toEqual({ text: "turn 2" });

    expect(result[1].parts.find((p) => "functionCall" in p)).toEqual({
      functionCall: { name: "t1", args: {} },
      thoughtSignature: "skip_thought_signature_validator",
    });
    expect(result[3].parts.find((p) => "functionCall" in p)).toEqual({
      functionCall: { name: "t2", args: {} },
      thoughtSignature: "skip_thought_signature_validator",
    });
  });
});
