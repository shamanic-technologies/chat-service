import express from "express";
import cors from "cors";
import crypto from "crypto";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { db } from "./db/index.js";
import { sessions, messages, appConfigs, platformConfigs, brandProfileEmbeddings } from "./db/schema.js";
import { eq, and, sql } from "drizzle-orm";
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
  isRetryableAnthropicError,
  getRetryAfterMs,
  ANTHROPIC_STREAM_MAX_RETRIES,
  ANTHROPIC_STREAM_RETRY_BASE_MS,
} from "./lib/anthropic.js";
import type { Provider, ModelAlias } from "./lib/anthropic.js";
import { resolveChatProviderModel, buildConfigConflictSet } from "./lib/config-defaults.js";
import { isGeminiModel, completeWithGemini } from "./lib/gemini.js";
import {
  createWorkflow,
  upgradeWorkflow,
  forkWorkflow,
  validateWorkflow,
  getWorkflow,
  getWorkflowRequiredProviders,
  listWorkflows,
} from "./lib/workflow-client.js";
import { getPromptTemplate, updatePromptTemplate } from "./lib/content-generation-client.js";
import { listServices, listServiceEndpoints } from "./lib/api-registry-client.js";
import { createRun, updateRunStatus, addRunCosts, updateRunCostStatus, createPlatformRun, addPlatformRunCosts, updatePlatformRunStatus, type CostItem, type RunIdentityHeaders } from "./lib/runs-client.js";
import { traceEvent } from "./lib/trace-event.js";
import { createFeature, updateFeature, listFeatures, getFeature, getFeatureInputs, prefillFeature, getFeatureStats } from "./lib/features-client.js";
import { extractBrandFields, BrandError } from "./lib/brand-client.js";
import {
  embedText,
  embedTexts,
  cosineSimilarity,
  contentHash,
  embeddingCostPrefix,
  estimateTokens,
  DEFAULT_EMBEDDING_MODEL,
} from "./lib/embeddings.js";
import { scrapeUrl } from "./lib/scraping-client.js";
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
import { ChatRequestSchema, CompleteRequestSchema, InternalPlatformCompleteRequestSchema, AppConfigRequestSchema, PlatformConfigRequestSchema, TransferBrandRequestSchema, RagScoreRequestSchema, RagEmbedRequestSchema } from "./schemas.js";
import { requireAuth, requireInternalAuth, type AuthLocals } from "./middleware/auth.js";
import type { ButtonRecord, ToolCallRecord } from "./db/schema.js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const openapiPath = join(__dirname, "..", "openapi.json");

import {
  mergeConsecutiveMessages,
  rebuildAnthropicHistory,
  stripToolUseBlocks,
  type RebuildableMessage,
} from "./lib/merge-messages.js";
import { streamGeminiChat, type ToolDefinition } from "./lib/gemini-chat.js";
import { SESSION_NOT_FOUND_EVENT } from "./lib/session-errors.js";
import { buildContextUsageEvent } from "./lib/context-usage.js";

// ---------------------------------------------------------------------------
// Anthropic stream retry
// ---------------------------------------------------------------------------
// Retry constants + transient-error helpers (isRetryableAnthropicError,
// getRetryAfterMs) live in ./lib/anthropic.js — shared by the /chat streaming
// loop here and the non-streaming complete() retry. Imported above.

/**
 * Classify an error for the SSE error event sent to the client.
 * Returns a user-facing message and an error code the frontend can act on.
 */
function classifyErrorForClient(err: unknown): { message: string; code: string } {
  if (err instanceof Anthropic.APIError) {
    const errorBody = err.error as { type?: string; error?: { type?: string } } | undefined;
    const errorType = errorBody?.error?.type;
    if (errorType === "overloaded_error" || err.status === 529) {
      return {
        code: "model_overloaded",
        message: "Claude is temporarily overloaded. Please try again in a moment.",
      };
    }
    if (err.status === 429) {
      return {
        code: "rate_limited",
        message: "Too many requests. Please wait a moment and try again.",
      };
    }
    if (typeof err.status === "number" && err.status >= 500) {
      return {
        code: "model_error",
        message: "Claude encountered a temporary error. Please try again.",
      };
    }
  }
  return {
    code: "internal_error",
    message: "An unexpected error occurred. Please try again.",
  };
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

  const { key, systemPrompt, allowedTools, provider, model } = parsed.data;

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
      provider: provider ?? null,
      model: model ?? null,
    })
    .onConflictDoUpdate({
      target: [appConfigs.orgId, appConfigs.key],
      // Omitted provider/model are left out of the SET so a re-registering app
      // doesn't clobber an explicit stored override back to NULL.
      set: {
        ...buildConfigConflictSet({ systemPrompt, allowedTools, provider, model }),
        updatedAt: new Date(),
      },
    })
    .returning();

  res.json({
    orgId: config.orgId,
    key: config.key,
    systemPrompt: config.systemPrompt,
    allowedTools: config.allowedTools,
    provider: config.provider,
    model: config.model,
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

  const { key, systemPrompt, allowedTools, provider, model } = parsed.data;

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
      provider: provider ?? null,
      model: model ?? null,
    })
    .onConflictDoUpdate({
      target: [platformConfigs.key],
      // Omitted provider/model are left out of the SET so a re-registering app
      // doesn't clobber an explicit stored override back to NULL.
      set: {
        ...buildConfigConflictSet({ systemPrompt, allowedTools, provider, model }),
        updatedAt: new Date(),
      },
    })
    .returning();

  res.json({
    key: config.key,
    systemPrompt: config.systemPrompt,
    allowedTools: config.allowedTools,
    provider: config.provider,
    model: config.model,
    createdAt: config.createdAt.toISOString(),
    updatedAt: config.updatedAt.toISOString(),
  });
});

// --- Complete (synchronous LLM call) ---

app.post("/complete", requireAuth, async (req, res) => {
  const { orgId, userId, parentRunId, workflowTracking } = res.locals as AuthLocals;

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

  const { message, systemPrompt, responseFormat, responseSchema, temperature, provider: requestedProvider, model: requestedModel, imageUrl, imageContext, webSearch: webSearchRaw } = parsed.data;
  const webSearch = webSearchRaw === true;

  // Passing a responseSchema implies JSON-mode parsing of the response.
  const jsonMode = responseFormat === "json" || responseSchema != null;

  // Resolve versioned model from (provider, alias) pair
  const resolved = resolveModel(requestedProvider as Provider, requestedModel as ModelAlias);
  const effectiveModel = resolved.apiModelId;
  const isGemini = resolved.provider === "google";
  const provider = resolved.provider;

  // Native web-search cost name (byte-equal to costs-service catalog) — only when opted in.
  const searchCostName = webSearch ? webSearchCostName(isGemini) : undefined;

  // Anthropic JSON mode requires `responseSchema` — Anthropic API has no native
  // standalone JSON-mode flag; enforcement is only available via
  // `output_config.format = { type: "json_schema", schema }`. Reject upfront so
  // callers get a clear error instead of best-effort behavior.
  if (provider === "anthropic" && responseFormat === "json" && responseSchema == null) {
    return res.status(400).json({
      error:
        "Anthropic JSON mode requires responseSchema. Per Anthropic API, JSON output is only enforceable via output_config.format with a JSON Schema. Supply responseSchema in the request body.",
    });
  }

  // Resolve API key per-request
  let resolvedKey: ResolvedKey;
  try {
    resolvedKey = await resolveKey({
      provider,
      orgId,
      userId,
      runId: parentRunId,
      caller: { method: "POST", path: "/complete" },
      trackingHeaders,
    });
  } catch (err) {
    console.error(`[complete] Failed to resolve ${provider} key for org="${orgId}":`, err);
    return res.status(502).json({
      error: `Failed to resolve ${provider} API key. Ensure the key is configured in key-service.`,
    });
  }

  // Cost prefix + source from model / key resolution.
  const effectiveCostPrefix = resolved.costPrefix;
  const costSource: "platform" | "org" = resolvedKey.keySource === "org" ? "org" : "platform";
  // Provision quantities (worst case): input estimate + output budget. /complete has no
  // caller maxTokens param, so the model's output budget is the theoretical max.
  const estimatedInputTokens = Math.max(Math.ceil(message.length / 4), 500);
  const maxOutputTokens = 64_000;

  // Register run (mandatory) — must precede provisioning (cost rows attach to the run).
  let runId: string | null = null;
  try {
    const run = await createRun(
      { serviceName: "chat-service", taskName: "complete" },
      { orgId, userId, runId: parentRunId },
      trackingHeaders,
    );
    runId = run.id;
    traceEvent(runId, "run-created", { orgId, userId }, workflowTracking, {
      data: { taskName: "complete", parentRunId, provider, model: effectiveModel },
    });
  } catch (runErr) {
    console.error(`[complete] org="${orgId}" run creation failed:`, runErr);
    return res.status(502).json({
      error: "Service temporarily unavailable (run tracking). Please try again.",
    });
  }

  let completeFailed = false;
  let totalPromptTokens = 0;
  let totalOutputTokens = 0;
  let totalSearchCount = 0;
  let provisionedCostIds: string[] = [];
  try {
    // PROVISION worst case → AUTHORIZE (platform) before the LLM call. Fail loud — never
    // spend on an undeclarable or unaffordable cost.
    try {
      provisionedCostIds = await provisionAndAuthorizeLlmCost({
        runId,
        costPrefix: effectiveCostPrefix,
        inputTokens: estimatedInputTokens,
        outputTokens: maxOutputTokens,
        keySource: resolvedKey.keySource,
        identity: { orgId, userId, runId },
        trackingHeaders,
        description: `complete — ${effectiveModel}`,
        searchCostName,
        searchQuantity: webSearch ? WORST_CASE_SEARCHES : undefined,
      });
    } catch (costErr) {
      completeFailed = true;
      const r = costErrorResponse(costErr, "complete", orgId);
      return res.status(r.status).json(r.body);
    }

    let result: { content: string; tokensInput: number; tokensOutput: number; model: string; searchCount: number; sources: Array<{ url: string; title?: string }> };

    if (runId) {
      traceEvent(runId, "llm-call-start", { orgId, userId }, workflowTracking, {
        data: { provider, model: effectiveModel, responseFormat, hasResponseSchema: responseSchema != null },
      });
    }

    if (isGemini) {
      result = await completeWithGemini({
        apiKey: resolvedKey.key,
        model: effectiveModel,
        message,
        systemPrompt,
        imageUrl,
        imageContext,
        responseFormat,
        responseSchema,
        temperature,
        webSearch,
      });
    } else {
      const claude = createAnthropicClient({ apiKey: resolvedKey.key, systemPrompt });
      result = await claude.complete(message, {
        responseFormat,
        responseSchema,
        temperature,
        model: effectiveModel,
        imageUrl,
        webSearch,
      });
    }

    totalPromptTokens = result.tokensInput;
    totalOutputTokens = result.tokensOutput;
    totalSearchCount = result.searchCount;

    if (runId) {
      traceEvent(runId, "llm-call-done", { orgId, userId }, workflowTracking, {
        data: {
          provider,
          model: result.model,
          tokensInput: result.tokensInput,
          tokensOutput: result.tokensOutput,
        },
      });
    }

    // Build response. In text mode, surface native-search citation URLs in the
    // answer text itself. In JSON mode, leave content untouched — the provider
    // returns strict JSON and appending a Sources block would corrupt the parse.
    const response: Record<string, unknown> = {
      content: jsonMode ? result.content : appendSources(result.content, result.sources),
      tokensInput: result.tokensInput,
      tokensOutput: result.tokensOutput,
      model: result.model,
    };

    // Parse JSON if requested. Strict parse — no fallback, no repair.
    // Provider-side enforcement (Anthropic output_config.format, Gemini
    // responseMimeType / responseSchema) guarantees valid JSON when jsonMode
    // is set; a parse failure here means the provider violated the contract.
    if (jsonMode) {
      response.json = JSON.parse(result.content);
    }

    res.json(response);
  } catch (err) {
    completeFailed = true;
    console.error(`[complete] org="${orgId}" error:`, err);
    if (runId) {
      traceEvent(runId, "llm-call-failed", { orgId, userId }, workflowTracking, {
        level: "error",
        detail: err instanceof Error ? err.message : String(err),
        data: { provider, model: effectiveModel },
      });
    }
    res.status(502).json({
      error: "LLM call failed. Please try again.",
    });
  } finally {
    // Reconcile: record ACTUAL real tokens, then release the provisioned worst-case holds.
    // If the actual POST fails, the provisioned-max rows stay as a fallback record — the
    // cost is never silently lost.
    if (runId) {
      const runIdentity = { orgId, userId, runId };
      const actualItems = [
        ...(totalPromptTokens > 0
          ? [{ costName: `${effectiveCostPrefix}-tokens-input`, quantity: totalPromptTokens, costSource }]
          : []),
        ...(totalOutputTokens > 0
          ? [{ costName: `${effectiveCostPrefix}-tokens-output`, quantity: totalOutputTokens, costSource }]
          : []),
        ...(searchCostName && totalSearchCount > 0
          ? [{ costName: searchCostName, quantity: totalSearchCount, costSource }]
          : []),
      ];
      try {
        await updateRunStatus(runId, completeFailed ? "failed" : "completed", runIdentity, trackingHeaders);
      } catch (runErr) {
        console.error(`[chat-service] /complete failed to finalize run runId="${runId}" orgId="${orgId}":`, runErr);
      }
      if (provisionedCostIds.length > 0) {
        try {
          if (actualItems.length > 0) {
            await addRunCosts(runId, actualItems, runIdentity, trackingHeaders);
          }
          await cancelProvisionedCosts(runId, provisionedCostIds, runIdentity, trackingHeaders);
        } catch (costErr) {
          console.error(`[complete] cost reconcile failed runId="${runId}" — provisioned-max kept as fallback:`, costErr);
        }
      }
    }
  }
});

// --- Org RAG Score (semantic similarity) ---
//
// Brand-profile fields used to synthesize the cached query string.
// Order is fixed so contentHash is stable across calls.
const RAG_BRAND_FIELDS: Array<{ key: string; description: string }> = [
  { key: "industry", description: "The brand's primary industry vertical (1-3 words)." },
  { key: "expertise", description: "Specific topics, problems, or angles the brand is qualified to comment on." },
  { key: "target_audience", description: "Who the brand sells to or speaks to (job titles, segments, geographies)." },
  { key: "voice", description: "Brand voice / tone in 1-2 sentences (e.g. data-driven, founder-led, casual)." },
];

function buildBrandProfileQuery(fields: Record<string, string>): string {
  const lines: string[] = [];
  for (const def of RAG_BRAND_FIELDS) {
    const value = fields[def.key];
    if (value && value.trim().length > 0) {
      lines.push(`${def.key.replace(/_/g, " ")}: ${value.trim()}`);
    }
  }
  return lines.join("\n");
}

/** Thrown when billing reports the org cannot afford a platform-key spend. */
class InsufficientCreditsError extends Error {
  constructor(
    public readonly balanceCents: string | number,
    public readonly requiredCents: string | number,
  ) {
    super("Insufficient credits");
    this.name = "InsufficientCreditsError";
  }
}

/**
 * PROVISION (runs ledger) then AUTHORIZE (billing affordability, platform keys only)
 * an embedding spend BEFORE the Gemini call. Returns the provisioned cost id to
 * actualize/cancel later, or null when there is nothing to charge (inputTokens <= 0).
 *
 * Throws on any failure so the caller fails loud — never spend on an undeclarable or
 * unaffordable cost. Releases (cancels) the provision if authorization fails.
 */
async function provisionAndAuthorizeEmbeddingCost(args: {
  runId: string;
  inputTokens: number;
  keySource: "org" | "platform";
  identity: RunIdentityHeaders;
  trackingHeaders: Record<string, string>;
  description: string;
}): Promise<string | null> {
  const { runId, inputTokens, keySource, identity, trackingHeaders, description } = args;
  if (inputTokens <= 0) return null;

  const costName = `${embeddingCostPrefix(DEFAULT_EMBEDDING_MODEL)}-tokens-input`;

  // 1. PROVISION — reserve in the runs ledger; validates the cost name is declarable
  //    (runs-service 422s an unknown cost name → throws → caller 502s, no spend).
  const items: CostItem[] = [
    { costName, quantity: inputTokens, costSource: keySource, status: "provisioned" },
  ];
  const costs = await addRunCosts(runId, items, identity, trackingHeaders);
  const costId = costs[0]?.id;
  if (!costId) {
    throw new Error("[rag] provision returned no cost id");
  }

  // 2. AUTHORIZE — affordability, platform-key spend only (BYOK pays the provider directly).
  if (keySource === "platform") {
    try {
      const auth = await authorizeCredits({
        items: [{ costName, quantity: inputTokens }],
        description,
        orgId: identity.orgId,
        userId: identity.userId,
        runId,
        trackingHeaders: Object.keys(trackingHeaders).length > 0 ? trackingHeaders : undefined,
      });
      if (!auth.sufficient) {
        await updateRunCostStatus(runId, costId, "cancelled", identity, trackingHeaders).catch((e) =>
          console.error(`[rag] cancel after insufficient credits failed runId="${runId}":`, e),
        );
        throw new InsufficientCreditsError(auth.balance_cents, auth.required_cents);
      }
    } catch (err) {
      if (err instanceof InsufficientCreditsError) throw err;
      // Billing call itself failed — release the reservation, then rethrow.
      await updateRunCostStatus(runId, costId, "cancelled", identity, trackingHeaders).catch((e) =>
        console.error(`[rag] cancel after billing error failed runId="${runId}":`, e),
      );
      throw err;
    }
  }

  return costId;
}

/** Map a provision/authorize failure to an HTTP status + body. */
function costErrorResponse(
  err: unknown,
  tag: string,
  orgId: string,
): { status: number; body: Record<string, unknown> } {
  if (err instanceof InsufficientCreditsError) {
    console.warn(
      `[${tag}] insufficient credits: org="${orgId}" balance_cents=${err.balanceCents} required_cents=${err.requiredCents}`,
    );
    return {
      status: 402,
      body: { error: "Insufficient credits", balance_cents: err.balanceCents, required_cents: err.requiredCents },
    };
  }
  if (err instanceof BillingError && err.isClientError) {
    console.error(`[${tag}] billing authorization rejected for org="${orgId}":`, err);
    return { status: err.statusCode, body: { error: `Billing authorization rejected: ${err.upstreamBody}` } };
  }
  console.error(`[${tag}] cost provision/authorize failed for org="${orgId}":`, err);
  return { status: 502, body: { error: "Cost authorization failed. Please try again." } };
}

/** Cancel a set of provisioned cost rows (release the worst-case hold). Best-effort, logged. */
async function cancelProvisionedCosts(
  runId: string,
  costIds: string[],
  identity: RunIdentityHeaders,
  trackingHeaders: Record<string, string>,
): Promise<void> {
  await Promise.all(
    costIds.map((id) =>
      updateRunCostStatus(runId, id, "cancelled", identity, trackingHeaders).catch((e) =>
        console.error(`[cost] cancel provisioned failed runId="${runId}" costId="${id}":`, e),
      ),
    ),
  );
}

/**
 * Append a deduped `Sources:` block of citation URLs to the model's text answer.
 * Used when native web search ran, so the live source URLs surface in the
 * response `content` itself (both providers return them in metadata, not prose;
 * Anthropic's ToS also requires citing sources when displaying search output).
 * No-op when there are no sources — preserves byte-identical non-grounded output.
 */
function appendSources(
  content: string,
  sources: Array<{ url: string; title?: string }>,
): string {
  if (!sources || sources.length === 0) return content;
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const s of sources) {
    if (!s.url || seen.has(s.url)) continue;
    seen.add(s.url);
    lines.push(s.title ? `- ${s.title}: ${s.url}` : `- ${s.url}`);
  }
  if (lines.length === 0) return content;
  return `${content}\n\nSources:\n${lines.join("\n")}`;
}

/**
 * Resolve the byte-equal web-search cost-catalog name for a provider.
 * Gemini → `google-search-query` (Google Search grounding, exists in catalog).
 * Anthropic → `anthropic-web-search` (server-side web_search). Both must match
 * the costs-service catalog exactly or runs-service 422s.
 */
function webSearchCostName(isGemini: boolean): string {
  return isGemini ? "google-search-query" : "anthropic-web-search";
}

/**
 * Worst-case web-search count provisioned/authorized before a call (reconciled to actual after).
 * Gemini 3 bills Grounding with Google Search PER executed query (a single grounded request can
 * fan out to ~12-20 internal searches), and the actual count is only known post-call from
 * `groundingMetadata.webSearchQueries.length`. Sized to the observed production max so the
 * pre-call AUTHORIZE hold does not under-reserve platform credits; the actual count trues it up.
 */
const WORST_CASE_SEARCHES = 20;

/**
 * Provision the worst-case LLM cost (input estimate + output max) as two `provisioned`
 * rows. Output tokens are unknown pre-call, so reserve the max and true up to actual
 * after (POST actual + cancel these holds). Returns the provisioned cost ids. Throws if
 * the cost is undeclarable (runs-service 422) — caller fails loud, never spends.
 */
async function provisionLlmCost(args: {
  runId: string;
  costPrefix: string;
  inputTokens: number;
  outputTokens: number;
  keySource: "org" | "platform";
  identity: RunIdentityHeaders;
  trackingHeaders: Record<string, string>;
  /** When set (webSearch on), also provision a worst-case web-search hold. */
  searchCostName?: string;
  searchQuantity?: number;
}): Promise<string[]> {
  const { runId, costPrefix, inputTokens, outputTokens, keySource, identity, trackingHeaders, searchCostName, searchQuantity } = args;
  const items: CostItem[] = [
    { costName: `${costPrefix}-tokens-input`, quantity: inputTokens, costSource: keySource, status: "provisioned" },
    { costName: `${costPrefix}-tokens-output`, quantity: outputTokens, costSource: keySource, status: "provisioned" },
    ...(searchCostName && searchQuantity
      ? [{ costName: searchCostName, quantity: searchQuantity, costSource: keySource, status: "provisioned" as const }]
      : []),
  ];
  const costs = await addRunCosts(runId, items, identity, trackingHeaders);
  return costs.map((c) => c.id);
}

/**
 * Provision (worst case) then authorize (platform keys) BEFORE the call. Returns the
 * provisioned cost ids to reconcile after. Throws on any failure so the caller fails
 * loud; releases the provision if authorization fails. Used by non-streaming `/complete`
 * (streaming `/chat` authorizes pre-stream and calls `provisionLlmCost` directly).
 */
async function provisionAndAuthorizeLlmCost(args: {
  runId: string;
  costPrefix: string;
  inputTokens: number;
  outputTokens: number;
  keySource: "org" | "platform";
  identity: RunIdentityHeaders;
  trackingHeaders: Record<string, string>;
  description: string;
  /** When set (webSearch on), provision + authorize a worst-case web-search hold. */
  searchCostName?: string;
  searchQuantity?: number;
}): Promise<string[]> {
  const { runId, costPrefix, inputTokens, outputTokens, keySource, identity, trackingHeaders, description, searchCostName, searchQuantity } = args;
  const costIds = await provisionLlmCost(args);
  if (keySource === "platform") {
    try {
      const auth = await authorizeCredits({
        items: [
          { costName: `${costPrefix}-tokens-input`, quantity: inputTokens },
          { costName: `${costPrefix}-tokens-output`, quantity: outputTokens },
          ...(searchCostName && searchQuantity
            ? [{ costName: searchCostName, quantity: searchQuantity }]
            : []),
        ],
        description,
        orgId: identity.orgId,
        userId: identity.userId,
        runId,
        trackingHeaders: Object.keys(trackingHeaders).length > 0 ? trackingHeaders : undefined,
      });
      if (!auth.sufficient) {
        await cancelProvisionedCosts(runId, costIds, identity, trackingHeaders);
        throw new InsufficientCreditsError(auth.balance_cents, auth.required_cents);
      }
    } catch (err) {
      if (err instanceof InsufficientCreditsError) throw err;
      await cancelProvisionedCosts(runId, costIds, identity, trackingHeaders);
      throw err;
    }
  }
  return costIds;
}

app.post("/orgs/rag/score", requireAuth, async (req, res) => {
  const { orgId, userId, parentRunId, workflowTracking } = res.locals as AuthLocals;

  const baseTrackingHeaders: Record<string, string> = {};
  if (workflowTracking.campaignId) baseTrackingHeaders["x-campaign-id"] = workflowTracking.campaignId;
  if (workflowTracking.workflowSlug) baseTrackingHeaders["x-workflow-slug"] = workflowTracking.workflowSlug;
  if (workflowTracking.featureSlug) baseTrackingHeaders["x-feature-slug"] = workflowTracking.featureSlug;

  const parsed = RagScoreRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid request", details: parsed.error.flatten() });
  }
  const {
    documents,
    brandIds: brandIdsFromBody,
    brandId: legacyBrandId,
    query: queryOverride,
  } = parsed.data;

  // Derive canonical-sorted brandIds. `brandIds` wins; otherwise fall back to legacy
  // `brandId`. The refine() above guarantees at least one is defined.
  const rawBrandIds = brandIdsFromBody ?? [legacyBrandId!];
  const brandIds = [...rawBrandIds].sort();
  // DB column name is still `brand_id` (singular) — repurposed to hold the canonical
  // sorted CSV. Single-brand → just the UUID (byte-identical to legacy cache rows).
  const brandCacheKey = brandIds.join(",");
  const isSingleBrand = brandIds.length === 1;

  // Body brandIds/brandId is the authoritative target — overrides any forwarded x-brand-id.
  const trackingHeaders: Record<string, string> = {
    ...baseTrackingHeaders,
    "x-brand-id": brandCacheKey,
  };

  // Register run (mandatory)
  let runId: string | null = null;
  try {
    const run = await createRun(
      { serviceName: "chat-service", taskName: "rag-score" },
      { orgId, userId, runId: parentRunId },
      trackingHeaders,
    );
    runId = run.id;
    traceEvent(runId, "run-created", { orgId, userId }, workflowTracking, {
      data: {
        taskName: "rag-score",
        parentRunId,
        brandIds,
        documentCount: documents.length,
      },
    });
  } catch (runErr) {
    console.error(`[rag-score] org="${orgId}" run creation failed:`, runErr);
    return res.status(502).json({
      error: "Service temporarily unavailable (run tracking). Please try again.",
    });
  }

  let scoreFailed = false;
  // Embedding cost is provisioned before the Gemini call and actualized/cancelled
  // after. Hoisted so the catch can release (cancel) a provision if the embed throws.
  let provisionedCostId: string | null = null;
  try {
    // Resolve joint brand context. Pass own runId so brand-service sees us as the parent.
    // For multi-brand, brand-service consolidates field values across all brandIds and
    // returns a single `fields[key].value` per field — no client-side joining needed.
    let brandResults;
    try {
      brandResults = await extractBrandFields(
        RAG_BRAND_FIELDS,
        brandIds,
        {
          orgId,
          userId,
          runId,
          trackingHeaders,
        },
      );
    } catch (err) {
      if (err instanceof BrandError && err.status === 404) {
        return res.status(404).json({
          error: `Brand not found: ${brandCacheKey}`,
        });
      }
      throw err;
    }

    // Flatten consolidated `value` per field into a {key: stringValue} map. Skip null/empty values.
    const fieldValues: Record<string, string> = {};
    for (const [key, entry] of Object.entries(brandResults.fields)) {
      if (entry.value == null) continue;
      const str = typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value);
      if (str.trim().length === 0) continue;
      fieldValues[key] = str;
    }

    const queryText = queryOverride ?? buildBrandProfileQuery(fieldValues);
    if (queryText.trim().length === 0) {
      scoreFailed = true;
      console.warn(
        `[rag-score] org="${orgId}" brands="${brandCacheKey}" produced empty brand profile (no resolvable fields)`,
      );
      return res.status(400).json({
        error:
          "Brand profile is empty — no resolvable brand fields. Provide an explicit `query` or enrich the brand in brand-service first.",
      });
    }

    // Cache key: hash of the resolved field values (or the override string).
    // brandCacheKey (canonical sorted CSV) is the column-level partition; the hash
    // covers the field values so any change in brand context invalidates the row.
    const hash = queryOverride
      ? contentHash({ __override__: queryOverride })
      : contentHash(fieldValues);

    // Resolve Gemini key once — needed for either branch (cache miss embeds query;
    // documents always need fresh embeddings).
    let resolvedKey;
    try {
      resolvedKey = await resolveKey({
        provider: "google",
        orgId,
        userId,
        runId,
        caller: { method: "POST", path: "/orgs/rag/score" },
        trackingHeaders,
      });
    } catch (err) {
      console.error(`[rag-score] Failed to resolve google key for org="${orgId}":`, err);
      return res.status(502).json({
        error: "Failed to resolve google API key. Ensure the key is configured in key-service.",
      });
    }
    // Cache lookup — determine hit WITHOUT embedding yet. The embedding cost must be
    // provisioned + authorized before any Gemini call.
    const cached = await db
      .select()
      .from(brandProfileEmbeddings)
      .where(
        and(
          eq(brandProfileEmbeddings.orgId, orgId),
          eq(brandProfileEmbeddings.brandId, brandCacheKey),
          eq(brandProfileEmbeddings.contentHash, hash),
        ),
      )
      .limit(1);
    const cacheHit = cached.length > 0;

    const docTexts = documents.map((d) => d.text);
    // Tokens are known from the inputs: the query embeds only on a cache miss; docs always.
    const embedInputTokens =
      (cacheHit ? 0 : estimateTokens([queryText])) + estimateTokens(docTexts);

    // PROVISION (runs ledger) → AUTHORIZE (billing, platform keys) BEFORE the Gemini spend.
    try {
      provisionedCostId = await provisionAndAuthorizeEmbeddingCost({
        runId,
        inputTokens: embedInputTokens,
        keySource: resolvedKey.keySource,
        identity: { orgId, userId, runId },
        trackingHeaders,
        description: `rag-score — ${DEFAULT_EMBEDDING_MODEL}`,
      });
    } catch (costErr) {
      scoreFailed = true;
      const r = costErrorResponse(costErr, "rag-score", orgId);
      return res.status(r.status).json(r.body);
    }

    // EXECUTE — embed now that the cost is provisioned + authorized.
    let queryEmbedding: number[];
    if (cacheHit) {
      queryEmbedding = cached[0].embedding;
    } else {
      queryEmbedding = await embedText(resolvedKey.key, queryText);
      // Race-safe insert: another concurrent request may have already populated it.
      await db
        .insert(brandProfileEmbeddings)
        .values({
          orgId,
          brandId: brandCacheKey,
          contentHash: hash,
          queryText,
          embedding: queryEmbedding,
          model: DEFAULT_EMBEDDING_MODEL,
        })
        .onConflictDoNothing({
          target: [
            brandProfileEmbeddings.orgId,
            brandProfileEmbeddings.brandId,
            brandProfileEmbeddings.contentHash,
          ],
        });
    }

    const docEmbeddings = await embedTexts(resolvedKey.key, docTexts);

    // Score
    const scored = documents.map((d, i) => {
      const raw = cosineSimilarity(queryEmbedding, docEmbeddings[i]);
      // Clamp negatives to 0 so consumers can treat the score as a [0, 1] confidence.
      const score = raw < 0 ? 0 : raw;
      return { id: d.id, score };
    });
    scored.sort((a, b) => b.score - a.score);

    // ACTUALIZE the provisioned cost. Fail loud on failure, but leave the row
    // `provisioned` — the embedding already happened, so never cancel a paid spend.
    if (provisionedCostId) {
      try {
        await updateRunCostStatus(
          runId,
          provisionedCostId,
          "actual",
          { orgId, userId, runId },
          trackingHeaders,
        );
      } catch (actErr) {
        scoreFailed = true;
        provisionedCostId = null;
        console.error(`[rag-score] cost actualize failed runId="${runId}" orgId="${orgId}":`, actErr);
        return res.status(502).json({ error: "Cost finalization failed. Please try again." });
      }
      provisionedCostId = null;
    }

    if (runId) {
      traceEvent(runId, "rag-score-done", { orgId, userId }, workflowTracking, {
        data: {
          brandIds,
          documentCount: documents.length,
          cacheHit,
          model: DEFAULT_EMBEDDING_MODEL,
        },
      });
    }

    res.json({
      brandIds,
      // Echo legacy `brandId` only when exactly one brand was resolved, so existing
      // single-brand consumers keep the same response shape byte-for-byte.
      ...(isSingleBrand ? { brandId: brandIds[0] } : {}),
      queryText,
      cacheHit,
      model: DEFAULT_EMBEDDING_MODEL,
      results: scored,
    });
  } catch (err) {
    scoreFailed = true;
    // Embedding/scoring threw AFTER provisioning → release the reservation (no spend completed).
    if (runId && provisionedCostId) {
      await updateRunCostStatus(
        runId,
        provisionedCostId,
        "cancelled",
        { orgId, userId, runId },
        trackingHeaders,
      ).catch((cancelErr) =>
        console.error(`[rag-score] cost cancel failed runId="${runId}" orgId="${orgId}":`, cancelErr),
      );
      provisionedCostId = null;
    }
    console.error(`[rag-score] org="${orgId}" brands="${brandCacheKey}" error:`, err);
    if (runId) {
      traceEvent(runId, "rag-score-failed", { orgId, userId }, workflowTracking, {
        level: "error",
        detail: err instanceof Error ? err.message : String(err),
        data: { brandIds },
      });
    }
    res.status(502).json({
      error: "RAG score failed. Please try again.",
    });
  } finally {
    // Costs are provisioned/actualized/cancelled inline above — the finally only
    // closes the run status (best-effort run tracking, distinct from cost integrity).
    if (runId) {
      try {
        await updateRunStatus(
          runId,
          scoreFailed ? "failed" : "completed",
          { orgId, userId, runId },
          trackingHeaders,
        );
      } catch (runErr) {
        console.error(
          `[rag-score] failed to finalize run runId="${runId}" orgId="${orgId}":`,
          runErr,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// POST /orgs/rag/embed — return raw embedding vectors for a batch of texts.
// Used by callers that need to run their own similarity / clustering / dedup
// (e.g. journalists-quotes-service cross-platform opportunity dedup pipeline).
// Same auth + run-tracking shape as /orgs/rag/score, but no brand resolution
// and no caching — callers persist vectors themselves.
// ---------------------------------------------------------------------------

app.post("/orgs/rag/embed", requireAuth, async (req, res) => {
  const { orgId, userId, parentRunId, workflowTracking } = res.locals as AuthLocals;

  const trackingHeaders: Record<string, string> = {};
  if (workflowTracking.campaignId) trackingHeaders["x-campaign-id"] = workflowTracking.campaignId;
  if (workflowTracking.brandId) trackingHeaders["x-brand-id"] = workflowTracking.brandId;
  if (workflowTracking.workflowSlug) trackingHeaders["x-workflow-slug"] = workflowTracking.workflowSlug;
  if (workflowTracking.featureSlug) trackingHeaders["x-feature-slug"] = workflowTracking.featureSlug;

  const parsed = RagEmbedRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid request", details: parsed.error.flatten() });
  }
  const { documents } = parsed.data;

  // Register run (mandatory)
  let runId: string | null = null;
  try {
    const run = await createRun(
      { serviceName: "chat-service", taskName: "rag-embed" },
      { orgId, userId, runId: parentRunId },
      trackingHeaders,
    );
    runId = run.id;
    traceEvent(runId, "run-created", { orgId, userId }, workflowTracking, {
      data: { taskName: "rag-embed", parentRunId, documentCount: documents.length },
    });
  } catch (runErr) {
    console.error(`[rag-embed] org="${orgId}" run creation failed:`, runErr);
    return res.status(502).json({
      error: "Service temporarily unavailable (run tracking). Please try again.",
    });
  }

  let embedFailed = false;
  // Embedding cost is provisioned before the Gemini call and actualized/cancelled
  // after. Hoisted so the catch can release (cancel) a provision if the embed throws.
  let provisionedCostId: string | null = null;
  try {
    let resolvedKey;
    try {
      resolvedKey = await resolveKey({
        provider: "google",
        orgId,
        userId,
        runId,
        caller: { method: "POST", path: "/orgs/rag/embed" },
        trackingHeaders,
      });
    } catch (err) {
      console.error(`[rag-embed] Failed to resolve google key for org="${orgId}":`, err);
      return res.status(502).json({
        error: "Failed to resolve google API key. Ensure the key is configured in key-service.",
      });
    }
    const docTexts = documents.map((d) => d.text);
    const embedInputTokens = estimateTokens(docTexts);

    // PROVISION (runs ledger) → AUTHORIZE (billing, platform keys) BEFORE the Gemini spend.
    try {
      provisionedCostId = await provisionAndAuthorizeEmbeddingCost({
        runId,
        inputTokens: embedInputTokens,
        keySource: resolvedKey.keySource,
        identity: { orgId, userId, runId },
        trackingHeaders,
        description: `rag-embed — ${DEFAULT_EMBEDDING_MODEL}`,
      });
    } catch (costErr) {
      embedFailed = true;
      const r = costErrorResponse(costErr, "rag-embed", orgId);
      return res.status(r.status).json(r.body);
    }

    // EXECUTE — embed now that the cost is provisioned + authorized.
    const docEmbeddings = await embedTexts(resolvedKey.key, docTexts);

    if (docEmbeddings.length !== documents.length) {
      throw new Error(
        `[rag-embed] embedTexts returned ${docEmbeddings.length} vectors for ${documents.length} inputs`,
      );
    }

    const results = documents.map((d, i) => ({
      id: d.id,
      embedding: docEmbeddings[i],
    }));

    // ACTUALIZE the provisioned cost. Fail loud on failure, but leave the row
    // `provisioned` — the embedding already happened, so never cancel a paid spend.
    if (provisionedCostId) {
      try {
        await updateRunCostStatus(
          runId,
          provisionedCostId,
          "actual",
          { orgId, userId, runId },
          trackingHeaders,
        );
      } catch (actErr) {
        embedFailed = true;
        provisionedCostId = null;
        console.error(`[rag-embed] cost actualize failed runId="${runId}" orgId="${orgId}":`, actErr);
        return res.status(502).json({ error: "Cost finalization failed. Please try again." });
      }
      provisionedCostId = null;
    }

    if (runId) {
      traceEvent(runId, "rag-embed-done", { orgId, userId }, workflowTracking, {
        data: {
          documentCount: documents.length,
          model: DEFAULT_EMBEDDING_MODEL,
          dimensions: results[0]?.embedding.length ?? 0,
        },
      });
    }

    res.json({
      model: DEFAULT_EMBEDDING_MODEL,
      results,
    });
  } catch (err) {
    embedFailed = true;
    // Embedding threw AFTER provisioning → release the reservation (no spend completed).
    if (runId && provisionedCostId) {
      await updateRunCostStatus(
        runId,
        provisionedCostId,
        "cancelled",
        { orgId, userId, runId },
        trackingHeaders,
      ).catch((cancelErr) =>
        console.error(`[rag-embed] cost cancel failed runId="${runId}" orgId="${orgId}":`, cancelErr),
      );
      provisionedCostId = null;
    }
    console.error(`[rag-embed] org="${orgId}" error:`, err);
    if (runId) {
      traceEvent(runId, "rag-embed-failed", { orgId, userId }, workflowTracking, {
        level: "error",
        detail: err instanceof Error ? err.message : String(err),
        data: { documentCount: documents.length },
      });
    }
    res.status(502).json({
      error: "RAG embed failed. Please try again.",
    });
  } finally {
    // Costs are provisioned/actualized/cancelled inline above — the finally only
    // closes the run status (best-effort run tracking, distinct from cost integrity).
    if (runId) {
      try {
        await updateRunStatus(
          runId,
          embedFailed ? "failed" : "completed",
          { orgId, userId, runId },
          trackingHeaders,
        );
      } catch (runErr) {
        console.error(
          `[rag-embed] failed to finalize run runId="${runId}" orgId="${orgId}":`,
          runErr,
        );
      }
    }
  }
});

// --- Internal Platform Complete (platform run tracking + cost, no org billing) ---

app.post("/internal/platform-complete", requireInternalAuth, async (req, res) => {
  const parsed = InternalPlatformCompleteRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  const { message, systemPrompt, responseFormat, responseSchema, temperature, provider: requestedProvider, model: requestedModel, webSearch: webSearchRaw } = parsed.data;
  const webSearch = webSearchRaw === true;

  const resolved = resolveModel(requestedProvider as Provider, requestedModel as ModelAlias);
  const effectiveModel = resolved.apiModelId;
  const isGemini = resolved.provider === "google";
  const provider = resolved.provider;
  const costPrefix = resolved.costPrefix;
  // Native web-search cost name (byte-equal to costs-service catalog) — only when opted in.
  const searchCostName = webSearch ? webSearchCostName(isGemini) : undefined;

  // Passing a responseSchema implies JSON-mode parsing of the response.
  const jsonMode = responseFormat === "json" || responseSchema != null;

  // Anthropic JSON mode requires `responseSchema` — see /complete for rationale.
  if (provider === "anthropic" && responseFormat === "json" && responseSchema == null) {
    return res.status(400).json({
      error:
        "Anthropic JSON mode requires responseSchema. Per Anthropic API, JSON output is only enforceable via output_config.format with a JSON Schema. Supply responseSchema in the request body.",
    });
  }

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

  // Create a platform run so LLM (and web-search) spend is declared. Platform
  // key spend, no org → costSource "platform", no affordability authorize. Fail
  // loud — a cost that can't be tracked must block the op, not silently spend.
  let runId: string;
  try {
    const run = await createPlatformRun({ serviceName: "chat-service", taskName: "platform-complete" });
    runId = run.id;
  } catch (runErr) {
    console.error(`[internal/platform-complete] platform-run creation failed:`, runErr);
    return res.status(502).json({
      error: "Service temporarily unavailable (run tracking). Please try again.",
    });
  }

  let platformFailed = false;
  try {
    let result: { content: string; tokensInput: number; tokensOutput: number; model: string; searchCount: number; sources: Array<{ url: string; title?: string }> };

    if (isGemini) {
      result = await completeWithGemini({
        apiKey,
        model: effectiveModel,
        message,
        systemPrompt,
        responseFormat,
        responseSchema,
        temperature,
        webSearch,
      });
    } else {
      const claude = createAnthropicClient({ apiKey, systemPrompt });
      result = await claude.complete(message, {
        responseFormat,
        responseSchema,
        temperature,
        model: effectiveModel,
        webSearch,
      });
    }

    // Declare ACTUAL costs on the platform run BEFORE responding. Platform runs
    // have no cost-status PATCH, so there is no provision/cancel — costs are
    // posted as `actual` post-call. Throws (fail loud → 502) if undeclarable.
    const costItems: CostItem[] = [
      ...(result.tokensInput > 0
        ? [{ costName: `${costPrefix}-tokens-input`, quantity: result.tokensInput, costSource: "platform" as const }]
        : []),
      ...(result.tokensOutput > 0
        ? [{ costName: `${costPrefix}-tokens-output`, quantity: result.tokensOutput, costSource: "platform" as const }]
        : []),
      ...(searchCostName && result.searchCount > 0
        ? [{ costName: searchCostName, quantity: result.searchCount, costSource: "platform" as const }]
        : []),
    ];
    await addPlatformRunCosts(runId, "chat-service", costItems);

    const response: Record<string, unknown> = {
      content: jsonMode ? result.content : appendSources(result.content, result.sources),
      tokensInput: result.tokensInput,
      tokensOutput: result.tokensOutput,
      model: result.model,
    };

    // Strict parse — provider-side enforcement guarantees valid JSON.
    if (jsonMode) {
      response.json = JSON.parse(result.content);
    }

    res.json(response);
  } catch (err) {
    platformFailed = true;
    console.error(`[internal/platform-complete] LLM call failed:`, err);
    res.status(502).json({
      error: "LLM call failed. Please try again.",
    });
  } finally {
    try {
      await updatePlatformRunStatus(runId, "chat-service", platformFailed ? "failed" : "completed");
    } catch (statusErr) {
      console.error(`[internal/platform-complete] failed to finalize platform run runId="${runId}":`, statusErr);
    }
  }
});

// --- Chat ---

app.post("/chat", requireAuth, async (req, res) => {
  const { orgId, userId, parentRunId, workflowTracking } = res.locals as AuthLocals;

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

  // Resolve provider/model from config (NULL = default: google/pro — Gemini is
  // the platform default; the Anthropic platform key has no credit balance).
  const { provider: chatProvider, modelAlias: chatModelAlias } = resolveChatProviderModel(appConfig);
  const resolvedModelInfo = resolveModel(chatProvider, chatModelAlias);

  // Resolve API key for the configured provider
  let resolvedKey: ResolvedKey;
  try {
    resolvedKey = await resolveKey({
      provider: resolvedModelInfo.provider,
      orgId,
      userId,
      runId: parentRunId,
      caller: { method: "POST", path: "/chat" },
      trackingHeaders,
    });
  } catch (err) {
    console.error(`Failed to resolve ${resolvedModelInfo.provider} key for org="${orgId}":`, err);
    return res.status(502).json({
      error: `Failed to resolve ${resolvedModelInfo.provider} API key. Ensure the key is configured in key-service.`,
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
          { costName: `${resolvedModelInfo.costPrefix}-tokens-input`, quantity: estimatedInputTokens },
          { costName: `${resolvedModelInfo.costPrefix}-tokens-output`, quantity: estimatedOutputTokens },
        ],
        description: `chat — ${resolvedModelInfo.apiModelId}`,
        orgId,
        userId,
        runId: parentRunId,
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
        { orgId, userId, runId: parentRunId, trackingHeaders },
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
  const isGeminiChat = chatProvider === "google";
  const claude = isGeminiChat ? null : createAnthropicClient({ apiKey: resolvedKey.key, systemPrompt });

  let runId: string | null = null;
  let chatFailed = false;
  let totalPromptTokens = 0;
  let totalOutputTokens = 0;
  let provisionedCostIds: string[] = [];

  try {
    // Get or create session (scoped by org + user + app)
    let currentSessionId = sessionId;
    // Resolve brand UUIDs for this turn. Header CSV first, fall back to context.brandId.
    const brandIds: string[] = workflowTracking.brandId
      ? workflowTracking.brandId.split(",").map((s) => s.trim()).filter(Boolean)
      : typeof context?.brandId === "string" && context.brandId
        ? [context.brandId]
        : [];
    if (!currentSessionId) {
      const [session] = await db
        .insert(sessions)
        .values({
          orgId,
          userId,
          parentRunId,
          campaignId: workflowTracking.campaignId ?? null,
          brandIds: brandIds.length > 0 ? brandIds : null,
          workflowSlug: workflowTracking.workflowSlug ?? null,
          featureSlug: workflowTracking.featureSlug ?? null,
        })
        .returning();
      currentSessionId = session.id;
    } else {
      // Validate session ownership
      const [existing] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, currentSessionId));
      if (!existing || existing.orgId !== orgId) {
        sendSSE(res, SESSION_NOT_FOUND_EVENT);
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
        { orgId, userId, runId: parentRunId },
        trackingHeaders,
      );
      runId = run.id;
      traceEvent(runId, "run-created", { orgId, userId }, workflowTracking, {
        data: {
          taskName: "chat",
          parentRunId,
          sessionId: currentSessionId,
          provider: chatProvider,
          model: resolvedModelInfo.apiModelId,
          configKey,
        },
      });
      // Update session with this service's run ID
      await db.update(sessions)
        .set({ runId, updatedAt: new Date() })
        .where(eq(sessions.id, currentSessionId));
    } catch (runErr) {
      console.error(`[chat] session="${currentSessionId}" run creation failed:`, runErr);
      sendSSE(res, {
        type: "error",
        code: "internal_error",
        message: "Service temporarily unavailable (run tracking). Please try again.",
      });
      sendSSE(res, "[DONE]");
      res.end();
      return;
    }

    // PROVISION worst-case LLM cost (input estimate + output budget) before the model
    // call. Authorize already ran pre-stream above; output tokens are unknown until the
    // stream ends, so reserve the max and true up to actual in the finally. Fail loud
    // (SSE error — the stream is already open) if the cost can't be declared.
    try {
      provisionedCostIds = await provisionLlmCost({
        runId,
        costPrefix: resolvedModelInfo.costPrefix,
        inputTokens: Math.max(Math.ceil(message.length / 4), 500),
        outputTokens: 64_000,
        keySource: resolvedKey.keySource,
        identity: { orgId, userId, runId },
        trackingHeaders,
      });
    } catch (provErr) {
      chatFailed = true;
      console.error(`[chat] cost provision failed runId="${runId}" org="${orgId}":`, provErr);
      sendSSE(res, {
        type: "error",
        code: "internal_error",
        message: "Cost provisioning failed. Please try again.",
      });
      sendSSE(res, "[DONE]");
      res.end();
      return;
    }

    // Load conversation history (shared by both providers)
    const history = await db.query.messages.findMany({
      where: eq(messages.sessionId, currentSessionId),
      orderBy: (m, { asc }) => [asc(m.createdAt)],
    });

    // Save user message
    await db.insert(messages).values({
      sessionId: currentSessionId,
      role: "user",
      content: message.trim(),
    });

    // Shared state for both providers
    let fullResponse = "";
    let emittedInputRequest = false;
    const toolCalls: ToolCallRecord[] = [];
    let lastContentBlocks: Anthropic.ContentBlock[] = [];
    // Track workflows forked during this turn (used by executeTool)
    const forkedWorkflowMap = new Map<string, string>();

    // Anthropic-specific: line buffer for button detection during streaming
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

      // Built-in workflow write tools: create / upgrade / fork
      if (
        call.name === "create_workflow" ||
        call.name === "upgrade_workflow" ||
        call.name === "fork_workflow"
      ) {
        const wfParams = {
          orgId,
          userId,
          runId: runId!,
          trackingHeaders: Object.keys(trackingHeaders).length > 0 ? trackingHeaders as Record<string, string> : undefined,
        };
        const args = (call.args as Record<string, unknown>) || {};
        let result: unknown;

        if (call.name === "create_workflow") {
          result = await createWorkflow(
            args as unknown as import("./lib/workflow-client.js").CreateWorkflowBody,
            wfParams,
          );
        } else if (call.name === "upgrade_workflow") {
          result = await upgradeWorkflow(
            args as unknown as import("./lib/workflow-client.js").UpgradeWorkflowBody,
            wfParams,
          );
        } else {
          // fork_workflow
          const { workflowId: rawWorkflowId, dag } = args;
          // Redirect to the already-forked workflow if the LLM tries to
          // fork the same source workflow again in this turn.
          const effectiveWorkflowId =
            forkedWorkflowMap.get(rawWorkflowId as string) ?? (rawWorkflowId as string);
          const wasRedirected = effectiveWorkflowId !== (rawWorkflowId as string);
          if (wasRedirected) {
            console.log(
              `[chat] Redirecting fork_workflow from already-forked source "${rawWorkflowId}" → "${effectiveWorkflowId}"`,
            );
          }
          try {
            const forkResult = await forkWorkflow(
              effectiveWorkflowId,
              { dag: dag as import("./lib/workflow-client.js").DAG },
              wfParams,
            );
            if (forkResult.outcome === "forked") {
              const forkedFrom = forkResult.workflow._forkedFromName || rawWorkflowId;
              forkedWorkflowMap.set(rawWorkflowId as string, forkResult.workflow.id);
              result = {
                ...forkResult.workflow,
                _note: `This is a NEW workflow forked from "${forkedFrom}". Tell the user: "Your customized workflow is ready: ${forkResult.workflow.name || forkResult.workflow.signatureName || forkResult.workflow.id}. Use this name for future campaigns."`,
              };
            } else {
              result = {
                ...forkResult.workflow,
                _note:
                  "No fork created — the submitted DAG has the same signature as the source workflow. The workflow is unchanged.",
              };
            }
          } catch (err: unknown) {
            const is409 =
              err instanceof Error && err.message.includes("signature already exists");
            if (is409) {
              console.log(
                `[chat] fork_workflow 409 on "${effectiveWorkflowId}" — another workflow already has this DAG, returning current state`,
              );
              const current = await getWorkflow(effectiveWorkflowId, wfParams);
              result = {
                ...current,
                _note: "No changes needed — a workflow with this DAG already exists.",
              };
            } else {
              throw err;
            }
          }
        }

        toolCalls.push({ name: call.name, args, result });
        return { name: call.name, result };
      }

      // Built-in workflow validate tool
      if (call.name === "validate_workflow") {
        const wfParams = {
          orgId,
          userId,
          runId: runId!,
          trackingHeaders: Object.keys(trackingHeaders).length > 0 ? trackingHeaders as Record<string, string> : undefined,
        };
        const args = (call.args as Record<string, unknown>) || {};
        const result = await validateWorkflow(args.workflowId as string, wfParams);

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
            variables: args.variables as Array<{ name: string; description: string }>,
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
        if (brandIds.length === 0) {
          throw new Error(
            "[chat] prefill_feature requires brandIds — provide x-brand-id header or context.brandId",
          );
        }
        const result = await prefillFeature(args.slug as string, brandIds, featureCallParams);
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
        if (brandIds.length === 0) {
          throw new Error(
            "[chat] extract_brand_fields requires brandIds — provide x-brand-id header or context.brandId",
          );
        }
        const result = await extractBrandFields(
          args.fields as Array<{ key: string; description: string }>,
          brandIds,
          featureCallParams,
        );
        toolCalls.push({ name: call.name, args, result });
        return { name: call.name, result };
      }

      if (call.name === "browse_url") {
        const args = (call.args as Record<string, unknown>) || {};
        const result = await scrapeUrl(
          args.url as string,
          featureCallParams,
        );
        toolCalls.push({ name: call.name, args, result });
        return { name: call.name, result };
      }

      return null;
    }

    // -----------------------------------------------------------------------
    // Agentic loop: stream → handle tools → repeat
    // Provider-specific: Gemini uses streamGeminiChat(), Anthropic uses SDK
    // -----------------------------------------------------------------------

    if (runId) {
      traceEvent(runId, "stream-start", { orgId, userId }, workflowTracking, {
        data: {
          provider: chatProvider,
          model: resolvedModelInfo.apiModelId,
          historyLength: history.length,
          toolCount: allTools.length,
        },
      });
    }

    if (isGeminiChat) {
      // --- Gemini streaming path ---
      const geminiToolDefs: ToolDefinition[] = allTools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        input_schema: t.input_schema as ToolDefinition["input_schema"],
      }));

      const plainHistory = history
        .filter((m) => m.role !== "tool")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content as string,
          toolCalls: m.toolCalls,
        }));

      const geminiResult = await streamGeminiChat({
        apiKey: resolvedKey.key,
        model: resolvedModelInfo.apiModelId,
        systemPrompt,
        history: plainHistory,
        userMessage: message.trim(),
        tools: geminiToolDefs,
        res,
        sendSSE,
        executeTool,
        signal: abortController.signal,
      });

      fullResponse = geminiResult.fullResponse;
      emittedInputRequest = geminiResult.emittedInputRequest;
      toolCalls.push(...geminiResult.toolCalls);
      totalPromptTokens = geminiResult.tokensInput;
      totalOutputTokens = geminiResult.tokensOutput;

      // Shared post-processing: buttons, empty response check, save message
      // (no line buffering for Gemini — tokens are streamed directly)

    } else {
    // --- Anthropic streaming path ---

    // Build Anthropic message history — restore tool_use + tool_result pairs
    // from `toolCalls` jsonb so multi-turn agentic memory survives across turns.
    const rebuildable: RebuildableMessage[] = history.map((m) => ({
      role: m.role as RebuildableMessage["role"],
      content: m.content as string,
      toolCalls: m.toolCalls,
    }));
    const anthropicHistory = mergeConsecutiveMessages(
      rebuildAnthropicHistory(rebuildable),
    );

    const turnMessages: Anthropic.MessageParam[] = [
      ...anthropicHistory,
      { role: "user", content: message.trim() },
    ];

    const MAX_TOOL_CHAIN_DEPTH = 10;
    let depth = 0;

    agenticLoop:
    while (depth <= MAX_TOOL_CHAIN_DEPTH) {
      // Abort early if client already disconnected
      if (abortController.signal.aborted) {
        console.log(`[chat] session="${currentSessionId}" aborted before depth=${depth}`);
        break;
      }

      let currentBlockType: string | null = null;
      let stream: ReturnType<NonNullable<typeof claude>["createStream"]> | undefined;
      let tokensEmitted = false;

      // Retry loop for transient Anthropic errors (overloaded, 429, 5xx).
      // Only retries when no tokens have been sent to the client yet.
      for (let attempt = 0; attempt <= ANTHROPIC_STREAM_MAX_RETRIES; attempt++) {
        tokensEmitted = false;
        currentBlockType = null;
        stream = claude!.createStream(turnMessages, allTools, abortController.signal);

        try {
          for await (const event of stream) {
            if (event.type === "content_block_start") {
              currentBlockType = event.content_block.type;
              if (currentBlockType === "thinking") {
                sendSSE(res, { type: "thinking_start" });
                tokensEmitted = true;
              }
            } else if (event.type === "content_block_delta") {
              if (event.delta.type === "thinking_delta") {
                sendSSE(res, { type: "thinking_delta", thinking: event.delta.thinking });
                tokensEmitted = true;
              } else if (event.delta.type === "text_delta") {
                bufferToken(event.delta.text);
                tokensEmitted = true;
              }
            } else if (event.type === "content_block_stop") {
              if (currentBlockType === "thinking") {
                sendSSE(res, { type: "thinking_stop" });
              }
              currentBlockType = null;
            }
          }
          break; // Stream completed successfully — exit retry loop
        } catch (streamErr) {
          // If aborted due to client disconnect, exit cleanly
          if (abortController.signal.aborted) {
            console.log(`[chat] session="${currentSessionId}" stream aborted (client disconnect)`);
            return;
          }
          // Only retry if: (a) retryable error, (b) no tokens emitted yet, (c) retries left
          if (
            !tokensEmitted &&
            isRetryableAnthropicError(streamErr) &&
            attempt < ANTHROPIC_STREAM_MAX_RETRIES
          ) {
            const retryAfter = getRetryAfterMs(streamErr);
            const delay = retryAfter ?? (ANTHROPIC_STREAM_RETRY_BASE_MS * 2 ** attempt + Math.random() * 500);
            console.warn(
              `[chat] Anthropic stream retry ${attempt + 1}/${ANTHROPIC_STREAM_MAX_RETRIES} ` +
                `after ${Math.round(delay)}ms | session="${currentSessionId}" org="${orgId}" | ` +
                `error=${streamErr instanceof Error ? streamErr.message : String(streamErr)}`,
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          throw streamErr; // Non-retryable or tokens already emitted — propagate
        }
      }

      const finalMessage = await stream!.finalMessage();
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

    // Finalize Anthropic line buffer
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

    } // end else (Anthropic path)

    // -----------------------------------------------------------------------
    // Shared post-processing (both providers)
    // -----------------------------------------------------------------------

    console.log(`[chat] session="${currentSessionId}" stream complete — provider=${chatProvider} tokens=${totalPromptTokens}+${totalOutputTokens} response=${fullResponse.length}chars`);

    // Process held content as buttons (Anthropic buffer or raw Gemini response)
    const BUTTON_LINE_RE = /^[-*]\s*\[.+?\]\s*$/;
    const trailingButtonLines: string[] = [];
    const responseLines = fullResponse.split("\n");
    for (let i = responseLines.length - 1; i >= 0; i--) {
      if (BUTTON_LINE_RE.test(responseLines[i].trim())) {
        trailingButtonLines.unshift(responseLines[i]);
      } else if (trailingButtonLines.length > 0) {
        break;
      } else if (responseLines[i].trim() !== "") {
        break;
      }
    }
    const buttons: ButtonRecord[] = trailingButtonLines.length > 0
      ? extractButtons(trailingButtonLines.join("\n"))
      : [];
    if (buttons.length > 0) {
      sendSSE(res, { type: "buttons", buttons });
    }

    // Detect empty stream
    if (!fullResponse && !emittedInputRequest && toolCalls.length === 0) {
      chatFailed = true;
      console.error(
        `Empty ${chatProvider} response for session="${currentSessionId}" org="${orgId}" — ` +
          `promptTokens=${totalPromptTokens} outputTokens=${totalOutputTokens} ` +
          `historyLength=${history.length} messageLength=${message.length}`,
      );
      sendSSE(res, {
        type: "error",
        code: "model_error",
        message:
          "The AI model returned an empty response. This may happen when the conversation " +
          "is too long or the message content triggers a safety filter. Please try shortening " +
          "your message or starting a new conversation.",
      });
      sendSSE(res, "[DONE]");
      return;
    }

    // Save assistant message with cleaned response + content blocks for compaction
    const cleanedResponse =
      buttons.length > 0 ? stripButtons(fullResponse) : fullResponse;
    // Content blocks are Anthropic-specific (compaction). Gemini stores null.
    const persistBlocks = (!isGeminiChat && lastContentBlocks.length > 0)
      ? stripToolUseBlocks(lastContentBlocks as Anthropic.ContentBlockParam[])
      : [];
    await db.insert(messages).values({
      sessionId: currentSessionId,
      role: "assistant",
      content: cleanedResponse,
      contentBlocks: persistBlocks.length > 0 ? persistBlocks : null,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      buttons: buttons.length > 0 ? buttons : null,
      tokenCount: totalPromptTokens + totalOutputTokens || null,
    });

    sendSSE(res, buildContextUsageEvent({
      inputTokens: totalPromptTokens,
      outputTokens: totalOutputTokens,
    }));

    if (runId) {
      traceEvent(runId, "stream-done", { orgId, userId }, workflowTracking, {
        data: {
          provider: chatProvider,
          model: resolvedModelInfo.apiModelId,
          tokensInput: totalPromptTokens,
          tokensOutput: totalOutputTokens,
          toolCallCount: toolCalls.length,
          buttonCount: buttons.length,
        },
      });
    }

    sendSSE(res, "[DONE]");
  } catch (err) {
    chatFailed = true;
    const { message: errorMessage, code: errorCode } = classifyErrorForClient(err);
    console.error(`[chat] org="${orgId}" error code="${errorCode}":`, err);
    if (runId) {
      traceEvent(runId, "stream-failed", { orgId, userId }, workflowTracking, {
        level: "error",
        detail: err instanceof Error ? err.message : String(err),
        data: {
          provider: chatProvider,
          model: resolvedModelInfo.apiModelId,
          code: errorCode,
        },
      });
    }
    sendSSE(res, {
      type: "error",
      code: errorCode,
      message: errorMessage,
    });
    sendSSE(res, "[DONE]");
  } finally {
    // End SSE stream immediately so the client is not blocked
    res.end();

    // Reconcile: record ACTUAL real tokens, then release the provisioned worst-case holds.
    // If the actual POST fails, the provisioned-max rows stay as a fallback record — the
    // cost is never silently lost.
    if (runId) {
      const costSource: "platform" | "org" =
        resolvedKey.keySource === "org" ? "org" : "platform";
      const chatCostPrefix = resolvedModelInfo.costPrefix;
      const actualItems = [
        ...(totalPromptTokens > 0
          ? [{ costName: `${chatCostPrefix}-tokens-input`, quantity: totalPromptTokens, costSource }]
          : []),
        ...(totalOutputTokens > 0
          ? [{ costName: `${chatCostPrefix}-tokens-output`, quantity: totalOutputTokens, costSource }]
          : []),
      ];
      const runIdentity = { orgId, userId, runId };
      try {
        await updateRunStatus(runId, chatFailed ? "failed" : "completed", runIdentity, trackingHeaders);
      } catch (runErr) {
        console.error(`[chat-service] /chat failed to finalize run runId="${runId}" orgId="${orgId}":`, runErr);
      }
      if (provisionedCostIds.length > 0) {
        try {
          if (actualItems.length > 0) {
            await addRunCosts(runId, actualItems, runIdentity, trackingHeaders);
          }
          await cancelProvisionedCosts(runId, provisionedCostIds, runIdentity, trackingHeaders);
        } catch (costErr) {
          console.error(`[chat] cost reconcile failed runId="${runId}" — provisioned-max kept as fallback:`, costErr);
        }
      }
    }
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

// --- Internal: Transfer Brand ---

app.post("/internal/transfer-brand", requireInternalAuth, async (req, res) => {
  const parsed = TransferBrandRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: "Invalid request", details: parsed.error.flatten() });
  }

  const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = parsed.data;

  // Step 1: Move solo-brand sessions to target org
  const moveResult = await db.execute(sql`
    UPDATE sessions
    SET org_id = ${targetOrgId}, updated_at = NOW()
    WHERE org_id = ${sourceOrgId}
      AND brand_ids = ARRAY[${sourceBrandId}]::text[]
  `) as unknown as { rowCount: number };

  const updatedCount = moveResult.rowCount ?? 0;

  // Step 2: Rewrite brand reference (no org_id filter — catches all remaining references)
  if (targetBrandId) {
    await db.execute(sql`
      UPDATE sessions
      SET brand_ids = ARRAY[${targetBrandId}]::text[], updated_at = NOW()
      WHERE brand_ids = ARRAY[${sourceBrandId}]::text[]
    `);
  }

  console.log(
    `[chat-service] transfer-brand: sourceBrandId="${sourceBrandId}" targetBrandId="${targetBrandId ?? "same"}" from="${sourceOrgId}" to="${targetOrgId}" sessions=${updatedCount}`,
  );

  res.json({
    updatedTables: [{ tableName: "sessions", count: updatedCount }],
  });
});

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
