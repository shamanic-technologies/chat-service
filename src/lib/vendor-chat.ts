// ---------------------------------------------------------------------------
// /chat tool loop on a direct OpenAI-compatible vendor (CHAT-DEEPSEEK-FLASH-1101,
// owner 2026-11-01: « Passe le chat sur DeepSeek flash aussi »).
//
// The third /chat loop beside Anthropic (index.ts) and Gemini (gemini-chat.ts),
// with the same contract: the same SSE events, the same tool budget and nudges
// (tool-budget.ts), the same per-request cost hold (`beforeProviderCall`) and
// the per-request billed lines, merged.
//
// One NON-streaming request per round: the turn's text arrives whole, so text
// written beside a tool call is dropped before anyone sees it, and the retry /
// refusal contract is the one `/complete` already runs on
// (`postVendorChatCompletion`). A vendor failure fails the turn loud: no
// fallback model (an out-of-credit refusal included).
//
// Layout of one turn, prefix-cache friendly like the Anthropic path
// (anthropic-turn.ts): the stable system prompt, the stored history, the
// user's message, then this turn's context as a mid-conversation system
// message, then the rounds of this turn.
// ---------------------------------------------------------------------------

import type { Response as ExpressResponse } from "express";
import type { ToolCallRecord } from "../db/schema.js";
import { vendorCostLines, type VendorCostLine } from "./cost-names.js";
import type { ToolDefinition, ToolExecutor, GeminiHistoryInput } from "./gemini-chat.js";
import { trimGeminiHistoryToBudget } from "./gemini-trim.js";
import { stripLongDashes } from "./long-dash.js";
import {
  assertModelMatches,
  inBandError,
  postVendorChatCompletion,
  VendorProviderError,
  VENDORS,
  vendorReasoningFields,
  type VendorId,
  type VendorResponseBody,
  type VendorToolCall,
} from "./openai-compatible.js";
import {
  EMPTY_ANSWER_NOTE,
  FINAL_ROUND_NOTE,
  endToolFinalNote,
  endToolNudgeNote,
  isFinalToolRound,
  MAX_TOOL_CHAIN_DEPTH,
  needsAnswerNudge,
} from "./tool-budget.js";
import { formatToolError } from "./tool-errors.js";
import { CLIENT_UI_TOOL_NAMES } from "./ui-tools.js";
import { imageDataUrl, imagesIntro, type TurnImage } from "./turn-images.js";

/** Output cap per round (DeepSeek V4.1 Flash takes up to 384k; a chat answer never needs more). */
export const VENDOR_CHAT_MAX_OUTPUT_TOKENS = 32_000;

/** One part of a user message that carries photos (OpenAI-compatible content parts). */
export type VendorUserPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/** An OpenAI-compatible chat message, as this loop sends it. */
export type VendorChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | VendorUserPart[] }
  | { role: "assistant"; content: string; tool_calls?: VendorToolCall[]; reasoning_content?: string }
  | { role: "tool"; tool_call_id: string; content: string };

type SendSSE = (res: ExpressResponse, data: unknown) => void;

export interface StreamVendorChatOptions {
  vendor: VendorId;
  apiKey: string;
  /** Vendor model id (`deepseek-flash`). */
  model: string;
  /** Catalog prefix of that model (`deepseek-v4.1-flash`): the billed lines are built from it. */
  costPrefix: string;
  /** The config's prompt + skills + identity: the same every turn. */
  systemPrompt: string;
  /** What this turn alone carries (page context, WhatsApp or Lead event block). */
  turnContext: string;
  history: GeminiHistoryInput;
  userMessage: string;
  /**
   * Photos the person sent with this message (SOPHIE-WA-HUMAN-1106): they join
   * the user message as images, read natively by the model. Only a vendor whose
   * `imageInput` was probed live takes them; any other fails the turn loud.
   */
  images?: readonly TurnImage[];
  tools: ToolDefinition[];
  res: ExpressResponse;
  sendSSE: SendSSE;
  executeTool: ToolExecutor;
  signal: AbortSignal;
  /**
   * Called before every provider request with the request and the ONE clock
   * its hold and its billed lines are priced at (DeepSeek peak / off-peak).
   */
  beforeProviderCall: (details: { depth: number; requestBody: Record<string, unknown>; at: Date }) => Promise<void>;
  /** Drop the text of a round that also calls a tool (a working note, never an answer). */
  holdTextBesideToolCalls?: boolean;
  /** A turn that must END by calling this tool (a Lead event turn's answer_person). */
  endToolName?: string;
  /**
   * Send the vendor's reasoning-off field (`vendorReasoningFields`: this
   * model's own spelling). Absent or false = the model's default.
   */
  reasoningDisabled?: boolean;
  /**
   * Called once per provider request with THAT request's billed lines, as soon
   * as its usage is read: a loop that later fails still has every round it
   * spent declared by its caller (BRAND-MCP-1109, no undeclared spend).
   */
  onRoundBilled?: (costLines: VendorCostLine[]) => void;
}

export interface StreamVendorChatResult {
  tokensInput: number;
  /** Input of the LAST request of the loop: the context the model read (the gauge). */
  lastRequestTokensInput: number;
  tokensOutput: number;
  /** Billed lines of every request of the loop, each priced at its own clock, merged by name. */
  costLines: VendorCostLine[];
  fullResponse: string;
  /** Every call fed back to the model this turn (tool results included). */
  toolCalls: ToolCallRecord[];
  emittedInputRequest: boolean;
}

/** Anthropic-shaped tool definitions → OpenAI-compatible `tools`. */
export function toVendorTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object",
        properties: t.input_schema.properties ?? {},
        ...(t.input_schema.required?.length ? { required: t.input_schema.required } : {}),
      },
    },
  }));
}

/**
 * Stored history → OpenAI-compatible messages. A stored assistant turn that ran
 * tools becomes the call, one `tool` message per result, then its text: the
 * order it happened in. A call stored without a result (a turn-ending UI tool)
 * is not replayed: a call with no result is refused by the API. Consecutive
 * same-role text is merged (a failed turn leaves two user messages in a row).
 */
export function toVendorHistory(history: GeminiHistoryInput): VendorChatMessage[] {
  const out: VendorChatMessage[] = [];
  const pushText = (role: "user" | "assistant", content: string) => {
    if (!content.trim()) return;
    const prev = out[out.length - 1];
    if (prev && prev.role === role && !(prev.role === "assistant" && prev.tool_calls)) {
      appendText(prev as { content: string | VendorUserPart[] }, content);
      return;
    }
    out.push({ role, content } as VendorChatMessage);
  };
  history.forEach((msg, i) => {
    if (msg.role === "user") return pushText("user", msg.content ?? "");
    const calls = (msg.toolCalls ?? []).filter((tc) => tc.result !== undefined);
    if (calls.length > 0) {
      const ids = calls.map((_, j) => `call_h${i}_${j}`);
      out.push({
        role: "assistant",
        content: "",
        tool_calls: calls.map((tc, j) => ({
          id: ids[j],
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
        })),
      });
      calls.forEach((tc, j) => out.push({ role: "tool", tool_call_id: ids[j], content: JSON.stringify(tc.result) }));
    }
    pushText("assistant", msg.content ?? "");
  });
  return out;
}

/** Adds text at the end of a message, whether its content is a string or parts (photos). */
function appendText(message: { content: string | VendorUserPart[] }, text: string): void {
  if (typeof message.content === "string") {
    message.content = `${message.content}\n\n${text}`;
    return;
  }
  message.content.push({ type: "text", text });
}

/** The turn's messages before its first round (see the file header for why this order). */
export function buildVendorTurnMessages(args: {
  systemPrompt: string;
  history: VendorChatMessage[];
  userMessage: string;
  turnContext: string;
  images?: readonly TurnImage[];
}): VendorChatMessage[] {
  const messages: VendorChatMessage[] = [{ role: "system", content: args.systemPrompt }, ...args.history];
  const last = messages[messages.length - 1];
  if (last && last.role === "user") appendText(last, args.userMessage);
  else messages.push({ role: "user", content: args.userMessage });
  const images = args.images ?? [];
  if (images.length > 0) {
    // The photos ride on this turn's user message, after its words, introduced
    // by one line (when, with which words): the model reads them natively.
    const user = messages[messages.length - 1] as { role: "user"; content: string | VendorUserPart[] };
    const parts: VendorUserPart[] = typeof user.content === "string" ? [{ type: "text", text: user.content }] : user.content;
    user.content = [
      ...parts,
      { type: "text", text: imagesIntro(images) },
      ...images.map((img) => ({ type: "image_url" as const, image_url: { url: imageDataUrl(img) } })),
    ];
  }
  const context = args.turnContext.trim();
  if (context) messages.push({ role: "system", content: context });
  return messages;
}

function mergeLines(a: VendorCostLine[], b: VendorCostLine[]): VendorCostLine[] {
  const byName = new Map<string, number>();
  for (const l of [...a, ...b]) byName.set(l.costName, (byName.get(l.costName) ?? 0) + l.quantity);
  return [...byName].map(([costName, quantity]) => ({ costName, quantity }));
}

function parseArgs(raw: string): Record<string, unknown> | null {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A note to the model after this turn's last message: joins a user message, else is its own. */
function pushNote(messages: VendorChatMessage[], text: string): void {
  const last = messages[messages.length - 1];
  if (last && last.role === "user") appendText(last, text);
  else messages.push({ role: "user", content: text });
}

export async function streamVendorChat(options: StreamVendorChatOptions): Promise<StreamVendorChatResult> {
  const {
    vendor,
    apiKey,
    model,
    costPrefix,
    systemPrompt,
    turnContext,
    history,
    userMessage,
    images = [],
    tools,
    res,
    sendSSE: sse,
    executeTool,
    signal,
    beforeProviderCall,
    holdTextBesideToolCalls = false,
    endToolName,
    reasoningDisabled = false,
    onRoundBilled,
  } = options;

  let tokensInput = 0;
  let lastRequestTokensInput = 0;
  let tokensOutput = 0;
  let costLines: VendorCostLine[] = [];
  let fullResponse = "";
  const toolCalls: ToolCallRecord[] = [];
  let emittedInputRequest = false;

  if (images.length > 0 && !VENDORS[vendor].imageInput) {
    throw new Error(`[vendor-chat] ${vendor} model="${model}" was handed ${images.length} photo(s) and does not take image input`);
  }

  const trim = trimGeminiHistoryToBudget(history);
  if (trim.trimmed) {
    console.log(`[vendor-chat] trimmed history ${history.length} → ${trim.history.length} messages (≈${trim.estimatedInputTokens} tokens)`);
  }
  const messages = buildVendorTurnMessages({
    systemPrompt,
    history: toVendorHistory(trim.history),
    userMessage,
    turnContext,
    images,
  });
  const vendorTools = toVendorTools(tools);

  let answerNudged = false;
  for (let depth = 0; depth <= MAX_TOOL_CHAIN_DEPTH; depth++) {
    if (signal.aborted) break;

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
      // The output cap's field name is vendor data (OpenAI: max_completion_tokens).
      [VENDORS[vendor].maxOutputTokensField]: VENDOR_CHAT_MAX_OUTPUT_TOKENS,
      // Tools are ALWAYS declared, `tool_choice: "none"` is never sent: with it
      // DeepSeek drops the tool definitions and the model writes fake tool-call
      // markup (`<｜DSML｜ invoke ...>`) into the text the person receives
      // (probed live 2026-11-01, CHAT-COST-1101). The final round and the
      // silent-turn re-ask say to answer now (their notes), and a call the model
      // makes anyway is not run.
      ...(vendorTools.length > 0 ? { tools: vendorTools } : {}),
      // Reasoning off, in THIS model's own words, when the caller says so
      // (VENDOR-TOOLS-FOLLOWUP-1112: the flag used to word refusals only, and
      // every turn ran with reasoning on). Absent = the model's default.
      ...(reasoningDisabled && VENDORS[vendor].reasoning.kind === "disablable"
        ? vendorReasoningFields(VENDORS[vendor].reasoning, model)
        : {}),
      // What THIS model needs beside tools (OpenAI Terra: reasoning_effort none).
      ...(vendorTools.length > 0 ? (VENDORS[vendor].toolCallRequestFields?.[model] ?? {}) : {}),
    };

    const at = new Date();
    await beforeProviderCall({ depth, requestBody: body, at });

    let json: VendorResponseBody;
    try {
      json = await postVendorChatCompletion({ vendor, apiKey, model, body, reasoningDisabled, signal });
    } catch (err) {
      if (signal.aborted) break;
      throw err;
    }
    const inBand = inBandError(json);
    if (inBand) throw new VendorProviderError(`[vendor-chat:${vendor}] Provider returned an error: ${inBand}`);
    assertModelMatches(model, json.model);

    const usage = json.usage ?? {};
    const promptTokens = usage.prompt_tokens ?? 0;
    // Where the cache counts sit is vendor data (DeepSeek, Moonshot and OpenAI
    // each report them elsewhere); OpenAI also bills cache WRITES apart.
    const cached = Math.max(0, Math.min(VENDORS[vendor].readCachedTokens(usage), promptTokens));
    const cacheWrites = Math.max(0, Math.min(VENDORS[vendor].readCacheWriteTokens?.(usage) ?? 0, promptTokens - cached));
    const outTokens = usage.completion_tokens ?? 0;
    tokensInput += promptTokens;
    lastRequestTokensInput = promptTokens;
    tokensOutput += outTokens;
    const roundLines = vendorCostLines({ provider: vendor, costPrefix, at, tokensInput: promptTokens, cachedInputTokens: cached, cacheWriteTokens: cacheWrites, tokensOutput: outTokens });
    costLines = mergeLines(costLines, roundLines);
    onRoundBilled?.(roundLines);
    console.log(`[vendor-chat] [${vendor}] model="${json.model ?? model}" depth=${depth} in=${promptTokens} cached=${cached} out=${outTokens}`);

    const choice = json.choices?.[0];
    const reply = choice?.message ?? {};
    const text = stripLongDashes(typeof reply.content === "string" ? reply.content : "");
    const reasoning = typeof reply.reasoning_content === "string" ? reply.reasoning_content : "";
    // The final round and the re-ask run no tool (a turn that must end on a
    // tool, a Lead event's answer_person, keeps calling it).
    const toolsOff = (isFinalToolRound(depth) || answerNudged) && !endToolName;
    const calls = toolsOff ? [] : (reply.tool_calls ?? []);

    if (reasoning.trim()) {
      sse(res, { type: "thinking_start" });
      sse(res, { type: "thinking_delta", thinking: reasoning });
      sse(res, { type: "thinking_stop" });
    }

    if (text.trim()) {
      if (calls.length === 0 || !holdTextBesideToolCalls) {
        fullResponse += text;
        sse(res, { type: "token", content: text });
      } else {
        console.warn(`[vendor-chat] dropped ${text.length} chars written beside ${calls.length} tool call(s)`);
      }
    }

    if (calls.length === 0) {
      if (endToolName && !answerNudged) {
        console.warn(`[vendor-chat] model=${model} stopped without ${endToolName}; asking for it`);
        answerNudged = true;
        if (text.trim()) messages.push({ role: "assistant", content: text });
        pushNote(messages, endToolNudgeNote(endToolName));
        depth--; // the re-ask is not a tool round
        continue;
      }
      if (needsAnswerNudge({ toolsRan: depth > 0, answerText: text, alreadyNudged: answerNudged })) {
        console.warn(`[vendor-chat] model=${model} ended silent after ${toolCalls.length} tool(s); asking it to answer now`);
        answerNudged = true;
        pushNote(messages, EMPTY_ANSWER_NOTE);
        depth--; // the re-ask is not a tool round
        continue;
      }
      if (choice?.finish_reason === "length") console.warn(`[vendor-chat] model=${model} answer truncated (finish_reason=length)`);
      break;
    }

    // The round as the model wrote it, its reasoning included (sent back
    // within the turn's tool loop, never stored across turns).
    messages.push({
      role: "assistant",
      content: text,
      tool_calls: calls,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
    });

    for (const call of calls) {
      const name = call.function?.name ?? "";
      const args = parseArgs(call.function?.arguments ?? "");
      const toolCallId = `tc_${crypto.randomUUID()}`;
      const isClientUiTool = CLIENT_UI_TOOL_NAMES.has(name);
      if (args === null) {
        const result = { error: `The arguments of ${name} were not valid JSON. Call it again with a JSON object.` };
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        continue;
      }
      if (!isClientUiTool) sse(res, { type: "tool_call", id: toolCallId, name, args });
      try {
        const toolResult = await executeTool({ name, args });
        if (toolResult === "input_request") {
          emittedInputRequest = true;
          return { tokensInput, lastRequestTokensInput, tokensOutput, costLines, fullResponse, toolCalls, emittedInputRequest };
        }
        if (toolResult === null) {
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "Unknown tool" }) });
          continue;
        }
        toolCalls.push({ name, args, result: toolResult.result });
        if (!isClientUiTool) sse(res, { type: "tool_result", id: toolCallId, name, result: toolResult.result });
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(toolResult.result) });
      } catch (toolErr: unknown) {
        const rawMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
        console.error(`[vendor-chat] Tool call ${name} failed:`, rawMsg);
        const friendly = formatToolError(name, rawMsg);
        sse(res, { type: "tool_result", id: toolCallId, name, result: friendly });
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(friendly) });
      }
    }

    // Before the final round, tell the model its tool budget is spent.
    if (isFinalToolRound(depth + 1)) {
      messages.push({ role: "user", content: endToolName ? endToolFinalNote(endToolName) : FINAL_ROUND_NOTE });
    }
  }

  return { tokensInput, lastRequestTokensInput, tokensOutput, costLines, fullResponse, toolCalls, emittedInputRequest };
}
