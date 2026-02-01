import express from "express";
import cors from "cors";
import { db } from "./db/index.js";
import { sessions, messages } from "./db/schema.js";
import { eq } from "drizzle-orm";
import { createGeminiClient } from "./lib/gemini.js";
import { connectMcp, type McpConnection } from "./lib/mcp-client.js";
import type { ChatRequest } from "./types.js";
import type { Content } from "@google/generative-ai";
import type { ButtonRecord, ToolCallRecord } from "./db/schema.js";

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

    const stream = gemini.streamChat(
      geminiHistory,
      message.trim(),
      mcpConn?.tools
    );

    for await (const event of stream) {
      if (event.type === "token") {
        fullResponse += event.content;
        sendSSE(res, { type: "token", content: event.content });
      }

      if (event.type === "function_call" && mcpConn) {
        const { call } = event;
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

          const contResult = await gemini.sendFunctionResult(
            updatedHistory,
            call.name,
            result,
            mcpConn.tools
          );

          for await (const chunk of contResult.stream) {
            const candidate = chunk.candidates?.[0];
            if (!candidate) continue;
            for (const part of candidate.content.parts) {
              if (part.text) {
                fullResponse += part.text;
                sendSSE(res, { type: "token", content: part.text });
              }
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

    // Detect button suggestions in response
    const buttons = extractButtons(fullResponse);
    if (buttons.length > 0) {
      sendSSE(res, { type: "buttons", buttons });
    }

    // Save assistant message
    await db.insert(messages).values({
      sessionId: currentSessionId,
      role: "assistant",
      content: fullResponse,
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

app.listen(PORT, () => {
  console.log(`chat-service listening on port ${PORT}`);
});

export { app };
