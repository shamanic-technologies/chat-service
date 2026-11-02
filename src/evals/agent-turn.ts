// ---------------------------------------------------------------------------
// One replayed turn: the agent definition + a scenario → the prompt, the tools
// and the history the model reads, assembled with the SAME builders /chat uses
// (skill index, our-website identity line, WhatsApp channel block, page
// context), then run through the real tool loop of the model's provider.
//
// Tools are answered from the scenario (fixture-tools.ts): nothing reaches a
// client account, nothing is sent, started or written.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Response as ExpressResponse } from "express";
import { z } from "zod";
import { withAccountSetup } from "../lib/account-setup.js";
import { buildSystemPrompt, resolveModel, resolveToolSet, type ModelAlias, type Provider } from "../lib/anthropic.js";
import { buildChannelBlock } from "../lib/channel-copilot.js";
import type { ToolDefinition, ToolExecutor } from "../lib/gemini-chat.js";
import { modelDisplayName } from "../lib/model-ids.js";
import { isVendorProvider, type VendorId } from "../lib/openai-compatible.js";
import { aboutYouBlock, withOurWebsite } from "../lib/person-facing.js";
import { skillIndexBlockFrom } from "../lib/skills.js";
import { streamVendorChat } from "../lib/vendor-chat.js";
import type { VendorCostLine } from "../lib/cost-names.js";
import { buildSituationBrief } from "../agent/situation.js";
import { SOPHIE_MODEL, SOPHIE_SYSTEM_PROMPT, SOPHIE_TOOLS } from "../agent/sophie.js";
import { clientBriefUnavailable } from "../lib/client-brief.js";
import { fixtureClientBrief, fixtureSituationReader } from "./fixture-situation.js";
import type { Scenario } from "./scenario.js";

export const AgentDefinitionSchema = z
  .object({
    id: z.string().min(1),
    note: z.string().optional(),
    provider: z.string().min(1),
    model: z.string().min(1),
    thinkingLevel: z.string().nullable().optional(),
    effort: z.string().nullable().optional(),
    systemPrompt: z.string().min(1),
    allowedTools: z.array(z.string().min(1)),
    /** The turn's context carries the client brief (client-brief.ts, SOPHIE-JCURVE-1102). */
    clientBrief: z.boolean().optional(),
    /** The turn's context carries the situation brief (SOPHIE-REFONTE-1102 P1). */
    situationBrief: z.boolean().optional(),
    skills: z.array(
      z
        .object({
          slug: z.string().min(1),
          parentSlug: z.string().nullable(),
          title: z.string(),
          description: z.string(),
          content: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export function loadDefinition(path: string): AgentDefinition {
  return AgentDefinitionSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * What decides the agent's behaviour, hashed: a passing eval run is valid only
 * for the definition it ran on (the merge gate compares this hash).
 */
export function definitionHash(def: AgentDefinition, model: string = `${def.provider}/${def.model}`): string {
  const { id: _id, note: _note, ...behaviour } = def;
  return createHash("sha256").update(JSON.stringify({ ...behaviour, model })).digest("hex").slice(0, 16);
}

/** The WhatsApp line the replays answer on (our assistant's own line). */
const REPLAY_ASSISTANT = { name: "Sophie", role: "distribute.you", instructions: null };

export interface AssembledTurn {
  systemPrompt: string;
  turnContext: string;
  tools: ToolDefinition[];
  holdTextBesideToolCalls: boolean;
}

/** The prompt and tools /chat would build for this scenario under this definition. */
export function assembleTurn(def: AgentDefinition, scenario: Scenario, modelDisplay: string, brief = ""): AssembledTurn {
  const toolNames = withOurWebsite(withAccountSetup(def.allowedTools), def.allowedTools.includes("read_skill"));
  const skillBlock = toolNames.includes("read_skill") ? skillIndexBlockFrom(def.skills) : "";
  const systemPrompt = def.systemPrompt + skillBlock + aboutYouBlock(modelDisplay);
  const channelBlock =
    scenario.surface === "whatsapp"
      ? buildChannelBlock(
          {
            kind: "whatsapp",
            assistant: REPLAY_ASSISTANT,
            sender: { phone: "+10000000000", name: scenario.person.name, ...(scenario.person.email ? { knownEmails: [scenario.person.email] } : {}) },
            thread: [],
          },
          false,
        )
      : "";
  return {
    systemPrompt,
    turnContext: buildSystemPrompt("", scenario.context) + channelBlock + brief,
    tools: resolveToolSet(toolNames) as unknown as ToolDefinition[],
    holdTextBesideToolCalls: toolNames.includes("present_choices"),
  };
}

export interface ReplayedTurn {
  reply: string;
  /** The account context the turn was given (the briefs), as the model read it. */
  turnContext: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: unknown }>;
  llmCalls: number;
  tokensInput: number;
  tokensOutput: number;
  costLines: VendorCostLine[];
  latencyMs: number;
}

/** A response object that only records what the loop streams (no client is attached). */
function silentResponse(): ExpressResponse {
  return { write: () => true, flush: () => undefined, writableEnded: false } as unknown as ExpressResponse;
}

/**
 * Run the turn through the real tool loop. Only the direct OpenAI-compatible
 * vendors (DeepSeek today) are wired here: the Anthropic and Gemini loops live
 * inside the /chat handler and join the matrix when the agent core moves out.
 */
export async function replayTurn(args: {
  def: AgentDefinition;
  scenario: Scenario;
  provider: string;
  model: string;
  apiKey: string;
  executeTool: ToolExecutor;
  /** The text a turn-ending UI tool (present_choices) showed, read after the loop. */
  uiText: () => string;
}): Promise<ReplayedTurn> {
  const { def, scenario, provider, model, apiKey, executeTool, uiText } = args;
  if (!isVendorProvider(provider)) {
    throw new Error(`[evals] provider "${provider}" is not wired in the replay yet (direct vendors only: deepseek, zai, moonshot, openai)`);
  }
  const resolved = resolveModel(provider as Provider, model as ModelAlias);
  // Same order as /chat: the client brief, then where the account stands.
  const brief =
    (def.clientBrief ? await fixtureClientBrief(scenario).catch((err) => clientBriefUnavailable(err)) : "") +
    (def.situationBrief ? await buildSituationBrief(fixtureSituationReader(scenario)) : "");
  const turn = assembleTurn(def, scenario, modelDisplayName(resolved.apiModelId), brief);
  let llmCalls = 0;
  const started = Date.now();
  const result = await streamVendorChat({
    vendor: provider as VendorId,
    apiKey,
    model: resolved.apiModelId,
    costPrefix: resolved.costPrefix,
    systemPrompt: turn.systemPrompt,
    turnContext: turn.turnContext,
    history: scenario.history.map((m) => ({ role: m.role, content: m.content, toolCalls: m.toolCalls as never })),
    userMessage: scenario.message,
    tools: turn.tools,
    res: silentResponse(),
    sendSSE: () => undefined,
    executeTool,
    signal: new AbortController().signal,
    beforeProviderCall: async () => {
      llmCalls++;
    },
    holdTextBesideToolCalls: turn.holdTextBesideToolCalls,
  });
  const ui = uiText();
  return {
    reply: [result.fullResponse.trim(), ui && !result.fullResponse.includes(ui) ? ui : ""].filter(Boolean).join("\n\n"),
    turnContext: brief,
    toolCalls: result.toolCalls.map((c) => ({ name: c.name, args: (c.args ?? {}) as Record<string, unknown>, result: c.result })),
    llmCalls,
    tokensInput: result.tokensInput,
    tokensOutput: result.tokensOutput,
    costLines: result.costLines,
    latencyMs: Date.now() - started,
  };
}

/**
 * Sophie as the code defines her (src/agent/sophie.ts) with the skills given
 * (the live table inside the container): what the merge gate replays.
 */
export function sophieDefinition(skills: AgentDefinition["skills"]): AgentDefinition {
  return {
    id: "sophie-code",
    provider: SOPHIE_MODEL.provider,
    model: SOPHIE_MODEL.model,
    systemPrompt: SOPHIE_SYSTEM_PROMPT,
    allowedTools: [...SOPHIE_TOOLS],
    clientBrief: true,
    situationBrief: true,
    skills,
  };
}
