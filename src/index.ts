import express from "express";
import cors from "cors";
import { db } from "./db/index.js";
import { sessions, messages } from "./db/schema.js";
import { eq } from "drizzle-orm";
import { createGeminiClient, REQUEST_USER_INPUT_TOOL } from "./lib/gemini.js";
import { connectMcp, type McpConnection } from "./lib/mcp-client.js";
import type { ChatRequest } from "./types.js";
import type { Content } from "@google/genai";
import type { ButtonRecord, ToolCallRecord } from "./db/schema.js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = parseInt(process.env.PORT || "3002", 10);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is required");
}

function sendSSE(res: express.Response, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/chat", async (req, res) => {
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (!apiKey) {
    return res.status(401).json({ error: "X-API-Key header required" });
  }

  const { message, sessionId } = req.body as ChatRequest;
  if (!message?.trim()) {
    return res.status(400).json({ error: "message is required" });
  }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let mcpConn: McpConnection | null = null;

  try {
    // Get or create session
    let currentSessionId = sessionId;
    if (!currentSessionId) {
      const [session] = await db
        .insert(sessions)
        .values({ orgId: apiKey })
        .returning();
      currentSessionId = session.id;
    }

    sendSSE(res, { sessionId: currentSessionId });

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

    // Connect to MCP to get available tools
    try {
      mcpConn = await connectMcp(apiKey);
    } catch (err) {
      console.warn("MCP connection failed, proceeding without tools:", err);
    }

    // Save user message
    await db.insert(messages).values({
      sessionId: currentSessionId,
      role: "user",
      content: message.trim(),
    });

    // Stream response from Gemini
    const gemini = createGeminiClient({ apiKey: GEMINI_API_KEY });
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
      allTools
    );

    for await (const event of stream) {
      if (event.type === "token") {
        bufferToken(event.content);
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
            (call.args as Record<string, unknown>) || {}
          );
          toolCalls.push({
            name: call.name,
            args: (call.args as Record<string, unknown>) || {},
            result,
          });

          sendSSE(res, { type: "tool_result", name: call.name, result });

          // Send function result back to Gemini and stream continuation
          const updatedHistory: Content[] = [
            ...geminiHistory,
            { role: "user", parts: [{ text: message.trim() }] },
            {
              role: "model",
              parts: [{ functionCall: { name: call.name, args: call.args || {} } }],
            },
          ];

          const contStream = gemini.sendFunctionResult(
            updatedHistory,
            call.name,
            result,
            allTools
          );

          for await (const contEvent of contStream) {
            if (contEvent.type === "token") {
              bufferToken(contEvent.content);
            }
          }
        } catch (toolErr) {
          console.error(`Tool call ${call.name} failed:`, toolErr);
          const errorMsg = " (Tool call failed, continuing without result.)";
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
    const buttons: ButtonRecord[] = held
      ? extractButtons(held)
      : [];
    if (held && buttons.length === 0) {
      sendSSE(res, { type: "token", content: held });
    }
    if (buttons.length > 0) {
      sendSSE(res, { type: "buttons", buttons });
    }

    // Save assistant message with cleaned response
    const cleanedResponse = buttons.length > 0
      ? stripButtons(fullResponse)
      : fullResponse;
    await db.insert(messages).values({
      sessionId: currentSessionId,
      role: "assistant",
      content: cleanedResponse,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      buttons: buttons.length > 0 ? buttons : null,
    });

    sendSSE(res, "[DONE]");
  } catch (err) {
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
    res.end();
  }
});

/**
 * Extract button suggestions from Foxy's response.
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
      console.error("Migration failed:", err);
      process.exit(1);
    });
}

export default app;
