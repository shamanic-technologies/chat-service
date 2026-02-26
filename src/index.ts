import express from "express";
import cors from "cors";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { db } from "./db/index.js";
import { sessions, messages, appConfigs } from "./db/schema.js";
import { eq, and } from "drizzle-orm";
import {
  createGeminiClient,
  buildSystemPrompt,
  REQUEST_USER_INPUT_TOOL,
  type UsageMetadata,
} from "./lib/gemini.js";
import { connectMcp, type McpConnection } from "./lib/mcp-client.js";
import { createRun, updateRunStatus, addRunCosts } from "./lib/runs-client.js";
import { decryptAppKey, decryptOrgKey } from "./lib/key-client.js";
import { ChatRequestSchema, AppConfigRequestSchema } from "./schemas.js";
import { requireAuth, type AuthLocals } from "./middleware/auth.js";
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

let geminiApiKey: string;

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

app.put("/apps/:appId/config", requireAuth, async (req, res) => {
  const { appId } = req.params;
  const { orgId } = res.locals as AuthLocals;

  const parsed = AppConfigRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  const { systemPrompt, mcpServerUrl, mcpKeyName } = parsed.data;

  const [config] = await db
    .insert(appConfigs)
    .values({
      appId,
      orgId,
      systemPrompt,
      mcpServerUrl: mcpServerUrl ?? null,
      mcpKeyName: mcpKeyName ?? null,
    })
    .onConflictDoUpdate({
      target: [appConfigs.appId, appConfigs.orgId],
      set: {
        systemPrompt,
        mcpServerUrl: mcpServerUrl ?? null,
        mcpKeyName: mcpKeyName ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  res.json({
    appId: config.appId,
    orgId: config.orgId,
    systemPrompt: config.systemPrompt,
    mcpServerUrl: config.mcpServerUrl,
    mcpKeyName: config.mcpKeyName,
    createdAt: config.createdAt.toISOString(),
    updatedAt: config.updatedAt.toISOString(),
  });
});

// --- Chat ---

app.post("/chat", requireAuth, async (req, res) => {
  const { orgId, userId } = res.locals as AuthLocals;

  const parsed = ChatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  const { message, sessionId, appId, context } = parsed.data;

  // Look up app config
  const [appConfig] = await db
    .select()
    .from(appConfigs)
    .where(and(eq(appConfigs.appId, appId), eq(appConfigs.orgId, orgId)));

  if (!appConfig) {
    return res.status(404).json({
      error: `App config not found for appId="${appId}". Register via PUT /apps/${appId}/config first.`,
    });
  }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Build system prompt with optional context
  const systemPrompt = buildSystemPrompt(appConfig.systemPrompt, context);
  const gemini = createGeminiClient({ apiKey: geminiApiKey, systemPrompt });

  let mcpConn: McpConnection | null = null;
  let runId: string | undefined;
  let chatFailed = false;
  let totalPromptTokens = 0;
  let totalOutputTokens = 0;

  try {
    // Get or create session (scoped by org + user + app)
    let currentSessionId = sessionId;
    if (!currentSessionId) {
      const [session] = await db
        .insert(sessions)
        .values({ orgId, userId, appId })
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

    // Register run in RunsService
    const run = await createRun({
      orgId,
      userId,
      appId,
      serviceName: "chat-service",
      taskName: "chat",
    });
    if (run) runId = run.id;

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

    // Connect to MCP if app config has MCP settings
    if (appConfig.mcpServerUrl && appConfig.mcpKeyName) {
      try {
        const decrypted = await decryptOrgKey(
          appConfig.mcpKeyName,
          orgId,
          { method: "POST", path: "/chat" },
        );
        mcpConn = await connectMcp({
          serverUrl: appConfig.mcpServerUrl,
          bearerToken: decrypted.key,
        });
      } catch (err) {
        console.warn("MCP connection failed, proceeding without tools:", err);
      }
    }

    // Save user message
    await db.insert(messages).values({
      sessionId: currentSessionId,
      role: "user",
      content: message.trim(),
    });

    // Stream response from Gemini
    let fullResponse = "";
    const toolCalls: ToolCallRecord[] = [];

    // Line buffer: hold back trailing lines that match button syntax
    // so they aren't streamed as tokens (only sent as buttons event)
    const BUTTON_RE = /^[-*]\s*\[.+?\]\s*$/;
    let lineBuf = "";
    let held = "";

    function bufferToken(chunk: string): void {
      fullResponse += chunk;
      for (const ch of chunk) {
        lineBuf += ch;
        if (ch === "\n") {
          if (BUTTON_RE.test(lineBuf.trimEnd())) {
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
      }
    }

    // Merge MCP tools with local client-side tools
    const allTools = [
      ...(mcpConn?.tools ?? []),
      REQUEST_USER_INPUT_TOOL,
    ];

    const stream = gemini.streamChat(
      geminiHistory,
      message.trim(),
      allTools,
    );

    function accumulateUsage(usage?: UsageMetadata) {
      if (!usage) return;
      totalPromptTokens += usage.promptTokens;
      totalOutputTokens += usage.outputTokens;
    }

    for await (const event of stream) {
      if (event.type === "token") {
        bufferToken(event.content);
      }

      if (event.type === "done") {
        accumulateUsage(event.usage);
      }

      if (event.type === "function_call") {
        const { call } = event;

        // Client-side tool: emit input_request and end stream
        if (call.name === "request_user_input") {
          const args = (call.args as Record<string, unknown>) || {};
          sendSSE(res, {
            type: "input_request",
            input_type: args.input_type ?? "text",
            label: args.label ?? "Please provide input",
            ...(args.placeholder ? { placeholder: args.placeholder } : {}),
            field: args.field ?? "input",
          });
          break;
        }

        if (!mcpConn) continue;

        sendSSE(res, {
          type: "tool_call",
          name: call.name,
          args: call.args,
        });

        try {
          const result = await mcpConn.callTool(
            call.name,
            (call.args as Record<string, unknown>) || {},
          );
          toolCalls.push({
            name: call.name,
            args: (call.args as Record<string, unknown>) || {},
            result,
          });

          sendSSE(res, { type: "tool_result", name: call.name, result });

          // Send function result back to Gemini and stream continuation
          // Gemini 3 with thinking requires thoughtSignature on functionCall parts
          const functionCallPart: Record<string, unknown> = {
            functionCall: { name: call.name, args: call.args || {} },
          };
          if (call.thoughtSignature) {
            functionCallPart.thoughtSignature = call.thoughtSignature;
          }
          const updatedHistory: Content[] = [
            ...geminiHistory,
            { role: "user", parts: [{ text: message.trim() }] },
            {
              role: "model",
              parts: [functionCallPart as Part],
            },
          ];

          const contStream = gemini.sendFunctionResult(
            updatedHistory,
            call.name,
            result,
            allTools,
          );

          for await (const contEvent of contStream) {
            if (contEvent.type === "token") {
              bufferToken(contEvent.content);
            }
            if (contEvent.type === "done") {
              accumulateUsage(contEvent.usage);
            }
          }
        } catch (toolErr: unknown) {
          const errDetail =
            toolErr instanceof Error
              ? {
                  message: toolErr.message,
                  ...Object.fromEntries(
                    Object.entries(
                      toolErr as unknown as Record<string, unknown>,
                    ),
                  ),
                }
              : toolErr;
          console.error(
            `Tool call ${call.name} failed:`,
            JSON.stringify(errDetail, null, 2),
          );
          const errorMsg =
            " (Tool call failed, continuing without result.)";
          fullResponse += errorMsg;
          sendSSE(res, { type: "token", content: errorMsg });
        }
      }
    }

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
      runId: runId ?? null,
    });

    sendSSE(res, "[DONE]");
  } catch (err) {
    chatFailed = true;
    console.error("Chat error:", err);
    sendSSE(res, {
      type: "token",
      content: "\n\nSorry, something went wrong. Please try again.",
    });
    sendSSE(res, "[DONE]");
  } finally {
    if (mcpConn) {
      mcpConn.close().catch(() => {});
    }

    // Report run status and costs (fire-and-forget)
    if (runId) {
      const costModel = gemini.model.replace(/-preview$/, "");
      const costItems = [
        ...(totalPromptTokens > 0
          ? [
              {
                costName: `${costModel}-tokens-input`,
                quantity: totalPromptTokens,
              },
            ]
          : []),
        ...(totalOutputTokens > 0
          ? [
              {
                costName: `${costModel}-tokens-output`,
                quantity: totalOutputTokens,
              },
            ]
          : []),
      ];
      Promise.all([
        updateRunStatus(runId, chatFailed ? "failed" : "completed"),
        addRunCosts(runId, costItems),
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
    .then(async () => {
      console.log("Migrations complete");
      const decrypted = await decryptAppKey("gemini", {
        method: "POST",
        path: "/chat",
      });
      geminiApiKey = decrypted.key;
      console.log("Gemini API key resolved via key-service");
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
