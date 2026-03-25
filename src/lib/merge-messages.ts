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
 * Tool calls are ephemeral within a single request's agentic loop — their
 * matching tool_result messages are never persisted. Including orphaned
 * tool_use blocks in history causes Anthropic to reject the request with
 * "tool_use ids were found without tool_result blocks immediately after".
 */
export function stripToolUseBlocks(
  blocks: Anthropic.ContentBlockParam[],
): Anthropic.ContentBlockParam[] {
  return blocks.filter((b) => b.type !== "tool_use");
}
