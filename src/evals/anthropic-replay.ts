// ---------------------------------------------------------------------------
// A Claude model in the eval replay (SOPHIE-CORE-1111: pick Sophie's model by
// evals, Claude Haiku 5.5 and Sonnet 5.5 beside DeepSeek).
//
// The /chat Anthropic loop lives inside the /chat handler (index.ts) and cannot
// be called from here, so this is the same contract, small: the stable system
// prompt (cached), the history as text, the user's message (cached) then the
// turn's context as a mid-conversation system message (`buildAnthropicTurnMessages`,
// as /chat sends it), the same tool budget (10 rounds, then a final round told
// to answer), text beside a tool call held when the config holds it, a turn-
// ending UI tool or end tool closing the turn. No thinking block: the
// comparison is against DeepSeek with reasoning off. Billed lines come from
// `readAnthropicBilledTokens` / `anthropicCostLines`, per request, merged.
// ---------------------------------------------------------------------------

import Anthropic from "@anthropic-ai/sdk";
import { buildAnthropicTurnMessages } from "../lib/anthropic-turn.js";
import { anthropicCachePriced, anthropicCostLines, mergeCostLines, readAnthropicBilledTokens, type AnthropicCostLine } from "../lib/anthropic-usage.js";
import type { ToolDefinition, ToolExecutor } from "../lib/gemini-chat.js";
import { FINAL_ROUND_NOTE } from "../lib/tool-budget.js";

/** Tool rounds before the final round, as /chat. */
const MAX_TOOL_ROUNDS = 10;
const MAX_OUTPUT_TOKENS = 8_000;

export interface AnthropicReplayResult {
  fullResponse: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: unknown }>;
  tokensInput: number;
  tokensOutput: number;
  costLines: AnthropicCostLine[];
}

export async function replayAnthropicTurn(args: {
  apiKey: string;
  model: string;
  costPrefix: string;
  systemPrompt: string;
  turnContext: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  userMessage: string;
  tools: ToolDefinition[];
  executeTool: ToolExecutor;
  holdTextBesideToolCalls: boolean;
  endToolName?: string;
  beforeProviderCall: () => Promise<void>;
}): Promise<AnthropicReplayResult> {
  const client = new Anthropic({ apiKey: args.apiKey });
  const cache = anthropicCachePriced(args.costPrefix);
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: args.systemPrompt, ...(cache ? { cache_control: { type: "ephemeral" as const } } : {}) },
  ];
  const history: Anthropic.MessageParam[] = args.history
    .filter((m) => m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));
  const messages = buildAnthropicTurnMessages(history, args.userMessage, args.turnContext, cache);
  const tools: Anthropic.Tool[] = args.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Tool.InputSchema }));

  const toolCalls: AnthropicReplayResult["toolCalls"] = [];
  let costLines: AnthropicCostLine[] = [];
  let tokensInput = 0;
  let tokensOutput = 0;
  let shown = "";

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const final = round === MAX_TOOL_ROUNDS;
    if (final) messages.push({ role: "user", content: FINAL_ROUND_NOTE });
    await args.beforeProviderCall();
    const res = await client.messages.create({
      model: args.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      tools,
      messages,
      ...(final ? { tool_choice: { type: "none" as const } } : {}),
    });
    const billed = readAnthropicBilledTokens(res.usage);
    costLines = mergeCostLines(costLines, anthropicCostLines(args.costPrefix, billed));
    tokensInput += billed.tokensInput + billed.cacheReadTokens + billed.cacheWriteTokens;
    tokensOutput += billed.tokensOutput;

    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (uses.length === 0) {
      shown += text;
      break;
    }
    if (!args.holdTextBesideToolCalls) shown += text;
    messages.push({ role: "assistant", content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    let ended = false;
    for (const use of uses) {
      const input = (use.input ?? {}) as Record<string, unknown>;
      // A failing tool reaches the model as an error it can correct, as in /chat (formatToolError there).
      const out = await args.executeTool({ name: use.name, args: input }).catch((err: unknown) => ({ name: use.name, result: { error: err instanceof Error ? err.message : String(err) } }));
      if (out === "input_request") {
        toolCalls.push({ name: use.name, args: input, result: null });
        ended = true;
        results.push({ type: "tool_result", tool_use_id: use.id, content: "Shown to the person." });
        continue;
      }
      const result = out === null ? { error: `Unknown tool ${use.name}` } : out.result;
      toolCalls.push({ name: use.name, args: input, result });
      results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(result ?? null) });
      if (args.endToolName && use.name === args.endToolName) ended = true;
    }
    if (ended) break;
    messages.push({ role: "user", content: results });
  }
  return { fullResponse: shown, toolCalls, tokensInput, tokensOutput, costLines };
}
