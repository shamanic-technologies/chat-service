// ---------------------------------------------------------------------------
// /complete and /internal/platform-complete with the brand's tools
// (BRAND-MCP-1109). Opt-in per request (`brandTools`): without it, both
// endpoints run their one-shot call exactly as before.
//
// With it, the call becomes a bounded tool loop on the same loops /chat runs
// (vendor-chat.ts, gemini-chat.ts: same tool budget, same per-round cost
// hook), the brand's MCP tools beside ONE tool whose input IS the caller's
// output (its `responseSchema`, or `{ text }` in text mode). The model reads
// what it needs, acts when asked, and ends by calling that tool: the caller
// gets its structured output, as from a plain /complete.
// ---------------------------------------------------------------------------

import type { Response as ExpressResponse } from "express";
import type { BrandToolset } from "./brand-mcp.js";
import { BRAND_TOOLS_LINE } from "./brand-mcp.js";
import type { GeminiCostLine } from "./gemini-usage.js";
import { streamGeminiChat, type ToolDefinition, type ToolExecutor } from "./gemini-chat.js";
import type { GeminiThinkingLevel } from "./gemini.js";
import type { VendorId } from "./openai-compatible.js";
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

export interface BrandToolsCompleteArgs {
  provider: "google" | VendorId;
  apiKey: string;
  /** Versioned model id. */
  model: string;
  costPrefix: string;
  systemPrompt: string;
  message: string;
  responseSchema?: Record<string, unknown> | null;
  toolset: BrandToolset;
  /** Before every provider request (the first one is already held by the caller): depth and the request. */
  beforeProviderCall: (details: { depth: number; requestBody: Record<string, unknown>; at: Date }) => Promise<void>;
  /** Direct vendors: send the reasoning-off field. */
  disableThinking?: boolean;
  thinkingLevel?: GeminiThinkingLevel;
}

export interface BrandToolsCompleteResult {
  content: string;
  tokensInput: number;
  tokensOutput: number;
  model: string;
  /** Every billed line of every round, merged by name. */
  costLines: Array<{ costName: string; quantity: number }>;
  /** Brand tool calls made. */
  toolCalls: number;
}

export class NoOutputError extends Error {
  costLines: Array<{ costName: string; quantity: number }> = [];
  tokensInput = 0;
  tokensOutput = 0;
  constructor() {
    super(`the model ended without calling ${OUTPUT_TOOL_NAME}`);
    this.name = "NoOutputError";
  }
}

/** A response object nobody reads: the loops stream to it, the caller gets JSON. */
function silentResponse(): ExpressResponse {
  return { write: () => true, flush: () => undefined, writableEnded: false } as unknown as ExpressResponse;
}

export async function completeWithBrandTools(args: BrandToolsCompleteArgs): Promise<BrandToolsCompleteResult> {
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
  };
  let costLines: Array<{ costName: string; quantity: number }>;
  let tokensInput: number;
  let tokensOutput: number;
  if (args.provider === "google") {
    const r = await streamGeminiChat({
      ...hooks,
      apiKey: args.apiKey,
      model: args.model,
      systemPrompt,
      history: [],
      userMessage: args.message,
      tools,
      ...(args.thinkingLevel ? { thinkingLevel: args.thinkingLevel } : {}),
      beforeProviderCall: ({ depth, requestBody }) => args.beforeProviderCall({ depth, requestBody, at: new Date() }),
    });
    costLines = (r.costLines as GeminiCostLine[]).map((l) => ({ costName: l.costName, quantity: l.quantity }));
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
      reasoningDisabled: args.disableThinking === true,
    });
    costLines = r.costLines;
    tokensInput = r.tokensInput;
    tokensOutput = r.tokensOutput;
  }
  if (!captured.done) {
    // The rounds that ran were spent: the error carries their lines so the caller still declares them.
    throw Object.assign(new NoOutputError(), { costLines, tokensInput, tokensOutput });
  }
  const content = output.textMode ? String(captured.value ?? "") : JSON.stringify(captured.value);
  return { content, tokensInput, tokensOutput, model: args.model, costLines, toolCalls: calls };
}

/**
 * Why a `/complete` with `brandTools` cannot run here, or null. The tool loops
 * are google's and the direct vendors'; web search and image input are
 * one-shot features of the plain call.
 */
export function brandToolsRefusalFor(
  brandTools: unknown,
  provider: string,
  opts: { webSearch: boolean; imageUrl: boolean },
): string | null {
  if (!brandTools) return null;
  if (provider === "anthropic") return 'brandTools is served on provider "google" and the direct vendors (deepseek, zai, moonshot, openai), not on "anthropic" yet.';
  if (opts.webSearch) return "brandTools cannot be combined with webSearch.";
  if (opts.imageUrl) return "brandTools cannot be combined with imageUrl.";
  return null;
}
