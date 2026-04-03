import express from "express";
import cors from "cors";
import crypto from "crypto";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { db } from "./db/index.js";
import { sessions, messages, appConfigs, platformConfigs } from "./db/schema.js";
import { eq, and } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import {
  createAnthropicClient,
  buildSystemPrompt,
  resolveToolSet,
  AVAILABLE_TOOL_NAMES,
  MODEL,
  COST_PREFIX,
  costPrefixForModel,
  resolveModel,
} from "./lib/anthropic.js";
import type { Provider, ModelAlias } from "./lib/anthropic.js";
import { isGeminiModel, completeWithGemini } from "./lib/gemini.js";
import {
  updateWorkflow,
  validateWorkflow,
  updateWorkflowNodeConfig,
  getWorkflow,
  getWorkflowRequiredProviders,
  listWorkflows,
} from "./lib/workflow-client.js";
import { getPromptTemplate, updatePromptTemplate } from "./lib/content-generation-client.js";
import { listServices, listServiceEndpoints } from "./lib/api-registry-client.js";
import { createRun, updateRunStatus, addRunCosts } from "./lib/runs-client.js";
import { createFeature, updateFeature, listFeatures, getFeature, getFeatureInputs, prefillFeature, getFeatureStats } from "./lib/features-client.js";
import { extractBrandFields, extractBrandText } from "./lib/brand-client.js";
import { formatToolError } from "./lib/tool-errors.js";
import {
  resolveKey,
  resolvePlatformKey,
  type ResolvedKey,
  listOrgKeys,
  getKeySource,
  listKeySources,
  checkProviderRequirements,
} from "./lib/key-client.js";
import { authorizeCredits, BillingError } from "./lib/billing-client.js";
import { getCampaignFeatureInputs } from "./lib/campaign-client.js";
import { ChatRequestSchema, CompleteRequestSchema, InternalPlatformCompleteRequestSchema, AppConfigRequestSchema, PlatformConfigRequestSchema } from "./schemas.js";
import { requireAuth, requireInternalAuth, type AuthLocals } from "./middleware/auth.js";
import type { ButtonRecord, ToolCallRecord } from "./db/schema.js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const openapiPath = join(__dirname, "..", "openapi.json");

import { mergeConsecutiveMessages, stripToolUseBlocks } from "./lib/merge-messages.js";

// ---------------------------------------------------------------------------
// JSON parsing for LLM responses
// ---------------------------------------------------------------------------

/** Remove trailing commas before ] and } — a common LLM output quirk. */
function removeTrailingCommas(s: string): string {
  return s.replace(/,\s*([\]}])/g, "$1");
}

/**
 * Parse JSON from model output with progressive repair:
 * 1. Try raw JSON.parse
 * 2. Strip markdown code fences and retry
 * 3. Remove trailing commas and retry
 * Throws with diagnostics if all attempts fail.
 */
function parseModelJson(raw: string): unknown {
  const trimmed = raw.trim();

  // Attempt 1: direct parse
  try {
    return JSON.parse(trimmed);
  } catch { /* continue */ }

  // Attempt 2: strip markdown fences
  const stripped = trimmed
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch { /* continue */ }

  // Attempt 3: remove trailing commas (LLMs often produce these)
  const repaired = removeTrailingCommas(stripped);
  try {
    const parsed = JSON.parse(repaired);
    console.warn(`[chat-service] JSON required trailing-comma repair (contentLen=${raw.length})`);
    return parsed;
  } catch { /* continue */ }

  throw new Error(
    `Model returned non-parsable JSON despite responseFormat: "json". ` +
    `contentLen=${raw.length}, ` +
    `first500=${raw.slice(0, 500)}, ` +
    `last200=${raw.slice(-200)}`
  );
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

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

  const { key, systemPrompt, allowedTools } = parsed.data;

  // Validate all tool names
  const unknownTools = allowedTools.filter((t) => !AVAILABLE_TOOL_NAMES.includes(t));
  if (unknownTools.length > 0) {
    return res.status(400).json({
      error: `Unknown tools: ${unknownTools.join(", ")}. Available: ${AVAILABLE_TOOL_NAMES.join(", ")}`,
    });
  }

  const [config] = await db
    .insert(appConfigs)
    .values({
      orgId,
      key,
      systemPrompt,
      allowedTools,
    })
    .onConflictDoUpdate({
      target: [appConfigs.orgId, appConfigs.key],
      set: {
        systemPrompt,
        allowedTools,
        updatedAt: new Date(),
      },
    })
    .returning();

  res.json({
    orgId: config.orgId,
    key: config.key,
    systemPrompt: config.systemPrompt,
    allowedTools: config.allowedTools,
    createdAt: config.createdAt.toISOString(),
    updatedAt: config.updatedAt.toISOString(),
  });
});

// --- Platform Config Registration ---

app.put("/platform-config", requireInternalAuth, async (req, res) => {
  const parsed = PlatformConfigRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  const { key, systemPrompt, allowedTools } = parsed.data;

  // Validate all tool names
  const unknownTools = allowedTools.filter((t) => !AVAILABLE_TOOL_NAMES.includes(t));
  if (unknownTools.length > 0) {
    return res.status(400).json({
      error: `Unknown tools: ${unknownTools.join(", ")}. Available: ${AVAILABLE_TOOL_NAMES.join(", ")}`,
    });
  }

  const [config] = await db
    .insert(platformConfigs)
    .values({
      key,
      systemPrompt,
      allowedTools,
    })
    .onConflictDoUpdate({
      target: [platformConfigs.key],
      set: {
        systemPrompt,
        allowedTools,
        updatedAt: new Date(),
      },
    })
    .returning();

  res.json({
    key: config.key,
    systemPrompt: config.systemPrompt,
    allowedTools: config.allowedTools,
    createdAt: config.createdAt.toISOString(),
    updatedAt: config.updatedAt.toISOString(),
  });
});

// --- Complete (synchronous LLM call) ---

app.post("/complete", requireAuth, async (req, res) => {
  const { orgId, userId, runId: callerRunId, workflowTracking } = res.locals as AuthLocals;

  const trackingHeaders: Record<string, string> = {};
  if (workflowTracking.campaignId) trackingHeaders["x-campaign-id"] = workflowTracking.campaignId;
  if (workflowTracking.brandId) trackingHeaders["x-brand-id"] = workflowTracking.brandId;
  if (workflowTracking.workflowSlug) trackingHeaders["x-workflow-slug"] = workflowTracking.workflowSlug;
  if (workflowTracking.featureSlug) trackingHeaders["x-feature-slug"] = workflowTracking.featureSlug;

  const parsed = CompleteRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  const { message, systemPrompt, responseFormat, temperature, provider: requestedProvider, model: requestedModel, imageUrl, imageContext } = parsed.data;

  // Resolve versioned model from (provider, alias) pair
  const resolved = resolveModel(requestedProvider as Provider, requestedModel as ModelAlias);
  const effectiveModel = resolved.apiModelId;
  const isGemini = resolved.provider === "google";
  const provider = resolved.provider;

  // Resolve API key per-request
  let resolvedKey: ResolvedKey;
  try {
    resolvedKey = await resolveKey({
      provider,
      orgId,
      userId,
      runId: callerRunId,
      caller: { method: "POST", path: "/complete" },
      trackingHeaders,
    });
  } catch (err) {
    console.error(`[complete] Failed to resolve ${provider} key for org="${orgId}":`, err);
    return res.status(502).json({
      error: `Failed to resolve ${provider} API key. Ensure the key is configured in key-service.`,
    });
  }

  // Cost prefix from model resolution
  const effectiveCostPrefix = resolved.costPrefix;

  // Credit authorization for platform keys
  if (resolvedKey.keySource === "platform") {
    const estimatedInputTokens = Math.max(Math.ceil(message.length / 4), 500);
    const estimatedOutputTokens = 64_000;
    try {
      const authResult = await authorizeCredits({
        items: [
          { costName: `${effectiveCostPrefix}-tokens-input`, quantity: estimatedInputTokens },
          { costName: `${effectiveCostPrefix}-tokens-output`, quantity: estimatedOutputTokens },
        ],
        description: `complete — ${effectiveModel}`,
        orgId,
        userId,
        runId: callerRunId,
        trackingHeaders: Object.keys(trackingHeaders).length > 0 ? trackingHeaders : undefined,
      });
      if (!authResult.sufficient) {
        console.warn(
          `[complete] insufficient credits: org="${orgId}" balance_cents=${authResult.balance_cents} required_cents=${authResult.required_cents}`,
        );
        return res.status(402).json({
          error: "Insufficient credits",
          balance_cents: authResult.balance_cents,
          required_cents: authResult.required_cents,
        });
      }
    } catch (billingErr) {
      console.error(`[complete] billing authorization failed for org="${orgId}":`, billingErr);
      if (billingErr instanceof BillingError && billingErr.isClientError) {
        return res.status(billingErr.statusCode).json({
          error: `Billing authorization rejected: ${billingErr.upstreamBody}`,
        });
      }
      return res.status(502).json({
        error: "Billing service unavailable. Please try again.",
      });
    }
  }

  // Register run (mandatory)
  let runId: string | null = null;
  try {
    const run = await createRun(
      { serviceName: "chat-service", taskName: "complete" },
      { orgId, userId, runId: callerRunId },
      trackingHeaders,
    );
    runId = run.id;
  } catch (runErr) {
    console.error(`[complete] org="${orgId}" run creation failed:`, runErr);
    return res.status(502).json({
      error: "Service temporarily unavailable (run tracking). Please try again.",
    });
  }

  // Fetch campaign context if campaignId is present (Convention 2)
  let campaignFeatureInputs: Record<string, unknown> | null = null;
  if (workflowTracking.campaignId) {
    try {
      campaignFeatureInputs = await getCampaignFeatureInputs(
        workflowTracking.campaignId,
        { orgId, userId, runId: callerRunId, trackingHeaders },
      );
    } catch (err) {
      console.warn(`[complete] Failed to fetch campaign context for campaign="${workflowTracking.campaignId}":`, err);
    }
  }

  let completeFailed = false;
  let totalPromptTokens = 0;
  let totalOutputTokens = 0;
  try {
    // Build prompt — for JSON mode, prepend instruction to system prompt
    let effectiveSystemPrompt = systemPrompt;
    if (campaignFeatureInputs && Object.keys(campaignFeatureInputs).length > 0) {
      effectiveSystemPrompt = buildSystemPrompt(systemPrompt, undefined, campaignFeatureInputs);
    }
    if (responseFormat === "json") {
      effectiveSystemPrompt += `\n\nIMPORTANT: You MUST respond with valid JSON only. No markdown, no code fences, no extra text — just a single JSON object or array.`;
    }

    let result: { content: string; tokensInput: number; tokensOutput: number; model: string };

    if (isGemini) {
      result = await completeWithGemini({
        apiKey: resolvedKey.key,
        model: effectiveModel,
        message,
        systemPrompt: effectiveSystemPrompt,
        imageUrl,
        imageContext,
        responseFormat,
        temperature,
      });
    } else {
      const claude = createAnthropicClient({ apiKey: resolvedKey.key, systemPrompt: effectiveSystemPrompt });
      result = await claude.complete(message, {
        responseFormat,
        temperature,
        model: effectiveModel,
        imageUrl,
      });
    }

    totalPromptTokens = result.tokensInput;
    totalOutputTokens = result.tokensOutput;

    // Build response
    const response: Record<string, unknown> = {
      content: result.content,
      tokensInput: result.tokensInput,
      tokensOutput: result.tokensOutput,
      model: result.model,
    };

    // Parse JSON if requested
    if (responseFormat === "json") {
      response.json = parseModelJson(result.content);
    }

    res.json(response);
  } catch (err) {
    completeFailed = true;
    console.error(`[complete] org="${orgId}" error:`, err);
    res.status(502).json({
      error: "LLM call failed. Please try again.",
    });
  } finally {
    // Report run status and costs (fire-and-forget)
    if (runId) {
      const costSource: "platform" | "org" =
        resolvedKey.keySource === "org" ? "org" : "platform";
      const costItems = [
        ...(totalPromptTokens > 0
          ? [{ costName: `${effectiveCostPrefix}-tokens-input`, quantity: totalPromptTokens, costSource }]
          : []),
        ...(totalOutputTokens > 0
          ? [{ costName: `${effectiveCostPrefix}-tokens-output`, quantity: totalOutputTokens, costSource }]
          : []),
      ];
      const runIdentity = { orgId, userId, runId };
      Promise.all([
        updateRunStatus(runId, completeFailed ? "failed" : "completed", runIdentity, trackingHeaders),
        addRunCosts(runId, costItems, runIdentity, trackingHeaders),
      ]).catch(() => {});
    }
  }
});

// --- Internal Platform Complete (no billing, no run tracking) ---

app.post("/internal/platform-complete", requireInternalAuth, async (req, res) => {
  const parsed = InternalPlatformCompleteRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  const { message, systemPrompt, responseFormat, temperature, provider: requestedProvider, model: requestedModel } = parsed.data;

  const resolved = resolveModel(requestedProvider as Provider, requestedModel as ModelAlias);
  const effectiveModel = resolved.apiModelId;
  const isGemini = resolved.provider === "google";
  const provider = resolved.provider;

  let apiKey: string;
  try {
    const platformKey = await resolvePlatformKey(provider, {
      method: "POST",
      path: "/internal/platform-complete",
    });
    apiKey = platformKey.key;
  } catch (err) {
    console.error(`[internal/platform-complete] Failed to resolve platform ${provider} key:`, err);
    return res.status(502).json({
      error: `Failed to resolve platform ${provider} API key.`,
    });
  }

  try {
    let effectiveSystemPrompt = systemPrompt;
    if (responseFormat === "json") {
      effectiveSystemPrompt += `\n\nIMPORTANT: You MUST respond with valid JSON only. No markdown, no code fences, no extra text — just a single JSON object or array.`;
    }

    let result: { content: string; tokensInput: number; tokensOutput: number; model: string };

    if (isGemini) {
      result = await completeWithGemini({
        apiKey,
        model: effectiveModel,
        message,
        systemPrompt: effectiveSystemPrompt,
        responseFormat,
        temperature,
      });
    } else {
      const claude = createAnthropicClient({ apiKey, systemPrompt: effectiveSystemPrompt });
      result = await claude.complete(message, {
        responseFormat,
        temperature,
        model: effectiveModel,
      });
    }

    const response: Record<string, unknown> = {
      content: result.content,
      tokensInput: result.tokensInput,
      tokensOutput: result.tokensOutput,
      model: result.model,
    };

    if (responseFormat === "json") {
      response.json = parseModelJson(result.content);
    }

    res.json(response);
  } catch (err) {
    console.error(`[internal/platform-complete] LLM call failed:`, err);
    res.status(502).json({
      error: "LLM call failed. Please try again.",
    });
  }
});

// --- Chat ---

app.post("/chat", requireAuth, async (req, res) => {
  const { orgId, userId, runId: callerRunId, workflowTracking } = res.locals as AuthLocals;

  // Build tracking headers to forward to downstream services
  const trackingHeaders: Record<string, string> = {};
  if (workflowTracking.campaignId) trackingHeaders["x-campaign-id"] = workflowTracking.campaignId;
  if (workflowTracking.brandId) trackingHeaders["x-brand-id"] = workflowTracking.brandId;
  if (workflowTracking.workflowSlug) trackingHeaders["x-workflow-slug"] = workflowTracking.workflowSlug;
  if (workflowTracking.featureSlug) trackingHeaders["x-feature-slug"] = workflowTracking.featureSlug;

  const parsed = ChatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  const { configKey, message, sessionId, context } = parsed.data;

  // Look up app config by (orgId, configKey), fall back to platform config by configKey
  const [orgConfig] = await db
    .select()
    .from(appConfigs)
    .where(and(eq(appConfigs.orgId, orgId), eq(appConfigs.key, configKey)));

  const appConfig = orgConfig ?? (await db
    .select()
    .from(platformConfigs)
    .where(eq(platformConfigs.key, configKey))
    .then(([row]) => row ?? null));

  if (!appConfig) {
    return res.status(404).json({
      error: `No chat config found for key="${configKey}" (org="${orgId}"). Register via PUT /config or PUT /platform-config.`,
    });
  }

  const allowedToolNames: string[] = appConfig.allowedTools as string[];

  // Resolve Anthropic API key per-request (supports BYOK per org)
  let resolvedKey: ResolvedKey;
  try {
    resolvedKey = await resolveKey({
      provider: "anthropic",
      orgId,
      userId,
      runId: callerRunId,
      caller: { method: "POST", path: "/chat" },
      trackingHeaders,
    });
  } catch (err) {
    console.error(`Failed to resolve Anthropic key for org="${orgId}":`, err);
    return res.status(502).json({
      error: `Failed to resolve Anthropic API key. Ensure the key is configured in key-service.`,
    });
  }

  // Credit authorization — only for platform keys (BYOK orgs pay their provider directly)
  if (resolvedKey.keySource === "platform") {
    // Estimate token quantities: input from message length (~4 chars/token, min 500),
    // output from MAX_TOKENS budget (64 000)
    const estimatedInputTokens = Math.max(Math.ceil(message.length / 4), 500);
    const estimatedOutputTokens = 64_000;
    try {
      const authResult = await authorizeCredits({
        items: [
          { costName: `${COST_PREFIX}-tokens-input`, quantity: estimatedInputTokens },
          { costName: `${COST_PREFIX}-tokens-output`, quantity: estimatedOutputTokens },
        ],
        description: `chat — ${MODEL}`,
        orgId,
        userId,
        runId: callerRunId,
        trackingHeaders: Object.keys(trackingHeaders).length > 0 ? trackingHeaders : undefined,
      });
      if (!authResult.sufficient) {
        console.warn(
          `[chat] insufficient credits: org="${orgId}" balance_cents=${authResult.balance_cents} required_cents=${authResult.required_cents}`,
        );
        return res.status(402).json({
          error: "Insufficient credits",
          balance_cents: authResult.balance_cents,
          required_cents: authResult.required_cents,
        });
      }
    } catch (billingErr) {
      console.error(`[chat] billing authorization failed for org="${orgId}":`, billingErr);
      return res.status(502).json({
        error: "Billing service unavailable. Please try again.",
      });
    }
  }

  // Fetch campaign context if campaignId is present (Convention 2)
  let campaignFeatureInputs: Record<string, unknown> | null = null;
  if (workflowTracking.campaignId) {
    try {
      campaignFeatureInputs = await getCampaignFeatureInputs(
        workflowTracking.campaignId,
        { orgId, userId, runId: callerRunId, trackingHeaders },
      );
    } catch (err) {
      console.warn(`[chat] Failed to fetch campaign context for campaign="${workflowTracking.campaignId}":`, err);
    }
  }

  // SSE headers — disable proxy buffering so tokens stream immediately
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Build system prompt with optional context and campaign feature inputs
  const systemPrompt = buildSystemPrompt(appConfig.systemPrompt, context, campaignFeatureInputs);
  const claude = createAnthropicClient({ apiKey: resolvedKey.key, systemPrompt });

  let runId: string | null = null;
  let chatFailed = false;
  let totalPromptTokens = 0;
  let totalOutputTokens = 0;

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

    // Build Anthropic message history — use contentBlocks if available (preserves compaction blocks)
    // Strip tool_use blocks: intermediate tool calls are ephemeral and not persisted with
    // matching tool_result messages, so including them causes Anthropic API validation errors.
    // Ensure alternating user/assistant roles (merge consecutive same-role messages)
    const rawHistory: Anthropic.MessageParam[] = history
      .filter((m) => m.role !== "tool")
      .map((m) => {
        if (m.role === "assistant" && m.contentBlocks) {
          const blocks = stripToolUseBlocks(
            m.contentBlocks as Anthropic.ContentBlockParam[],
          );
          return {
            role: "assistant" as const,
            content: blocks.length > 0 ? blocks : (m.content as string),
          };
        }
        return {
          role: m.role as "user" | "assistant",
          content: m.content as string | Anthropic.ContentBlockParam[],
        };
      });

    const anthropicHistory = mergeConsecutiveMessages(rawHistory);

    // Save user message
    await db.insert(messages).values({
      sessionId: currentSessionId,
      role: "user",
      content: message.trim(),
      campaignId: workflowTracking.campaignId ?? null,
      brandIds: workflowTracking.brandId ? workflowTracking.brandId.split(",").map(s => s.trim()).filter(Boolean) : null,
      workflowSlug: workflowTracking.workflowSlug ?? null,
      featureSlug: workflowTracking.featureSlug ?? null,
    });

    // Stream response from Claude
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

    const allTools = resolveToolSet(allowedToolNames);
    const allowedToolSet = new Set(allowedToolNames);

    // Detect client disconnect to abort in-flight streams
    const abortController = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) {
        console.log(`[chat] session="${currentSessionId}" client disconnected — aborting stream`);
        abortController.abort();
      }
    });

    /**
     * Execute a server-side tool (built-in) and return the result.
     * Returns null if the tool is client-side (request_user_input) or unhandled.
     */
    async function executeTool(
      call: { name: string; args: Record<string, unknown> },
    ): Promise<{ name: string; result: unknown } | "input_request" | null> {
      // Tool guard: reject tools not in the config's allowedTools
      if (!allowedToolSet.has(call.name)) {
        console.warn(`[chat] Tool "${call.name}" not in allowedTools for configKey="${configKey}" — rejecting`);
        return {
          name: call.name,
          result: { error: `Tool "${call.name}" is not available in this chat mode.` },
        };
      }

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
          const { workflowId: rawWorkflowId, ...updateBody } = args;
          // Redirect to the already-forked workflow if the LLM tries to
          // update the same source workflow again in this turn.
          const effectiveWorkflowId = forkedWorkflowMap.get(rawWorkflowId as string) ?? rawWorkflowId as string;
          const wasRedirected = effectiveWorkflowId !== (rawWorkflowId as string);
          if (wasRedirected) {
            console.log(
              `[chat] Redirecting update_workflow from already-forked source "${rawWorkflowId}" → "${effectiveWorkflowId}"`,
            );
          }
          try {
            const updateResult = await updateWorkflow(
              effectiveWorkflowId,
              updateBody as import("./lib/workflow-client.js").UpdateWorkflowBody,
              wfParams,
            );
            if (updateResult.outcome === "forked") {
              const forkedFrom = updateResult.workflow._forkedFromName || rawWorkflowId;
              // Record the fork so subsequent calls target the fork, not the original
              forkedWorkflowMap.set(rawWorkflowId as string, updateResult.workflow.id);
              result = {
                ...updateResult.workflow,
                _note: `This is a NEW workflow forked from "${forkedFrom}". Tell the user: "Your customized workflow is ready: ${updateResult.workflow.name || updateResult.workflow.signatureName || updateResult.workflow.id}. Use this name for future campaigns."`,
              };
            } else {
              result = updateResult.workflow;
            }
          } catch (err: unknown) {
            // 409 on a redirected call means the forked workflow already has
            // the same DAG — treat as a no-op and return the current state.
            const is409 = err instanceof Error && err.message.includes("signature already exists");
            if (is409) {
              console.log(
                `[chat] update_workflow 409 on "${effectiveWorkflowId}" — workflow already has this DAG, returning current state`,
              );
              const current = await getWorkflow(effectiveWorkflowId, wfParams);
              result = {
                ...current,
                _note: "No changes needed — this workflow already has the requested configuration.",
              };
            } else {
              throw err;
            }
          }
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
            featureSlug: args.featureSlug as string | undefined,
            category: args.category as string | undefined,
            channel: args.channel as string | undefined,
            audienceType: args.audienceType as string | undefined,
            tag: args.tag as string | undefined,
            status: args.status as string | undefined,
            brandId: args.brandId as string | undefined,
            humanId: args.humanId as string | undefined,
            campaignId: args.campaignId as string | undefined,
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
        const rawWorkflowId = args.workflowId as string;
        // Redirect to the already-forked workflow if applicable
        const effectiveWorkflowId = forkedWorkflowMap.get(rawWorkflowId) ?? rawWorkflowId;
        if (effectiveWorkflowId !== rawWorkflowId) {
          console.log(
            `[chat] Redirecting update_workflow_node_config from already-forked source "${rawWorkflowId}" → "${effectiveWorkflowId}"`,
          );
        }

        let result: unknown;
        try {
          const updateResult = await updateWorkflowNodeConfig(
            effectiveWorkflowId,
            args.nodeId as string,
            args.configUpdates as Record<string, unknown>,
            {
              orgId,
              userId,
              runId: runId!,
              trackingHeaders: Object.keys(trackingHeaders).length > 0 ? trackingHeaders as Record<string, string> : undefined,
            },
          );

          if (updateResult.outcome === "forked") {
            const forkedFrom = updateResult.workflow._forkedFromName || "the original";
            // Record the fork so subsequent calls target the fork
            forkedWorkflowMap.set(rawWorkflowId, updateResult.workflow.id);
            result = {
              ...updateResult.workflow,
              _note: `This is a NEW workflow forked from "${forkedFrom}". Tell the user: "Your customized workflow is ready: ${updateResult.workflow.name || updateResult.workflow.signatureName || updateResult.workflow.id}. Use this name for future campaigns."`,
            };
          } else {
            result = updateResult.workflow;
          }
        } catch (err: unknown) {
          const is409 = err instanceof Error && err.message.includes("signature already exists");
          if (is409) {
            console.log(
              `[chat] update_workflow_node_config 409 on "${effectiveWorkflowId}" — workflow already has this DAG, returning current state`,
            );
            const current = await getWorkflow(effectiveWorkflowId, {
              orgId,
              userId,
              runId: runId!,
              trackingHeaders: Object.keys(trackingHeaders).length > 0 ? trackingHeaders as Record<string, string> : undefined,
            });
            result = {
              ...current,
              _note: "No changes needed — this workflow already has the requested configuration.",
            };
          } else {
            throw err;
          }
        }

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

      // API Registry progressive disclosure tools
      if (call.name === "list_services") {
        const result = await listServices({ orgId, userId, runId: runId! });
        toolCalls.push({ name: call.name, args: {}, result });
        return { name: call.name, result };
      }

      if (call.name === "list_service_endpoints") {
        const args = (call.args as Record<string, unknown>) || {};
        const result = await listServiceEndpoints(
          args.service as string,
          { orgId, userId, runId: runId! },
        );
        toolCalls.push({ name: call.name, args, result });
        return { name: call.name, result };
      }

      // call_api removed — security risk (unrestricted admin-key access to all services)

      // Key-service read tools
      if (call.name === "list_org_keys") {
        const result = await listOrgKeys({
          orgId,
          userId,
          runId: runId!,
          trackingHeaders: Object.keys(trackingHeaders).length > 0 ? trackingHeaders as Record<string, string> : undefined,
        });
        toolCalls.push({ name: call.name, args: {}, result });
        return { name: call.name, result };
      }

      if (call.name === "get_key_source") {
        const args = (call.args as Record<string, unknown>) || {};
        const result = await getKeySource(
          args.provider as string,
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

      if (call.name === "list_key_sources") {
        const result = await listKeySources({
          orgId,
          userId,
          runId: runId!,
          trackingHeaders: Object.keys(trackingHeaders).length > 0 ? trackingHeaders as Record<string, string> : undefined,
        });
        toolCalls.push({ name: call.name, args: {}, result });
        return { name: call.name, result };
      }

      if (call.name === "check_provider_requirements") {
        const args = (call.args as Record<string, unknown>) || {};
        const result = await checkProviderRequirements(
          args.endpoints as Array<{ service: string; method: string; path: string }>,
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

      // Built-in feature tools (feature-creator context only)
      const featureCallParams = {
        orgId,
        userId,
        runId: runId!,
        trackingHeaders: Object.keys(trackingHeaders).length > 0 ? trackingHeaders as Record<string, string> : undefined,
      };

      if (call.name === "create_feature") {
        const args = (call.args as Record<string, unknown>) || {};
        const result = await createFeature(
          args as unknown as import("./lib/features-client.js").CreateFeatureBody,
          featureCallParams,
        );
        toolCalls.push({ name: call.name, args, result });
        return { name: call.name, result };
      }

      if (call.name === "update_feature") {
        const args = (call.args as Record<string, unknown>) || {};
        const { slug, ...updateBody } = args;
        const { feature, forked } = await updateFeature(
          slug as string,
          updateBody as Partial<Omit<import("./lib/features-client.js").CreateFeatureBody, "slug">>,
          featureCallParams,
        );
        const result = { ...feature, forked };
        toolCalls.push({ name: call.name, args, result });
        return { name: call.name, result };
      }

      if (call.name === "list_features") {
        const args = (call.args as Record<string, unknown>) || {};
        const result = await listFeatures(
          {
            category: args.category as string | undefined,
            channel: args.channel as string | undefined,
            audienceType: args.audienceType as string | undefined,
            status: args.status as string | undefined,
            implemented: args.implemented as string | undefined,
          },
          featureCallParams,
        );
        toolCalls.push({ name: call.name, args, result });
        return { name: call.name, result };
      }

      if (call.name === "get_feature") {
        const args = (call.args as Record<string, unknown>) || {};
        const result = await getFeature(args.slug as string, featureCallParams);
        toolCalls.push({ name: call.name, args, result });
        return { name: call.name, result };
      }

      if (call.name === "get_feature_inputs") {
        const args = (call.args as Record<string, unknown>) || {};
        const result = await getFeatureInputs(args.slug as string, featureCallParams);
        toolCalls.push({ name: call.name, args, result });
        return { name: call.name, result };
      }

      if (call.name === "prefill_feature") {
        const args = (call.args as Record<string, unknown>) || {};
        const result = await prefillFeature(args.slug as string, featureCallParams);
        toolCalls.push({ name: call.name, args, result });
        return { name: call.name, result };
      }

      if (call.name === "get_feature_stats") {
        const args = (call.args as Record<string, unknown>) || {};
        const result = await getFeatureStats(
          args.slug as string,
          {
            groupBy: args.groupBy as "workflowSlug" | "brandId" | "campaignId" | undefined,
            brandId: args.brandId as string | undefined,
            campaignId: args.campaignId as string | undefined,
            workflowSlug: args.workflowSlug as string | undefined,
          },
          featureCallParams,
        );
        toolCalls.push({ name: call.name, args, result });
        return { name: call.name, result };
      }

      // Campaign-prefill tools
      if (call.name === "update_campaign_fields") {
        const args = (call.args as Record<string, unknown>) || {};
        const result = { fields: args.fields as Record<string, string> };
        toolCalls.push({ name: call.name, args, result });
        return { name: call.name, result };
      }

      if (call.name === "extract_brand_fields") {
        const args = (call.args as Record<string, unknown>) || {};
        const result = await extractBrandFields(
          args.fields as Array<{ key: string; description: string }>,
          featureCallParams,
        );
        toolCalls.push({ name: call.name, args, result });
        return { name: call.name, result };
      }

      if (call.name === "extract_brand_text") {
        const args = (call.args as Record<string, unknown>) || {};
        const result = await extractBrandText(
          args.brandId as string,
          featureCallParams,
        );
        toolCalls.push({ name: call.name, args, result });
        return { name: call.name, result };
      }

      return null;
    }

    // -----------------------------------------------------------------------
    // Agentic loop: stream → handle tools → repeat
    // -----------------------------------------------------------------------

    const turnMessages: Anthropic.MessageParam[] = [
      ...anthropicHistory,
      { role: "user", content: message.trim() },
    ];

    const MAX_TOOL_CHAIN_DEPTH = 10;
    let depth = 0;
    let lastContentBlocks: Anthropic.ContentBlock[] = [];

    // Track workflows that were forked during this turn so the LLM
    // doesn't accidentally fork the same source workflow multiple times.
    // Maps: originalWorkflowId → forkedWorkflowId
    const forkedWorkflowMap = new Map<string, string>();

    agenticLoop:
    while (depth <= MAX_TOOL_CHAIN_DEPTH) {
      // Abort early if client already disconnected
      if (abortController.signal.aborted) {
        console.log(`[chat] session="${currentSessionId}" aborted before depth=${depth}`);
        break;
      }

      let currentBlockType: string | null = null;
      const stream = claude.createStream(turnMessages, allTools, abortController.signal);

      try {
        for await (const event of stream) {
          if (event.type === "content_block_start") {
            currentBlockType = event.content_block.type;
            if (currentBlockType === "thinking") {
              sendSSE(res, { type: "thinking_start" });
            }
          } else if (event.type === "content_block_delta") {
            if (event.delta.type === "thinking_delta") {
              sendSSE(res, { type: "thinking_delta", thinking: event.delta.thinking });
            } else if (event.delta.type === "text_delta") {
              bufferToken(event.delta.text);
            }
          } else if (event.type === "content_block_stop") {
            if (currentBlockType === "thinking") {
              sendSSE(res, { type: "thinking_stop" });
            }
            currentBlockType = null;
          }
        }
      } catch (streamErr) {
        // If aborted due to client disconnect, exit cleanly
        if (abortController.signal.aborted) {
          console.log(`[chat] session="${currentSessionId}" stream aborted (client disconnect)`);
          return;
        }
        throw streamErr; // Re-throw to outer catch for error SSE
      }

      const finalMessage = await stream.finalMessage();
      totalPromptTokens += finalMessage.usage.input_tokens;
      totalOutputTokens += finalMessage.usage.output_tokens;
      lastContentBlocks = finalMessage.content;

      // If no tool calls, we're done
      if (finalMessage.stop_reason !== "tool_use") break;

      // Extract tool_use blocks from the response
      const toolUseBlocks = finalMessage.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      // Append assistant response (with tool_use blocks) to turn history
      turnMessages.push({ role: "assistant", content: finalMessage.content });

      // Execute all tool calls and collect results
      const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        const toolCallId = `tc_${crypto.randomUUID()}`;

        if (toolUse.name !== "request_user_input") {
          sendSSE(res, {
            type: "tool_call",
            id: toolCallId,
            name: toolUse.name,
            args: toolUse.input as Record<string, unknown>,
          });
        }

        try {
          const toolResult = await executeTool({
            name: toolUse.name,
            args: (toolUse.input as Record<string, unknown>) ?? {},
          });

          if (toolResult === "input_request") {
            break agenticLoop; // Stop — client needs input
          }

          if (toolResult === null) {
            toolResultBlocks.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: JSON.stringify({ error: "Unknown tool" }),
              is_error: true,
            });
            continue;
          }

          sendSSE(res, { type: "tool_result", id: toolCallId, name: toolUse.name, result: toolResult.result });
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(toolResult.result),
          });
        } catch (toolErr: unknown) {
          const rawMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
          console.error(`Tool call ${toolUse.name} failed:`, rawMsg);
          const friendly = formatToolError(toolUse.name, rawMsg);
          sendSSE(res, { type: "tool_result", id: toolCallId, name: toolUse.name, result: friendly });

          // Feed the error back to Claude so it can self-correct
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(friendly),
            is_error: true,
          });
        }
      }

      // Append tool results and continue the loop
      turnMessages.push({ role: "user", content: toolResultBlocks });
      depth++;
    }

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

    // Detect empty stream: Claude returned no content (safety refusal, context overflow, etc.)
    if (!fullResponse && !emittedInputRequest && toolCalls.length === 0) {
      chatFailed = true;
      console.error(
        `Empty Claude response for session="${currentSessionId}" org="${orgId}" — ` +
          `promptTokens=${totalPromptTokens} outputTokens=${totalOutputTokens} ` +
          `historyLength=${anthropicHistory.length} messageLength=${message.length}`,
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

    // Save assistant message with cleaned response + content blocks for compaction
    // Strip tool_use blocks — they are ephemeral (tool results aren't saved as separate
    // messages), so persisting them causes missing tool_result errors on next load.
    const cleanedResponse =
      buttons.length > 0 ? stripButtons(fullResponse) : fullResponse;
    const persistBlocks = stripToolUseBlocks(
      lastContentBlocks as Anthropic.ContentBlockParam[],
    );
    await db.insert(messages).values({
      sessionId: currentSessionId,
      role: "assistant",
      content: cleanedResponse,
      contentBlocks: persistBlocks.length > 0 ? persistBlocks : null,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      buttons: buttons.length > 0 ? buttons : null,
      tokenCount: totalPromptTokens + totalOutputTokens || null,
      runId,
      campaignId: workflowTracking.campaignId ?? null,
      brandIds: workflowTracking.brandId ? workflowTracking.brandId.split(",").map(s => s.trim()).filter(Boolean) : null,
      workflowSlug: workflowTracking.workflowSlug ?? null,
      featureSlug: workflowTracking.featureSlug ?? null,
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
      const costSource: "platform" | "org" =
        resolvedKey.keySource === "org" ? "org" : "platform";
      const costItems = [
        ...(totalPromptTokens > 0
          ? [
              {
                costName: `${COST_PREFIX}-tokens-input`,
                quantity: totalPromptTokens,
                costSource,
              },
            ]
          : []),
        ...(totalOutputTokens > 0
          ? [
              {
                costName: `${COST_PREFIX}-tokens-output`,
                quantity: totalOutputTokens,
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
      const server = app.listen(Number(PORT), "::", () => {
        console.log(`Service running on port ${PORT}`);
      });

      // Node 20 defaults requestTimeout to 300s (5 min). SSE chat streams
      // can run for 30–60 min when the LLM makes many tool calls, so we
      // disable the request timeout entirely. Headers timeout stays at 60s
      // to reject slow/malformed initial requests.
      server.requestTimeout = 0;
      server.headersTimeout = 60_000;
      server.keepAliveTimeout = 120_000;

      // Graceful shutdown: let in-flight SSE streams finish before exiting
      const DRAIN_TIMEOUT_MS = 25_000; // Railway sends SIGKILL after 30s

      const shutdown = (signal: string) => {
        console.log(`[shutdown] Received ${signal}, draining connections…`);
        server.close(() => {
          console.log("[shutdown] All connections closed, exiting.");
          process.exit(0);
        });

        setTimeout(() => {
          console.log("[shutdown] Drain timeout reached, forcing exit.");
          process.exit(0);
        }, DRAIN_TIMEOUT_MS).unref();
      };

      process.on("SIGTERM", () => shutdown("SIGTERM"));
      process.on("SIGINT", () => shutdown("SIGINT"));
    })
    .catch((err) => {
      console.error("Startup failed:", err);
      process.exit(1);
    });
}

export default app;
