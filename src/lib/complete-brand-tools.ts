// ---------------------------------------------------------------------------
// /complete and /internal/platform-complete with the brand's tools
// (BRAND-MCP-1109). Opt-in per request (`brandTools`): without it, both
// endpoints run their one-shot call exactly as before.
//
// With it, the call becomes a bounded tool loop on every provider /complete
// serves: the /chat loops for google and the direct vendors (vendor-chat.ts,
// gemini-chat.ts), Anthropic's own tool-use loop here (same tool budget, same
// per-round cost hook), the brand's MCP tools beside ONE tool whose input IS
// the caller's output (its `responseSchema`, or `{ text }` in text mode). The
// model reads what it needs, acts when asked, and ends by calling that tool:
// the caller gets its structured output, as from a plain /complete.
//
// Every round's billed lines land in the caller's `spend` ledger the moment
// its usage is read, so a loop that fails at round N still has rounds 1..N-1
// declared (no undeclared spend on any path).
// ---------------------------------------------------------------------------

import type Anthropic from "@anthropic-ai/sdk";
import type { Response as ExpressResponse } from "express";
import type { AnthropicEffort } from "../schemas.js";
import { createAnthropicClient } from "./anthropic.js";
import { anthropicCostLines, anthropicPromptTokens } from "./anthropic-usage.js";
import type { BrandToolset } from "./brand-mcp.js";
import { BRAND_TOOLS_LINE } from "./brand-mcp.js";
import { streamGeminiChat, type ToolDefinition, type ToolExecutor } from "./gemini-chat.js";
import { fetchImageAsBase64, type GeminiThinkingLevel } from "./gemini.js";
import type { VendorId } from "./openai-compatible.js";
import { endToolFinalNote, endToolNudgeNote, isFinalToolRound, MAX_TOOL_CHAIN_DEPTH } from "./tool-budget.js";
import { formatToolError } from "./tool-errors.js";
import { streamVendorChat } from "./vendor-chat.js";

export const OUTPUT_TOOL_NAME = "return_output";

/** The caller's output as a tool: its schema when it is an object, else wrapped under `output`; `{ text }` in text mode. */
export function buildOutputTool(responseSchema: Record<string, unknown> | null | undefined): { tool: ToolDefinition; unwrap: (args: Record<string, unknown>) => unknown; textMode: boolean } {
  const description =
    "Your final answer. Call it ONCE, last, when you have read what you need and done what was asked: it ends your work and is what the caller receives.";
  if (!responseSchema) {
    return {
      tool: { name: OUTPUT_TOOL_NAME, description, input_schema: { type: "object", properties: { text: { type: "string", description: "The answer." } }, required: ["text"] } },
      unwrap: (a) => (typeof a.text === "string" ? a.text : ""),
      textMode: true,
    };
  }
  const props = responseSchema.properties;
  if (responseSchema.type === "object" && props && typeof props === "object" && !Array.isArray(props)) {
    const required = Array.isArray(responseSchema.required) ? (responseSchema.required as unknown[]).filter((r): r is string => typeof r === "string") : [];
    return {
      tool: { name: OUTPUT_TOOL_NAME, description, input_schema: { type: "object", properties: props as Record<string, unknown>, ...(required.length ? { required } : {}) } },
      unwrap: (a) => a,
      textMode: false,
    };
  }
  return {
    tool: { name: OUTPUT_TOOL_NAME, description, input_schema: { type: "object", properties: { output: responseSchema }, required: ["output"] } },
    unwrap: (a) => a.output,
    textMode: false,
  };
}

/** The one line /complete adds to the caller's system prompt when the brand's tools are there. */
export function brandToolsSystemPrompt(systemPrompt: string): string {
  return `${systemPrompt}${systemPrompt.trim() ? "\n\n" : ""}${BRAND_TOOLS_LINE} End by calling ${OUTPUT_TOOL_NAME} with your answer.`;
}

/** One billed catalog line. */
export interface SpendLine {
  costName: string;
  quantity: number;
}

/**
 * What a brand-tools loop has SPENT so far, filled round by round. REQUIRED of
 * every caller: the route declares exactly these lines (actual) whether the
 * loop returns or throws, so no round is ever spent without a declaration.
 */
export interface BrandToolsSpend {
  lines: SpendLine[];
  searchCount: number;
}

export function newBrandToolsSpend(): BrandToolsSpend {
  return { lines: [], searchCount: 0 };
}

function addLines(spend: BrandToolsSpend, lines: readonly SpendLine[]): void {
  for (const l of lines) {
    if (l.quantity <= 0) continue;
    const prev = spend.lines.find((x) => x.costName === l.costName);
    if (prev) prev.quantity += l.quantity;
    else spend.lines.push({ costName: l.costName, quantity: l.quantity });
  }
}

export interface BrandToolsCompleteArgs {
  provider: "google" | "anthropic" | VendorId;
  apiKey: string;
  /** Versioned model id. */
  model: string;
  costPrefix: string;
  systemPrompt: string;
  message: string;
  responseSchema?: Record<string, unknown> | null;
  toolset: BrandToolset;
  /** Filled round by round (see BrandToolsSpend): the caller declares it on success AND failure. */
  spend: BrandToolsSpend;
  /** Before every provider request (the first one is already held by the caller): depth and the request. */
  beforeProviderCall: (details: { depth: number; requestBody: Record<string, unknown>; at: Date }) => Promise<void>;
  /** Direct vendors: send the reasoning-off field. Gemini/Anthropic: minimize thinking (as on the plain call). */
  disableThinking?: boolean;
  thinkingLevel?: GeminiThinkingLevel;
  /** Anthropic: caller-stated effort (adaptive thinking), as on the plain call. */
  effort?: AnthropicEffort;
  /** Anthropic: sampling, refused upstream on the models that removed it. */
  temperature?: number;
  /** Anthropic: per-request output cap. */
  maxTokens?: number;
  /** Anthropic: cache the system prompt + tools (only on a cache-priced model). */
  cache?: boolean;
  /** Anthropic: server-side web search beside the brand's tools. */
  webSearch?: boolean;
  /** An image the model reads with the message (anthropic, google). */
  imageUrl?: string;
  imageContext?: { alt?: string; title?: string; sourceUrl?: string };
}

export interface BrandToolsCompleteResult {
  content: string;
  tokensInput: number;
  tokensOutput: number;
  model: string;
  /** Every billed line of every round, merged by name (= `spend.lines`). */
  costLines: SpendLine[];
  /** Brand tool calls made. */
  toolCalls: number;
  /** Server-side web searches run (Anthropic `webSearch`). */
  searchCount: number;
  sources: Array<{ url: string; title?: string }>;
}

export class NoOutputError extends Error {
  constructor() {
    super(`the model ended without calling ${OUTPUT_TOOL_NAME}`);
    this.name = "NoOutputError";
  }
}

/** A response object nobody reads: the loops stream to it, the caller gets JSON. */
function silentResponse(): ExpressResponse {
  return { write: () => true, flush: () => undefined, writableEnded: false } as unknown as ExpressResponse;
}

/** The message with the image's metadata, as the plain Gemini call writes it. */
function messageWithImageContext(message: string, ctx: BrandToolsCompleteArgs["imageContext"]): string {
  if (!ctx || !(ctx.alt || ctx.title || ctx.sourceUrl)) return message;
  const lines: string[] = [];
  if (ctx.alt) lines.push(`Alt text: ${ctx.alt}`);
  if (ctx.title) lines.push(`Title: ${ctx.title}`);
  if (ctx.sourceUrl) lines.push(`Source page: ${ctx.sourceUrl}`);
  return `${message}\n\nImage metadata:\n${lines.join("\n")}`;
}

export async function completeWithBrandTools(args: BrandToolsCompleteArgs): Promise<BrandToolsCompleteResult> {
  if (args.provider === "anthropic") return completeWithBrandToolsAnthropic(args);
  const output = buildOutputTool(args.responseSchema);
  const captured: { value: unknown; done: boolean } = { value: null, done: false };
  let calls = 0;
  const executeTool: ToolExecutor = async ({ name, args: a }) => {
    if (name === OUTPUT_TOOL_NAME) {
      captured.value = output.unwrap(a ?? {});
      captured.done = true;
      return "input_request";
    }
    if (!args.toolset.has(name)) return null;
    calls++;
    return { name, result: await args.toolset.call(name, a ?? {}) };
  };
  const tools = [...args.toolset.tools, output.tool];
  const systemPrompt = brandToolsSystemPrompt(args.systemPrompt);
  const hooks = {
    res: silentResponse(),
    sendSSE: () => undefined,
    executeTool,
    signal: new AbortController().signal,
    holdTextBesideToolCalls: true,
    endToolName: OUTPUT_TOOL_NAME,
    onRoundBilled: (lines: SpendLine[]) => addLines(args.spend, lines),
  };
  let tokensInput: number;
  let tokensOutput: number;
  if (args.provider === "google") {
    const image = args.imageUrl ? await fetchImageAsBase64(args.imageUrl) : null;
    const r = await streamGeminiChat({
      ...hooks,
      apiKey: args.apiKey,
      model: args.model,
      systemPrompt,
      history: [],
      userMessage: args.imageUrl ? messageWithImageContext(args.message, args.imageContext) : args.message,
      ...(image ? { userImages: [image] } : {}),
      tools,
      ...(args.thinkingLevel ? { thinkingLevel: args.thinkingLevel } : {}),
      beforeProviderCall: ({ depth, requestBody }) => args.beforeProviderCall({ depth, requestBody, at: new Date() }),
    });
    tokensInput = r.tokensInput;
    tokensOutput = r.tokensOutput;
  } else {
    const r = await streamVendorChat({
      ...hooks,
      vendor: args.provider,
      apiKey: args.apiKey,
      model: args.model,
      costPrefix: args.costPrefix,
      systemPrompt,
      turnContext: "",
      history: [],
      userMessage: args.message,
      tools,
      beforeProviderCall: args.beforeProviderCall,
      // As the plain call decides it (shouldDisableVendorReasoning): the
      // caller's word, else off for a structured answer.
      reasoningDisabled: args.disableThinking ?? args.responseSchema != null,
    });
    tokensInput = r.tokensInput;
    tokensOutput = r.tokensOutput;
  }
  // The rounds that ran were spent: they are in args.spend, which the caller declares.
  if (!captured.done) throw new NoOutputError();
  const content = output.textMode ? String(captured.value ?? "") : JSON.stringify(captured.value);
  return { content, tokensInput, tokensOutput, model: args.model, costLines: args.spend.lines.map((l) => ({ ...l })), toolCalls: calls, searchCount: 0, sources: [] };
}

/**
 * Anthropic's own tool-use loop: same budget and notes as the /chat loops
 * (tool-budget.ts), every assistant message sent back verbatim (thinking and
 * tool_use blocks included, as Anthropic requires within a tool loop). Never
 * a forced tool_choice (refused beside thinking): the final round and the
 * single re-ask TELL the model to call return_output.
 */
async function completeWithBrandToolsAnthropic(args: BrandToolsCompleteArgs): Promise<BrandToolsCompleteResult> {
  const output = buildOutputTool(args.responseSchema);
  const systemPrompt = brandToolsSystemPrompt(args.systemPrompt);
  const claude = createAnthropicClient({ apiKey: args.apiKey, systemPrompt });
  const tools = [...args.toolset.tools, output.tool] as unknown as Anthropic.Tool[];
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: args.imageUrl
        ? [
            { type: "image", source: { type: "url", url: args.imageUrl } },
            { type: "text", text: args.message },
          ]
        : args.message,
    },
  ];
  let tokensInput = 0;
  let tokensOutput = 0;
  let calls = 0;
  let nudged = false;
  const sources: Array<{ url: string; title?: string }> = [];
  const captured: { value: unknown; done: boolean } = { value: null, done: false };

  for (let depth = 0; depth <= MAX_TOOL_CHAIN_DEPTH; depth++) {
    await args.beforeProviderCall({ depth, requestBody: { system: systemPrompt, messages, tools }, at: new Date() });
    const round = await claude.toolRound(messages, tools, {
      model: args.model,
      ...(args.temperature != null ? { temperature: args.temperature } : {}),
      ...(args.maxTokens != null ? { maxTokens: args.maxTokens } : {}),
      ...(args.webSearch ? { webSearch: true } : {}),
      ...(args.disableThinking ? { disableThinking: true } : {}),
      ...(args.effort ? { effort: args.effort } : {}),
      ...(args.cache ? { cache: true } : {}),
    });
    addLines(args.spend, anthropicCostLines(args.costPrefix, round.billed));
    args.spend.searchCount += round.searchCount;
    tokensInput += anthropicPromptTokens(round.billed);
    tokensOutput += round.billed.tokensOutput;
    for (const src of round.sources) if (!sources.some((x) => x.url === src.url)) sources.push(src);

    const content = round.message.content;
    const toolUses = content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (round.message.stop_reason === "pause_turn") {
      // A long server-side search paused the turn: send it back as is to resume.
      messages.push({ role: "assistant", content });
      continue;
    }
    if (toolUses.length === 0) {
      if (nudged) break;
      console.warn(`[complete-brand-tools] model=${args.model} stopped without ${OUTPUT_TOOL_NAME}; asking for it`);
      nudged = true;
      if (content.length > 0) messages.push({ role: "assistant", content });
      messages.push({ role: "user", content: endToolNudgeNote(OUTPUT_TOOL_NAME) });
      depth--; // the re-ask is not a tool round
      continue;
    }
    messages.push({ role: "assistant", content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const input = (use.input && typeof use.input === "object" ? use.input : {}) as Record<string, unknown>;
      if (use.name === OUTPUT_TOOL_NAME) {
        captured.value = output.unwrap(input);
        captured.done = true;
        break;
      }
      if (!args.toolset.has(use.name)) {
        results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify({ error: "Unknown tool" }), is_error: true });
        continue;
      }
      calls++;
      try {
        const result = await args.toolset.call(use.name, input);
        results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(result) });
      } catch (toolErr: unknown) {
        const raw = toolErr instanceof Error ? toolErr.message : String(toolErr);
        console.error(`[complete-brand-tools] Tool call ${use.name} failed:`, raw);
        results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(formatToolError(use.name, raw)), is_error: true });
      }
    }
    if (captured.done) break;
    messages.push({
      role: "user",
      content: isFinalToolRound(depth + 1)
        ? [...results, { type: "text", text: endToolFinalNote(OUTPUT_TOOL_NAME) }]
        : results,
    });
  }

  if (!captured.done) throw new NoOutputError();
  const contentOut = output.textMode ? String(captured.value ?? "") : JSON.stringify(captured.value);
  return {
    content: contentOut,
    tokensInput,
    tokensOutput,
    model: args.model,
    costLines: args.spend.lines.map((l) => ({ ...l })),
    toolCalls: calls,
    searchCount: args.spend.searchCount,
    sources,
  };
}

/**
 * Why a `/complete` with `brandTools` cannot run here, or null. Every provider
 * runs the tool loop; the one combination left is Google web search beside
 * the brand's tools: Gemini's generateContent cannot ground on Google Search
 * and call functions in the same request (Google serves that pairing only on
 * its Interactions API). Images and web search elsewhere follow the plain
 * call's own rules (the direct vendors refuse both before this check).
 */
export function brandToolsRefusalFor(
  brandTools: unknown,
  provider: string,
  opts: { webSearch: boolean; imageUrl: boolean },
): string | null {
  if (!brandTools) return null;
  if (provider === "google" && opts.webSearch) {
    return 'brandTools cannot be combined with webSearch on provider "google": Gemini cannot ground on Google Search and call the brand\'s tools in one request. Use provider "anthropic" for both, or drop webSearch.';
  }
  return null;
}
