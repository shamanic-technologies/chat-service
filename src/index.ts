import express from "express";
import cors from "cors";
import crypto from "crypto";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { db } from "./db/index.js";
import { sessions, messages, appConfigs, platformConfigs } from "./db/schema.js";
import { eq, and } from "drizzle-orm";
import {
  createGeminiClient,
  buildSystemPrompt,
  BUILTIN_TOOLS,
  type UsageMetadata,
} from "./lib/gemini.js";
import {
  updateWorkflow,
  validateWorkflow,
  updateWorkflowNodeConfig,
  getWorkflow,
  getWorkflowRequiredProviders,
  listWorkflows,
} from "./lib/workflow-client.js";
import { getPromptTemplate, updatePromptTemplate } from "./lib/content-generation-client.js";
import { listAvailableServices } from "./lib/api-registry-client.js";
import { createRun, updateRunStatus, addRunCosts } from "./lib/runs-client.js";
import { formatToolError } from "./lib/tool-errors.js";
import { resolveKey, type ResolvedKey } from "./lib/key-client.js";
import { ChatRequestSchema, AppConfigRequestSchema, PlatformConfigRequestSchema } from "./schemas.js";
import { requireAuth, requireInternalAuth, type AuthLocals } from "./middleware/auth.js";
import type { Content, Part } from "@google/genai";
import type { ButtonRecord, ToolCallRecord } from "./db/schema.js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const openapiPath = join(__dirname, "..", "openapi.json");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = parseInt(process.env.PORT || "3002", 10);

function sendSSE(res: express.Response, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

app.get("/openapi.json", (_req, res) => {
  if (existsSync(openapiPath)) {
    res.json(JSON.parse(readFileSync(openapiPath, "utf-8")));
  } else {
    res.status(404).json({
      error: "OpenAPI spec not generated. Run: npm run generate:openapi",
    });
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// --- App Config Registration ---

app.put("/config", requireAuth, async (req, res) => {
  const { orgId } = res.locals as AuthLocals;

  const parsed = AppConfigRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  const { systemPrompt } = parsed.data;

  const [config] = await db
    .insert(appConfigs)
    .values({
      orgId,
      systemPrompt,
    })
    .onConflictDoUpdate({
      target: [appConfigs.orgId],
      set: {
        systemPrompt,
        updatedAt: new Date(),
      },
    })
    .returning();

  res.json({
    orgId: config.orgId,
    systemPrompt: config.systemPrompt,
    createdAt: config.createdAt.toISOString(),
    updatedAt: config.updatedAt.toISOString(),
  });
});

// --- Platform Config Registration ---

const PLATFORM_CONFIG_KEY = "default";

app.put("/platform-config", requireInternalAuth, async (req, res) => {
  const parsed = PlatformConfigRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  const { systemPrompt } = parsed.data;

  const [config] = await db
    .insert(platformConfigs)
    .values({
      key: PLATFORM_CONFIG_KEY,
      systemPrompt,
    })
    .onConflictDoUpdate({
      target: [platformConfigs.key],
      set: {
        systemPrompt,
        updatedAt: new Date(),
      },
    })
    .returning();

  res.json({
    systemPrompt: config.systemPrompt,
    createdAt: config.createdAt.toISOString(),
    updatedAt: config.updatedAt.toISOString(),
  });
});

// --- Chat ---

app.post("/chat", requireAuth, async (req, res) => {
  const { orgId, userId, runId: callerRunId, workflowTracking } = res.locals as AuthLocals;

  // Build tracking headers to forward to downstream services
  const trackingHeaders: Record<string, string> = {};
  if (workflowTracking.campaignId) trackingHeaders["x-campaign-id"] = workflowTracking.campaignId;
  if (workflowTracking.brandId) trackingHeaders["x-brand-id"] = workflowTracking.brandId;
  if (workflowTracking.workflowName) trackingHeaders["x-workflow-name"] = workflowTracking.workflowName;

  const parsed = ChatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  const { message, sessionId, context } = parsed.data;

  // Look up app config by orgId, fall back to platform config
  const [orgConfig] = await db
    .select()
    .from(appConfigs)
    .where(eq(appConfigs.orgId, orgId));

  const appConfig = orgConfig ?? (await db
    .select()
    .from(platformConfigs)
    .where(eq(platformConfigs.key, PLATFORM_CONFIG_KEY))
    .then(([row]) => row ?? null));

  if (!appConfig) {
    return res.status(404).json({
      error: `No chat config found for org="${orgId}". Register via PUT /config or PUT /platform-config.`,
    });
  }

  // Resolve Gemini API key per-request (supports BYOK per org)
  let resolvedKey: ResolvedKey;
  try {
    resolvedKey = await resolveKey({
      provider: "gemini",
      orgId,
      userId,
      runId: callerRunId,
      caller: { method: "POST", path: "/chat" },
      trackingHeaders,
    });
  } catch (err) {
    console.error(`Failed to resolve Gemini key for org="${orgId}":`, err);
    return res.status(502).json({
      error: `Failed to resolve Gemini API key. Ensure the key is configured in key-service.`,
    });
  }

  // SSE headers — disable proxy buffering so tokens stream immediately
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Build system prompt with optional context
  const systemPrompt = buildSystemPrompt(appConfig.systemPrompt, context);
  const gemini = createGeminiClient({ apiKey: resolvedKey.key, systemPrompt });

  let runId: string | null = null;
  let chatFailed = false;
  let totalPromptTokens = 0;
  let totalOutputTokens = 0;
  let totalSearchQueries = 0;

  try {
    // Get or create session (scoped by org + user + app)
    let currentSessionId = sessionId;
    if (!currentSessionId) {
      const [session] = await db
        .insert(sessions)
        .values({ orgId, userId })
        .returning();
      currentSessionId = session.id;
    } else {
      // Validate session ownership
      const [existing] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, currentSessionId));
      if (!existing || existing.orgId !== orgId) {
        sendSSE(res, {
          type: "token",
          content: "Session not found.",
        });
        sendSSE(res, "[DONE]");
        res.end();
        return;
      }
    }

    sendSSE(res, { sessionId: currentSessionId });
    console.log(`[chat] session="${currentSessionId}" org="${orgId}" user="${userId}" — start`);

    // Register run in RunsService (mandatory — fail request if unavailable)
    try {
      const run = await createRun(
        { serviceName: "chat-service", taskName: "chat" },
        { orgId, userId, runId: callerRunId },
        trackingHeaders,
      );
      runId = run.id;
      console.log(`[chat] session="${currentSessionId}" run="${runId}" created`);
    } catch (runErr) {
      console.error(`[chat] session="${currentSessionId}" run creation failed:`, runErr);
      sendSSE(res, {
        type: "error",
        message: "Service temporarily unavailable (run tracking). Please try again.",
      });
      sendSSE(res, "[DONE]");
      res.end();
      return;
    }

    // Load conversation history
    const history = await db.query.messages.findMany({
      where: eq(messages.sessionId, currentSessionId),
      orderBy: (m, { asc }) => [asc(m.createdAt)],
    });

    const geminiHistory: Content[] = history
      .filter((m) => m.role !== "tool")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    // Save user message
    await db.insert(messages).values({
      sessionId: currentSessionId,
      role: "user",
      content: message.trim(),
      campaignId: workflowTracking.campaignId ?? null,
      brandId: workflowTracking.brandId ?? null,
      workflowName: workflowTracking.workflowName ?? null,
    });

    // Stream response from Gemini
    let fullResponse = "";
    let emittedInputRequest = false;
    const toolCalls: ToolCallRecord[] = [];

    // Line buffer: hold back trailing lines that match button syntax
    // so they aren't streamed as tokens (only sent as buttons event)
    const BUTTON_RE = /^[-*]\s*\[.+?\]\s*$/;
    let lineBuf = "";
    let held = "";

    function bufferToken(chunk: string): void {
      fullResponse += chunk;

      // Split combined buffer + chunk on newlines
      const combined = lineBuf + chunk;
      const parts = combined.split("\n");
      // Last element is the remaining partial line (empty string if chunk ended with \n)
      const partial = parts.pop()!;

      // Process each complete line (terminated by \n)
      for (const line of parts) {
        const fullLine = line + "\n";
        if (BUTTON_RE.test(line.trimEnd())) {
          held += fullLine;
        } else {
          if (held) {
            sendSSE(res, { type: "token", content: held });
            held = "";
          }
          sendSSE(res, { type: "token", content: fullLine });
        }
      }

      lineBuf = partial;

      // Flush partial line immediately unless it could be the start of a button line
      if (lineBuf && !/^[-*]\s*\[/.test(lineBuf)) {
        if (held) {
          sendSSE(res, { type: "token", content: held });
          held = "";
        }
        sendSSE(res, { type: "token", content: lineBuf });
        lineBuf = "";
      }
    }

    const allTools = BUILTIN_TOOLS;

    function accumulateUsage(usage?: UsageMetadata) {
      if (!usage) return;
      totalPromptTokens += usage.promptTokens;
      totalOutputTokens += usage.outputTokens;
      totalSearchQueries += usage.searchQueryCount;
    }

    // Track turn history incrementally so chained tool calls include prior calls/results
    const turnParts: Content[] = [];

    /**
     * Execute a server-side tool (built-in) and return the result.
     * Returns null if the tool is client-side (request_user_input) or unhandled.
     */
    async function executeTool(
      call: { name: string; args: Record<string, unknown>; thoughtSignature?: string },
    ): Promise<{ name: string; result: unknown } | "input_request" | null> {
      // Client-side tool: emit input_request and signal to stop
      if (call.name === "request_user_input") {
        const args = (call.args as Record<string, unknown>) || {};
        sendSSE(res, {
          type: "input_request",
          input_type: args.input_type ?? "text",
          label: args.label ?? "Please provide input",
          ...(args.placeholder ? { placeholder: args.placeholder } : {}),
          field: args.field ?? "input",
          ...(args.value ? { value: args.value } : {}),
        });
        emittedInputRequest = true;
        return "input_request";
      }

      // Built-in workflow read tool
      if (call.name === "get_workflow_details") {
        const args = (call.args as Record<string, unknown>) || {};
        const result = await getWorkflow(
          args.workflowId as string,
          {
            orgId,
            userId,
            runId: runId!,
            trackingHeaders: Object.keys(trackingHeaders).length > 0 ? trackingHeaders as Record<string, string> : undefined,
          },
        );

        toolCalls.push({ name: call.name, args, result });
        return { name: call.name, result };
      }

      // Built-in workflow tools
      if (call.name === "update_workflow" || call.name === "validate_workflow") {
        const wfParams = {
          orgId,
          userId,
          runId: runId!,
          trackingHeaders: Object.keys(trackingHeaders).length > 0 ? trackingHeaders as Record<string, string> : undefined,
        };
        const args = (call.args as Record<string, unknown>) || {};
        let result: unknown;

        if (call.name === "update_workflow") {
          const { workflowId, ...updateBody } = args;
          result = await updateWorkflow(
            workflowId as string,
            updateBody as import("./lib/workflow-client.js").UpdateWorkflowBody,
            wfParams,
          );
        } else {
          result = await validateWorkflow(
            args.workflowId as string,
            wfParams,
          );
        }

        toolCalls.push({ name: call.name, args, result });
        return { name: call.name, result };
      }

      // Built-in workflow required providers tool
      if (call.name === "get_workflow_required_providers") {
        const args = (call.args as Record<string, unknown>) || {};
        const result = await getWorkflowRequiredProviders(
          args.workflowId as string,
          {
            orgId,
            userId,
            runId: runId!,
            trackingHeaders: Object.keys(trackingHeaders).length > 0 ? trackingHeaders as Record<string, string> : undefined,
          },
        );

        toolCalls.push({ name: call.name, args, result });
        return { name: call.name, result };
      }

      // Built-in list workflows tool
      if (call.name === "list_workflows") {
        const args = (call.args as Record<string, unknown>) || {};
        const result = await listWorkflows(
          {
            category: args.category as string | undefined,
            channel: args.channel as string | undefined,
            tags: args.tags as string[] | undefined,
            search: args.search as string | undefined,
          },
          {
            orgId,
            userId,
            runId: runId!,
            trackingHeaders: Object.keys(trackingHeaders).length > 0 ? trackingHeaders as Record<string, string> : undefined,
          },
        );

        toolCalls.push({ name: call.name, args, result });
        return { name: call.name, result };
      }

      // Built-in workflow node config update tool
      if (call.name === "update_workflow_node_config") {
        const args = (call.args as Record<string, unknown>) || {};
        const result = await updateWorkflowNodeConfig(
          args.workflowId as string,
          args.nodeId as string,
          args.configUpdates as Record<string, unknown>,
          {
            orgId,
            userId,
            runId: runId!,
            trackingHeaders: Object.keys(trackingHeaders).length > 0 ? trackingHeaders as Record<string, string> : undefined,
          },
        );

        toolCalls.push({ name: call.name, args, result });
        return { name: call.name, result };
      }

      // Built-in content-generation tools
      if (call.name === "get_prompt_template") {
        const args = (call.args as Record<string, unknown>) || {};
        const result = await getPromptTemplate(
          args.type as string,
          {
            orgId,
            userId,
            runId: runId!,
            trackingHeaders: Object.keys(trackingHeaders).length > 0 ? trackingHeaders as Record<string, string> : undefined,
          },
        );

        toolCalls.push({ name: call.name, args, result });
        return { name: call.name, result };
      }

      // Built-in prompt update tool
      if (call.name === "update_prompt_template") {
        const args = (call.args as Record<string, unknown>) || {};
        const result = await updatePromptTemplate(
          {
            sourceType: args.sourceType as string,
            prompt: args.prompt as string,
            variables: args.variables as string[],
          },
          {
            orgId,
            userId,
            runId: runId!,
            trackingHeaders: Object.keys(trackingHeaders).length > 0 ? trackingHeaders as Record<string, string> : undefined,
          },
        );

        toolCalls.push({ name: call.name, args, result });
        return { name: call.name, result };
      }

      // Built-in api-registry tool
      if (call.name === "list_available_services") {
        const result = await listAvailableServices({
          orgId,
          userId,
          runId: runId!,
        });

        toolCalls.push({ name: call.name, args: {}, result });
        return { name: call.name, result };
      }

      return null;
    }

    /**
     * Process a Gemini stream, handling tokens, thinking events, and tool calls.
     * When a tool call is encountered, executes it, appends both the call and result
     * to turnParts, sends a continuation to Gemini, and recursively processes the
     * continuation stream. This ensures chained tool calls work correctly and each
     * continuation sees the full history of prior calls in the same turn.
     */
    async function processStream(
      stream: AsyncGenerator<import("./lib/gemini.js").GeminiEvent>,
      depth = 0,
    ): Promise<void> {
      const MAX_TOOL_CHAIN_DEPTH = 10;

      for await (const event of stream) {
        if (event.type === "token") {
          bufferToken(event.content);
        }

        if (event.type === "thinking_start" || event.type === "thinking_delta" || event.type === "thinking_stop") {
          sendSSE(res, event);
        }

        if (event.type === "done") {
          accumulateUsage(event.usage);
        }

        if (event.type === "function_call") {
          const { call } = event;

          const toolCallId = `tc_${crypto.randomUUID()}`;
          if (call.name !== "request_user_input") {
            sendSSE(res, {
              type: "tool_call",
              id: toolCallId,
              name: call.name,
              args: call.args,
            });
          }

          try {
            const toolResult = await executeTool(call);

            if (toolResult === "input_request") {
              return; // Stop processing — client needs input
            }

            if (toolResult === null) {
              continue; // Unhandled tool, skip
            }

            sendSSE(res, { type: "tool_result", id: toolCallId, name: call.name, result: toolResult.result });

            if (depth >= MAX_TOOL_CHAIN_DEPTH) {
              console.warn(`Tool chain depth limit reached (${MAX_TOOL_CHAIN_DEPTH}), stopping`);
              continue;
            }

            // Build the functionCall part with thoughtSignature for Gemini history
            const functionCallPart: Record<string, unknown> = {
              functionCall: { name: call.name, args: call.args || {} },
            };
            if (call.thoughtSignature) {
              functionCallPart.thoughtSignature = call.thoughtSignature;
            }

            // Append the function call to turn history (sendFunctionResult adds the response)
            turnParts.push({
              role: "model",
              parts: [functionCallPart as Part],
            });

            // Send continuation with full incremental history
            const contStream = gemini.sendFunctionResult(
              [...geminiHistory, { role: "user", parts: [{ text: message.trim() }] }, ...turnParts],
              call.name,
              toolResult.result,
              allTools,
            );

            // Add the function response to turnParts AFTER creating the stream,
            // so future chained calls see the complete history
            turnParts.push({
              role: "user",
              parts: [
                {
                  functionResponse: {
                    name: call.name,
                    response: { result: toolResult.result },
                  },
                } as Part,
              ],
            });

            // Recursively process continuation (may contain more tool calls)
            await processStream(contStream, depth + 1);
            return; // Continuation handled the rest of the turn
          } catch (toolErr: unknown) {
            const rawMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
            console.error(`Tool call ${call.name} failed:`, rawMsg);
            const friendly = formatToolError(call.name, rawMsg);
            sendSSE(res, { type: "tool_result", id: toolCallId, name: call.name, result: friendly });

            // Feed the error back to Gemini so it can self-correct
            if (depth < MAX_TOOL_CHAIN_DEPTH) {
              const functionCallPart: Record<string, unknown> = {
                functionCall: { name: call.name, args: call.args || {} },
              };
              if (call.thoughtSignature) {
                functionCallPart.thoughtSignature = call.thoughtSignature;
              }

              turnParts.push({
                role: "model",
                parts: [functionCallPart as Part],
              });

              const contStream = gemini.sendFunctionResult(
                [...geminiHistory, { role: "user", parts: [{ text: message.trim() }] }, ...turnParts],
                call.name,
                friendly,
                allTools,
              );

              turnParts.push({
                role: "user",
                parts: [
                  {
                    functionResponse: {
                      name: call.name,
                      response: { result: friendly },
                    },
                  } as Part,
                ],
              });

              await processStream(contStream, depth + 1);
              return;
            }
          }
        }
      }
    }

    console.log(`[chat] session="${currentSessionId}" streaming — model="${gemini.model}" tools=${allTools.length} history=${geminiHistory.length}`);
    const stream = gemini.streamChat(
      geminiHistory,
      message.trim(),
      allTools,
    );

    await processStream(stream);
    console.log(`[chat] session="${currentSessionId}" stream complete — tokens=${totalPromptTokens}+${totalOutputTokens} response=${fullResponse.length}chars`);

    // Finalize buffer: handle any remaining incomplete line
    if (lineBuf) {
      if (BUTTON_RE.test(lineBuf.trim())) {
        held += lineBuf;
      } else {
        if (held) {
          sendSSE(res, { type: "token", content: held });
          held = "";
        }
        sendSSE(res, { type: "token", content: lineBuf });
      }
      lineBuf = "";
    }

    // Process held content as buttons
    const buttons: ButtonRecord[] = held ? extractButtons(held) : [];
    if (held && buttons.length === 0) {
      sendSSE(res, { type: "token", content: held });
    }
    if (buttons.length > 0) {
      sendSSE(res, { type: "buttons", buttons });
    }

    // Detect empty stream: Gemini returned no content (safety filter, context overflow, etc.)
    if (!fullResponse && !emittedInputRequest && toolCalls.length === 0) {
      chatFailed = true;
      console.error(
        `Empty Gemini response for session="${currentSessionId}" org="${orgId}" — ` +
          `promptTokens=${totalPromptTokens} outputTokens=${totalOutputTokens} ` +
          `historyLength=${geminiHistory.length} messageLength=${message.length}`,
      );
      sendSSE(res, {
        type: "error",
        message:
          "The AI model returned an empty response. This may happen when the conversation " +
          "is too long or the message content triggers a safety filter. Please try shortening " +
          "your message or starting a new conversation.",
      });
      sendSSE(res, "[DONE]");
      return;
    }

    // Save assistant message with cleaned response
    const cleanedResponse =
      buttons.length > 0 ? stripButtons(fullResponse) : fullResponse;
    await db.insert(messages).values({
      sessionId: currentSessionId,
      role: "assistant",
      content: cleanedResponse,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      buttons: buttons.length > 0 ? buttons : null,
      tokenCount: totalPromptTokens + totalOutputTokens || null,
      runId,
      campaignId: workflowTracking.campaignId ?? null,
      brandId: workflowTracking.brandId ?? null,
      workflowName: workflowTracking.workflowName ?? null,
    });

    sendSSE(res, "[DONE]");
  } catch (err) {
    chatFailed = true;
    console.error(`[chat] org="${orgId}" unhandled error:`, err);
    sendSSE(res, {
      type: "error",
      message: "An unexpected error occurred. Please try again.",
    });
    sendSSE(res, "[DONE]");
  } finally {
    // Report run status and costs (fire-and-forget)
    if (runId) {
      const costModel = gemini.model.replace(/-preview$/, "");
      const costSource: "platform" | "org" =
        resolvedKey.keySource === "org" ? "org" : "platform";
      const costItems = [
        ...(totalPromptTokens > 0
          ? [
              {
                costName: `${costModel}-tokens-input`,
                quantity: totalPromptTokens,
                costSource,
              },
            ]
          : []),
        ...(totalOutputTokens > 0
          ? [
              {
                costName: `${costModel}-tokens-output`,
                quantity: totalOutputTokens,
                costSource,
              },
            ]
          : []),
        ...(totalSearchQueries > 0
          ? [
              {
                costName: "gemini-google-search-query",
                quantity: totalSearchQueries,
                costSource,
              },
            ]
          : []),
      ];
      const runIdentity = { orgId, userId, runId };
      Promise.all([
        updateRunStatus(runId, chatFailed ? "failed" : "completed", runIdentity, trackingHeaders),
        addRunCosts(runId, costItems, runIdentity, trackingHeaders),
      ]).catch(() => {});
    }

    res.end();
  }
});

/**
 * Extract button suggestions from the AI response.
 * Looks for lines like "- [Button Label]" at the end of the response.
 */
function extractButtons(text: string): ButtonRecord[] {
  const lines = text.trim().split("\n");
  const buttons: ButtonRecord[] = [];

  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/^[-*]\s*\[(.+?)\]\s*$/);
    if (match) {
      buttons.unshift({ label: match[1], value: match[1] });
    } else if (buttons.length > 0) {
      break;
    }
  }

  return buttons;
}

function stripButtons(text: string): string {
  const lines = text.split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  const beforeButtons = end;
  while (end > 0 && /^[-*]\s*\[.+?\]\s*$/.test(lines[end - 1])) end--;
  if (end === beforeButtons) return text;
  while (end > 0 && lines[end - 1].trim() === "") end--;
  return lines.slice(0, end).join("\n");
}

// Only start server if not in test environment
if (process.env.NODE_ENV !== "test") {
  migrate(db, { migrationsFolder: "./drizzle" })
    .then(() => {
      console.log("Migrations complete");
      app.listen(Number(PORT), "::", () => {
        console.log(`Service running on port ${PORT}`);
      });
    })
    .catch((err) => {
      console.error("Startup failed:", err);
      process.exit(1);
    });
}

export default app;
