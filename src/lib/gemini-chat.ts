// ---------------------------------------------------------------------------
// Gemini streaming chat client — REST-based, no SDK dependency
// Handles streaming + function calling (agentic loop) for /chat endpoint
// ---------------------------------------------------------------------------

import type { Response as ExpressResponse } from "express";
import type { ToolCallRecord } from "../db/schema.js";
import { trimGeminiHistoryToBudget } from "./gemini-trim.js";
import { sanitizeGeminiSchema } from "./gemini.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Model-specific API timeouts in milliseconds. */
const GEMINI_TIMEOUT_MS: Record<string, number> = {
  "gemini-3.1-pro-preview": 15 * 60_000,
  "gemini-3-flash-preview": 10 * 60_000,
  "gemini-3.1-flash-lite": 5 * 60_000,
  "gemini-2.5-pro": 15 * 60_000,
  "gemini-2.5-flash": 10 * 60_000,
};
const DEFAULT_GEMINI_TIMEOUT_MS = 10 * 60_000;

const MAX_TOOL_CHAIN_DEPTH = 10;

// Gemini 3 requires a `thoughtSignature` on every functionCall part when the
// conversation history is replayed; omitting it returns a 400
// (`Function call ... is missing a thought_signature`). For calls captured
// before signatures were stored — or any injected call — Google sanctions a
// dummy bypass value. See https://ai.google.dev/gemini-api/docs/thought-signatures
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Provider-agnostic tool definition (matches Anthropic's shape). */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Gemini function declaration format. */
interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Gemini message part types. */
interface GeminiTextPart { text: string }
interface GeminiFunctionCallPart {
  functionCall: { name: string; args: Record<string, unknown>; id?: string };
  /** Opaque Gemini-3 reasoning token — must be echoed back on history replay. */
  thoughtSignature?: string;
}
interface GeminiFunctionResponsePart {
  functionResponse: { name: string; response: unknown; id?: string };
}
type GeminiPart = GeminiTextPart | GeminiFunctionCallPart | GeminiFunctionResponsePart;

interface GeminiMessage {
  role: "user" | "model";
  parts: GeminiPart[];
}

/** History entry shape consumed by toGeminiHistory. */
export type GeminiHistoryInput = Array<{
  role: "user" | "assistant";
  content: string;
  toolCalls?: Array<{
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
    thoughtSignature?: string;
  }> | null;
}>;

/** SSE event sender (same signature as index.ts sendSSE). */
type SendSSE = (res: ExpressResponse, data: unknown) => void;

/** Tool executor return type — matches what the /chat handler's executeTool returns. */
export type ToolExecutorResult =
  | { name: string; result: unknown }
  | "input_request"
  | null;

export type ToolExecutor = (
  call: { name: string; args: Record<string, unknown> },
) => Promise<ToolExecutorResult>;

export interface StreamGeminiChatOptions {
  apiKey: string;
  model: string;
  systemPrompt: string;
  history: GeminiHistoryInput;
  userMessage: string;
  tools: ToolDefinition[];
  res: ExpressResponse;
  sendSSE: SendSSE;
  executeTool: ToolExecutor;
  signal: AbortSignal;
}

export interface StreamGeminiChatResult {
  tokensInput: number;
  tokensOutput: number;
  fullResponse: string;
  toolCalls: ToolCallRecord[];
  emittedInputRequest: boolean;
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/**
 * Convert Anthropic-style tool definitions to Gemini functionDeclarations.
 *
 * Gemini's function-declaration `parameters` is the same restricted OpenAPI-3.0
 * `Schema` type as `responseSchema` — it rejects `additionalProperties`, `$ref`,
 * `$schema`, `const`, `examples`, `exclusiveMinimum/Maximum`, `multipleOf`, etc.
 * with HTTP 400 (`Unknown name "additionalProperties" at 'tools[0].
 * function_declarations[..].parameters.properties[..].value'`). MCP tool input
 * schemas (JSON-Schema 7) routinely carry these keywords, so strip them
 * recursively before sending — reusing the same deny-list the `/complete`
 * responseSchema path already applies. The supported keys the model needs
 * (`type`, `description`, `enum`, `properties`, `required`, `items`, `nullable`,
 * `format`, `pattern`, `minimum/maximum`, `anyOf`) are preserved.
 * See https://ai.google.dev/api/caching#Schema
 */
export function toGeminiFunctionDeclarations(
  tools: ToolDefinition[],
): GeminiFunctionDeclaration[] {
  return tools.map((t) => {
    const rawParameters: Record<string, unknown> = {
      type: "object",
      properties: t.input_schema.properties,
      ...(t.input_schema.required?.length ? { required: t.input_schema.required } : {}),
    };
    const { schema } = sanitizeGeminiSchema(rawParameters);
    return {
      name: t.name,
      description: t.description,
      parameters: schema as GeminiFunctionDeclaration["parameters"],
    };
  });
}

/**
 * Neutralize JSON-Schema / OpenAPI `$ref`s inside a tool result before it is
 * embedded in a `functionResponse.response`.
 *
 * Gemini 3 interprets `{"$ref": "<name>"}` inside the structured response as a
 * reference to a multimodal part (it substitutes the named part). A tool result
 * that contains an OpenAPI `$ref` (e.g. `{"$ref": "#/components/schemas/OrgId"}`,
 * returned by the api-registry / endpoint tools) collides with this: the name
 * has no matching part `displayName`, so the API returns
 * `400 INVALID_ARGUMENT: ... does not match to a display_name ...`.
 *
 * Renaming every `$ref` key to `ref` preserves the value as plain data the model
 * can still read, but stops Gemini from resolving it as a part reference.
 * See https://ai.google.dev/gemini-api/docs/function-calling
 */
export function sanitizeGeminiToolResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeGeminiToolResponse);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const safeKey = key === "$ref" && !("ref" in (value as Record<string, unknown>)) ? "ref" : key === "$ref" ? "schemaRef" : key;
    out[safeKey] = sanitizeGeminiToolResponse(val);
  }
  return out;
}

/**
 * Convert DB message history to Gemini format.
 *
 * Rebuilds `functionCall` + `functionResponse` pairs from the `toolCalls`
 * jsonb column so multi-turn agentic memory survives across turns. Without
 * this, the model has no record of which tools were called or what they
 * returned in prior turns and either re-fetches or hallucinates.
 *
 * Tool calls without a `result` are filtered out (e.g. `request_user_input`
 * which pauses the agentic loop) so we never emit a `functionCall` with no
 * matching `functionResponse`.
 */
export function toGeminiHistory(history: GeminiHistoryInput): GeminiMessage[] {
  const result: GeminiMessage[] = [];

  const pushOrMerge = (role: "user" | "model", parts: GeminiPart[]) => {
    if (parts.length === 0) return;
    const prev = result[result.length - 1];
    if (prev && prev.role === role) {
      prev.parts.push(...parts);
    } else {
      result.push({ role, parts });
    }
  };

  for (const msg of history) {
    if (msg.role === "user") {
      pushOrMerge("user", [{ text: msg.content }]);
      continue;
    }

    const text = msg.content ?? "";
    const validToolCalls = (msg.toolCalls ?? []).filter(
      (tc) => tc.result !== undefined,
    );

    const modelParts: GeminiPart[] = [];
    if (text.length > 0) {
      modelParts.push({ text });
    }
    for (const tc of validToolCalls) {
      modelParts.push({
        functionCall: { name: tc.name, args: tc.args },
        thoughtSignature: tc.thoughtSignature ?? SKIP_THOUGHT_SIGNATURE,
      });
    }

    if (modelParts.length === 0) continue;

    pushOrMerge("model", modelParts);

    if (validToolCalls.length > 0) {
      const responseParts: GeminiPart[] = validToolCalls.map((tc) => ({
        functionResponse: { name: tc.name, response: sanitizeGeminiToolResponse(tc.result) },
      }));
      pushOrMerge("user", responseParts);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Streaming SSE parser
// ---------------------------------------------------------------------------

interface GeminiStreamChunk {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;
        thoughtSignature?: string;
        functionCall?: { name: string; args: Record<string, unknown>; id?: string };
      }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
}

/**
 * SSE event boundary. Gemini's `alt=sse` stream frames events with any of these
 * delimiters — mirrors the official `@google/genai` SDK (`processStreamResponse`:
 * `delimiters = ['\n\n', '\r\r', '\r\n\r\n']`). Splitting on `"\n\n"` alone misses
 * the `\r\n\r\n` framing the API actually sends, yielding zero parsed events.
 */
const SSE_EVENT_BOUNDARY = /\r\n\r\n|\r\r|\n\n/;
/** Data-line prefix, stripped then trimmed — SDK uses `data:` (no required space). */
const SSE_DATA_PREFIX = "data:";

export interface ParsedGeminiSSE {
  /** Fully-received, JSON-parsed content chunks (error chunks excluded). */
  chunks: GeminiStreamChunk[];
  /** Buffer tail after the last complete event boundary — re-feed on next read. */
  rest: string;
  /** Set when the stream carried a `{"error":{...}}` payload (HTTP 200 + in-band error). */
  errorMessage?: string;
}

/**
 * Parse complete SSE events out of an accumulating buffer. Returns the parsed
 * chunks, any in-band error message, and the unconsumed tail (a partial event
 * still being received). Faithful to the official SDK: tolerant of `\n\n`,
 * `\r\r`, and `\r\n\r\n` framing and of `data:` with or without a trailing space.
 */
export function parseGeminiSSEBuffer(buffer: string): ParsedGeminiSSE {
  const chunks: GeminiStreamChunk[] = [];
  let rest = buffer;
  let errorMessage: string | undefined;

  let match: RegExpExecArray | null;
  while ((match = SSE_EVENT_BOUNDARY.exec(rest)) !== null) {
    const eventBlock = rest.slice(0, match.index);
    rest = rest.slice(match.index + match[0].length);

    // An event may span multiple `data:` lines (SDK joins them). Collect them.
    const dataPayload = eventBlock
      .split(/\r\n|\n|\r/)
      .filter((line) => line.startsWith(SSE_DATA_PREFIX))
      .map((line) => line.slice(SSE_DATA_PREFIX.length).trim())
      .join("");

    if (dataPayload === "" || dataPayload === "[DONE]") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(dataPayload);
    } catch {
      continue;
    }

    if (parsed && typeof parsed === "object" && "error" in (parsed as Record<string, unknown>)) {
      const errObj = (parsed as { error?: { message?: string } }).error;
      errorMessage = errObj?.message ?? JSON.stringify((parsed as Record<string, unknown>).error);
      continue;
    }

    chunks.push(parsed as GeminiStreamChunk);
  }

  return { chunks, rest, ...(errorMessage !== undefined ? { errorMessage } : {}) };
}

// ---------------------------------------------------------------------------
// Main streaming function
// ---------------------------------------------------------------------------

/**
 * Stream a Gemini chat with function calling support.
 * Emits the same SSE events as the Anthropic path for frontend compatibility.
 */
export async function streamGeminiChat(
  options: StreamGeminiChatOptions,
): Promise<StreamGeminiChatResult> {
  const {
    apiKey,
    model,
    systemPrompt,
    history,
    userMessage,
    tools,
    res,
    sendSSE: sse,
    executeTool,
    signal,
  } = options;

  let totalTokensInput = 0;
  let totalTokensOutput = 0;
  let fullResponse = "";
  const allToolCalls: ToolCallRecord[] = [];
  let emittedInputRequest = false;

  // Cap context to 200k tokens — chat-service deliberately stays out of the
  // 1M-token Gemini tier so cost and behavior match the Anthropic path.
  const trim = trimGeminiHistoryToBudget(history);
  if (trim.trimmed) {
    console.log(
      `[gemini-chat] trimmed history from ${history.length} → ${trim.history.length} messages ` +
        `(estimated input tokens ≈ ${trim.estimatedInputTokens})`,
    );
  }

  // Build Gemini message history
  const geminiHistory = toGeminiHistory(trim.history);

  // Build turn messages — history + current user message
  const turnMessages: GeminiMessage[] = [
    ...geminiHistory,
    { role: "user", parts: [{ text: userMessage }] },
  ];

  // Convert tools to Gemini format
  const functionDeclarations = tools.length > 0
    ? toGeminiFunctionDeclarations(tools)
    : [];

  const timeoutMs = GEMINI_TIMEOUT_MS[model] ?? DEFAULT_GEMINI_TIMEOUT_MS;

  // Agentic loop
  for (let depth = 0; depth <= MAX_TOOL_CHAIN_DEPTH; depth++) {
    if (signal.aborted) break;

    // Build request body
    const body: Record<string, unknown> = {
      contents: turnMessages,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        thinkingConfig: { thinkingBudget: 8192 },
      },
      ...(functionDeclarations.length > 0
        ? { tools: [{ functionDeclarations }] }
        : {}),
    };

    const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (err: unknown) {
      if (signal.aborted) break;
      throw err;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`[gemini-chat] API error ${response.status}: ${errorText}`);
    }

    // Parse SSE stream from Gemini
    const reader = response.body?.getReader();
    if (!reader) throw new Error("[gemini-chat] No response body");

    const decoder = new TextDecoder();
    let sseBuffer = "";
    let inThinking = false;
    const functionCalls: Array<{ name: string; args: Record<string, unknown>; id?: string; thoughtSignature?: string }> = [];
    let chunkTokensInput = 0;
    let chunkTokensOutput = 0;

    try {
      while (true) {
        if (signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });

        // Process complete SSE events (tolerant of \n\n, \r\r, \r\n\r\n framing).
        const parsedSSE = parseGeminiSSEBuffer(sseBuffer);
        sseBuffer = parsedSSE.rest;

        // HTTP 200 + in-band error payload — fail loud, never silently empty.
        if (parsedSSE.errorMessage !== undefined) {
          throw new Error(`[gemini-chat] streamed API error: ${parsedSSE.errorMessage}`);
        }

        for (const chunk of parsedSSE.chunks) {
          // Track usage
          if (chunk.usageMetadata) {
            chunkTokensInput = chunk.usageMetadata.promptTokenCount ?? chunkTokensInput;
            chunkTokensOutput = chunk.usageMetadata.candidatesTokenCount ?? chunkTokensOutput;
          }

          const parts = chunk.candidates?.[0]?.content?.parts;
          if (!parts) continue;

          for (const part of parts) {
            // Thinking support (Gemini 3.x)
            if (part.thought && part.text) {
              if (!inThinking) {
                sse(res, { type: "thinking_start" });
                inThinking = true;
              }
              sse(res, { type: "thinking_delta", thinking: part.text });
              continue;
            }

            // Close thinking if we get a non-thought part
            if (inThinking && !part.thought) {
              sse(res, { type: "thinking_stop" });
              inThinking = false;
            }

            // Text content
            if (part.text && !part.thought) {
              fullResponse += part.text;
              sse(res, { type: "token", content: part.text });
            }

            // Function call — capture the part's thoughtSignature so it can be
            // echoed back on the next turn (Gemini 3 requires it on replay).
            if (part.functionCall) {
              functionCalls.push({
                name: part.functionCall.name,
                args: part.functionCall.args ?? {},
                ...(part.functionCall.id ? { id: part.functionCall.id } : {}),
                ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
              });
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Close thinking if stream ended mid-thought
    if (inThinking) {
      sse(res, { type: "thinking_stop" });
    }

    totalTokensInput = chunkTokensInput;
    totalTokensOutput += chunkTokensOutput;

    // No function calls — we're done
    if (functionCalls.length === 0) break;

    // Execute function calls
    const modelParts: GeminiPart[] = [];
    const responseParts: GeminiPart[] = [];

    for (const fc of functionCalls) {
      modelParts.push({
        functionCall: {
          name: fc.name,
          args: fc.args,
          ...(fc.id ? { id: fc.id } : {}),
        },
        thoughtSignature: fc.thoughtSignature ?? SKIP_THOUGHT_SIGNATURE,
      });

      const toolCallId = `tc_${crypto.randomUUID()}`;
      if (fc.name !== "request_user_input") {
        sse(res, {
          type: "tool_call",
          id: toolCallId,
          name: fc.name,
          args: fc.args,
        });
      }

      try {
        const toolResult = await executeTool({ name: fc.name, args: fc.args });

        if (toolResult === "input_request") {
          emittedInputRequest = true;
          // Still add partial results so far
          return {
            tokensInput: totalTokensInput,
            tokensOutput: totalTokensOutput,
            fullResponse,
            toolCalls: allToolCalls,
            emittedInputRequest,
          };
        }

        if (toolResult === null) {
          responseParts.push({
            functionResponse: {
              name: fc.name,
              response: { error: "Unknown tool" },
              ...(fc.id ? { id: fc.id } : {}),
            },
          });
          continue;
        }

        allToolCalls.push({
          name: fc.name,
          args: fc.args,
          result: toolResult.result,
          ...(fc.thoughtSignature ? { thoughtSignature: fc.thoughtSignature } : {}),
        });
        sse(res, { type: "tool_result", id: toolCallId, name: fc.name, result: toolResult.result });
        responseParts.push({
          functionResponse: {
            name: fc.name,
            response: sanitizeGeminiToolResponse(toolResult.result),
            ...(fc.id ? { id: fc.id } : {}),
          },
        });
      } catch (toolErr: unknown) {
        const rawMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
        console.error(`[gemini-chat] Tool call ${fc.name} failed:`, rawMsg);
        const errorResult = { error: rawMsg };
        sse(res, { type: "tool_result", id: toolCallId, name: fc.name, result: errorResult });
        responseParts.push({
          functionResponse: {
            name: fc.name,
            response: errorResult,
            ...(fc.id ? { id: fc.id } : {}),
          },
        });
      }
    }

    // Append model function calls + tool results to conversation
    turnMessages.push({ role: "model", parts: modelParts });
    turnMessages.push({ role: "user", parts: responseParts });
  }

  // Fail loud on a wholly-empty result (no text, no tool calls, no input
  // request, no usage). A silent empty response surfaces to users as "the AI
  // returned an empty response" with no diagnostic — surface it as a 502 with
  // context instead. (This is the failure mode the SSE-framing bug produced.)
  if (
    !signal.aborted &&
    fullResponse === "" &&
    allToolCalls.length === 0 &&
    !emittedInputRequest &&
    totalTokensInput === 0
  ) {
    throw new Error(
      `[gemini-chat] empty response from model=${model} — no content, tool calls, or usage parsed from the stream`,
    );
  }

  return {
    tokensInput: totalTokensInput,
    tokensOutput: totalTokensOutput,
    fullResponse,
    toolCalls: allToolCalls,
    emittedInputRequest,
  };
}
