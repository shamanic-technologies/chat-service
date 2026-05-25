import type Anthropic from "@anthropic-ai/sdk";

/**
 * Merge consecutive same-role messages into one (Anthropic requires alternating roles).
 * This can happen if a previous request errored after saving the user message
 * but before saving the assistant response, leaving orphan user messages.
 */
export function mergeConsecutiveMessages(
  msgs: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];
  for (const msg of msgs) {
    const prev = result[result.length - 1];
    if (prev && prev.role === msg.role) {
      const prevContent = Array.isArray(prev.content)
        ? prev.content
        : [{ type: "text" as const, text: prev.content }];
      const curContent = Array.isArray(msg.content)
        ? msg.content
        : [{ type: "text" as const, text: msg.content }];
      prev.content = [...prevContent, ...curContent];
    } else {
      result.push({ ...msg });
    }
  }
  return result;
}

/**
 * Strip tool_use blocks from content blocks.
 * Used at persist time to clean orphan tool_use blocks from the last
 * agentic-loop iteration when the loop exits via `request_user_input`
 * (the tool_result is never produced because the loop pauses for input).
 */
export function stripToolUseBlocks(
  blocks: Anthropic.ContentBlockParam[],
): Anthropic.ContentBlockParam[] {
  return blocks.filter((b) => b.type !== "tool_use");
}

/**
 * DB message shape consumed by rebuildAnthropicHistory.
 */
export interface RebuildableMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
  }> | null;
}

/**
 * Rebuild Anthropic message history from DB records, restoring tool_use +
 * tool_result pairs from the `toolCalls` jsonb column.
 *
 * Anthropic Messages API is stateless: every request must include the full
 * prior conversation, and multi-turn tool use requires the assistant's
 * `tool_use` blocks to be paired with matching `tool_result` blocks in a
 * synthetic user message immediately after. Without this pairing, Claude
 * has no memory of which tools were called or what they returned in prior
 * turns — it either re-fetches or hallucinates.
 *
 * Tool calls without a `result` (e.g. `request_user_input` which pauses the
 * agentic loop) are filtered out — they would create orphan `tool_use` ids
 * and trigger "tool_use ids were found without tool_result blocks" 400s.
 *
 * tool_use ids are synthesized deterministically per (message-index, tool-index).
 * The live agentic loop uses the real Anthropic-provided ids; only cross-turn
 * reconstruction uses synthetic ids, which is fine because each request is
 * self-contained.
 */
export function rebuildAnthropicHistory(
  messages: RebuildableMessage[],
): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "tool") continue;

    if (m.role === "user") {
      result.push({ role: "user", content: m.content });
      continue;
    }

    const text = m.content ?? "";
    const validToolCalls = (m.toolCalls ?? []).filter(
      (tc) => tc.result !== undefined,
    );

    const assistantBlocks: Anthropic.ContentBlockParam[] = [];
    if (text.length > 0) {
      assistantBlocks.push({ type: "text", text });
    }
    for (let j = 0; j < validToolCalls.length; j++) {
      const tc = validToolCalls[j];
      assistantBlocks.push({
        type: "tool_use",
        id: `toolu_${i}_${j}`,
        name: tc.name,
        input: tc.args,
      });
    }

    if (assistantBlocks.length === 0) continue;

    result.push({ role: "assistant", content: assistantBlocks });

    if (validToolCalls.length > 0) {
      const toolResultBlocks: Anthropic.ToolResultBlockParam[] =
        validToolCalls.map((tc, j) => ({
          type: "tool_result",
          tool_use_id: `toolu_${i}_${j}`,
          content: JSON.stringify(tc.result),
        }));
      result.push({ role: "user", content: toolResultBlocks });
    }
  }

  return result;
}
