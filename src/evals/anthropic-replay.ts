// ---------------------------------------------------------------------------
// A Claude model in the eval replay, on the SAME request /chat sends
// (SOPHIE-MODEL-BAKEOFF-1113, owner 2026-11-13 « tu es sûr que tu as comparé
// toutes choses étant égales ? »).
//
// The first version (SOPHIE-CORE-1111) was a mini-loop written for the eval: no
// thinking block at all, the history as plain text, photos refused. So the
// 2026-11-11 bake-off compared DeepSeek on the real /chat vendor loop with
// Claude on a different, thinking-less request. Now:
//  - every request is built by `createAnthropicClient().createStream`, the
//    function the /chat Anthropic loop calls (Sophie's Haiku backup runs it,
//    SOPHIE-HAIKU-BACKUP-1112): adaptive thinking + block binding, context
//    management, prompt cache, max_tokens, and `output_config.effort` only when
//    an effort is stated (the copilot config states none: the model's default);
//  - the history is rebuilt with its tool_use / tool_result pairs
//    (`rebuildAnthropicHistory` + `mergeConsecutiveMessages`), as /chat does;
//  - the person's photos go in as image blocks (`buildAnthropicTurnMessages`);
//  - the loop control mirrors index.ts's Anthropic path: 10 tool rounds, the
//    final-round note beside the last tool results and tools off for that
//    round, one re-ask when a turn that ran tools ends silent, a lead turn
//    re-asked once to call its end tool (tools never off for it), tool errors
//    through `formatToolError` with `is_error`, working notes beside a tool
//    call held. That control flow is the one part copied, not shared: it lives
//    inline in the /chat handler.
// Billed lines come from `readAnthropicBilledTokens` / `anthropicCostLines`,
// per request, merged (Haiku 5.5's long-context tier is per request).
// ---------------------------------------------------------------------------

import type Anthropic from "@anthropic-ai/sdk";
import { createAnthropicClient } from "../lib/anthropic.js";
import type { AnthropicEffort } from "../schemas.js";
import { buildAnthropicTurnMessages, lastUserMessage } from "../lib/anthropic-turn.js";
import { anthropicCachePriced, anthropicCostLines, mergeCostLines, readAnthropicBilledTokens, type AnthropicCostLine } from "../lib/anthropic-usage.js";
import type { ToolDefinition, ToolExecutor } from "../lib/gemini-chat.js";
import { mergeConsecutiveMessages, rebuildAnthropicHistory, type RebuildableMessage } from "../lib/merge-messages.js";
import { EMPTY_ANSWER_NOTE, FINAL_ROUND_NOTE, MAX_TOOL_CHAIN_DEPTH, endToolFinalNote, endToolNudgeNote, isFinalToolRound, needsAnswerNudge } from "../lib/tool-budget.js";
import { formatToolError } from "../lib/tool-errors.js";
import { stripLongDashes } from "../lib/long-dash.js";
import type { TurnImage } from "../lib/turn-images.js";

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
  history: RebuildableMessage[];
  userMessage: string;
  images?: readonly TurnImage[];
  tools: ToolDefinition[];
  executeTool: ToolExecutor;
  holdTextBesideToolCalls: boolean;
  endToolName?: string;
  /** `output_config.effort`; omitted = none sent (the copilot config's NULL effort). */
  effort?: AnthropicEffort;
  beforeProviderCall: () => Promise<void>;
}): Promise<AnthropicReplayResult> {
  const claude = createAnthropicClient({ apiKey: args.apiKey, systemPrompt: args.systemPrompt });
  const cache = anthropicCachePriced(args.costPrefix);
  const history = mergeConsecutiveMessages(rebuildAnthropicHistory(args.history));
  const messages = buildAnthropicTurnMessages(history, args.userMessage.trim(), args.turnContext, cache, args.images ?? []);
  const tools = args.tools as unknown as Anthropic.Tool[];
  const leadTurn = Boolean(args.endToolName);

  const toolCalls: AnthropicReplayResult["toolCalls"] = [];
  let costLines: AnthropicCostLine[] = [];
  let tokensInput = 0;
  let tokensOutput = 0;
  let shown = "";
  let answerNudged = false;
  let ended = false;
  let depth = 0;

  while (depth <= MAX_TOOL_CHAIN_DEPTH && !ended) {
    await args.beforeProviderCall();
    const stream = claude.createStream(messages, tools, undefined, {
      model: args.model,
      cache,
      ...(args.effort ? { effort: args.effort } : {}),
      ...((isFinalToolRound(depth) || answerNudged) && !leadTurn ? { toolChoice: "none" as const } : {}),
    });
    const res = await stream.finalMessage();
    const billed = readAnthropicBilledTokens(res.usage);
    costLines = mergeCostLines(costLines, anthropicCostLines(args.costPrefix, billed));
    tokensInput += billed.tokensInput + billed.cacheReadTokens + billed.cacheWriteTokens;
    tokensOutput += billed.tokensOutput;

    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    if (res.stop_reason !== "tool_use") {
      if (leadTurn && !toolCalls.some((c) => c.name === args.endToolName) && !answerNudged) {
        answerNudged = true;
        const note = { type: "text" as const, text: endToolNudgeNote(args.endToolName!) };
        if (res.content.length > 0) {
          messages.push({ role: "assistant", content: res.content });
          messages.push({ role: "user", content: [note] });
        } else {
          const lastUser = lastUserMessage(messages);
          if (lastUser) lastUser.content = Array.isArray(lastUser.content) ? [...lastUser.content, note] : [{ type: "text", text: lastUser.content }, note];
        }
        continue;
      }
      const last = messages[messages.length - 1];
      if (last?.role === "user" && Array.isArray(last.content) && needsAnswerNudge({ toolsRan: depth > 0, answerText: text, alreadyNudged: answerNudged })) {
        answerNudged = true;
        last.content = [...last.content, { type: "text", text: EMPTY_ANSWER_NOTE }];
        continue;
      }
      // /chat strips long dashes from the held answer (owner rule: none in client text).
      shown += args.holdTextBesideToolCalls ? stripLongDashes(text) : text;
      break;
    }
    if (!args.holdTextBesideToolCalls) shown += text;

    messages.push({ role: "assistant", content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")) {
      const input = (use.input ?? {}) as Record<string, unknown>;
      try {
        const out = await args.executeTool({ name: use.name, args: input });
        if (out === "input_request") {
          // A turn-ending UI tool (present_choices, request_user_input): /chat stops the turn here.
          toolCalls.push({ name: use.name, args: input, result: null });
          ended = true;
          break;
        }
        if (out === null) {
          toolCalls.push({ name: use.name, args: input, result: { error: "Unknown tool" } });
          results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify({ error: "Unknown tool" }), is_error: true });
          continue;
        }
        toolCalls.push({ name: use.name, args: input, result: out.result });
        results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(out.result) });
        if (args.endToolName && use.name === args.endToolName) ended = true;
      } catch (err) {
        const friendly = formatToolError(use.name, err instanceof Error ? err.message : String(err));
        toolCalls.push({ name: use.name, args: input, result: friendly });
        results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(friendly), is_error: true });
      }
    }
    if (ended) break;
    depth++;
    messages.push({
      role: "user",
      content: isFinalToolRound(depth)
        ? [...results, { type: "text", text: leadTurn ? endToolFinalNote(args.endToolName!) : FINAL_ROUND_NOTE }]
        : results,
    });
  }
  return { fullResponse: shown, toolCalls, tokensInput, tokensOutput, costLines };
}
