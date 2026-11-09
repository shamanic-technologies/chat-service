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
import { REACH_ELSEWHERE_TOOL, REACH_ELSEWHERE_TOOL_NAME } from "../lib/lead-contact.js";
import { LEAD_ANSWER_TOOL_NAME, brandToolsBlock, buildLeadAnswerTool, buildLeadTurnBlock, leadTurnToolNames, type LeadTurnFrame } from "../lib/lead-turn.js";
import { namespacedToolName, serverPrefixes, toToolDefinition } from "../lib/brand-mcp.js";
import { CLIENT_UI_TOOL_NAMES } from "../lib/ui-tools.js";
import type { LeadTurnRequest } from "../schemas.js";
import type { ToolDefinition, ToolExecutor } from "../lib/gemini-chat.js";
import { modelDisplayName } from "../lib/model-ids.js";
import { isVendorProvider, type VendorId } from "../lib/openai-compatible.js";
import { aboutYouBlock, withOurWebsite } from "../lib/person-facing.js";
import { skillIndexBlockFrom } from "../lib/skills.js";
import { streamVendorChat } from "../lib/vendor-chat.js";
import { streamGeminiChat } from "../lib/gemini-chat.js";
import type { VendorCostLine } from "../lib/cost-names.js";
import { buildSituationBrief } from "../agent/situation.js";
import { SOPHIE_MODEL, SOPHIE_SYSTEM_PROMPT, SOPHIE_TOOLS } from "../agent/sophie.js";
import { clientBriefUnavailable } from "../lib/client-brief.js";
import { prepareTurnImage, type TurnImage } from "../lib/turn-images.js";
import { labelLines } from "../lib/lead-whatsapp.js";
import { fixtureClientBrief, fixtureSituationReader } from "./fixture-situation.js";
import { scenarioDay, type Scenario } from "./scenario.js";

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
    /** Direct vendors: the model reasons ("on", its default) or not ("off"). */
    reasoning: z.enum(["on", "off"]).optional(),
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
  /** A lead turn ends on this tool (answer_person). */
  endToolName?: string;
}

/** The brand's MCP tools of a scenario, named and described exactly as a production turn lists them (BRAND-MCP-1109). */
export function scenarioBrandTools(scenario: Scenario): ToolDefinition[] {
  const servers = scenario.brandTools ?? [];
  const prefixes = serverPrefixes(servers.map((s) => s.server));
  return servers.flatMap((s, i) => s.tools.map((t) => toToolDefinition(s.server, namespacedToolName(prefixes[i], t.name), t)));
}

/** A lead turn as /chat builds it: the writer's block, the person's tools (none for a guest), the answer and reach tools, the brand's own tools. */
function assembleLeadTurn(def: AgentDefinition, scenario: Scenario, modelDisplay: string, images: TurnImage[], withBrandTools: boolean): AssembledTurn {
  const lead = scenario.lead!;
  const payload = lead.payload as unknown as LeadTurnRequest;
  // The WhatsApp conversation as crm serves it to the turn (SOPHIE-WA-HUMAN-1106).
  const whatsapp = scenario.whatsapp || images.length > 0 ? { shown: labelLines(scenario.whatsapp ?? []), images, unreadablePhotos: [] } : null;
  const frame: LeadTurnFrame = { payload, ownBrand: true, guest: lead.guest, phoneBound: lead.phoneBound, afterSignIn: false, now: scenarioDay(scenario), whatsapp };
  const sessionTools = lead.guest ? [] : withOurWebsite(def.allowedTools, def.allowedTools.includes("read_skill"));
  const toolNames = leadTurnToolNames(sessionTools, CLIENT_UI_TOOL_NAMES);
  const skillBlock = !lead.guest && toolNames.includes("read_skill") ? skillIndexBlockFrom(def.skills) : "";
  const brandTools = withBrandTools ? scenarioBrandTools(scenario) : [];
  return {
    systemPrompt: def.systemPrompt + skillBlock + aboutYouBlock(modelDisplay),
    turnContext: buildLeadTurnBlock(frame) + (brandTools.length > 0 ? brandToolsBlock() : ""),
    tools: [
      ...(resolveToolSet(toolNames.filter((t) => t !== LEAD_ANSWER_TOOL_NAME && t !== REACH_ELSEWHERE_TOOL_NAME)) as unknown as ToolDefinition[]),
      REACH_ELSEWHERE_TOOL as unknown as ToolDefinition,
      buildLeadAnswerTool(payload.responseSchema, payload.messageField, { replyTo: (whatsapp?.shown.length ?? 0) > 0 }) as unknown as ToolDefinition,
      ...brandTools,
    ],
    holdTextBesideToolCalls: true,
    endToolName: LEAD_ANSWER_TOOL_NAME,
  };
}

/** The prompt and tools /chat would build for this scenario under this definition. */
export function assembleTurn(def: AgentDefinition, scenario: Scenario, modelDisplay: string, brief = "", images: TurnImage[] = [], withBrandTools = true): AssembledTurn {
  if (scenario.surface === "lead") return assembleLeadTurn(def, scenario, modelDisplay, images, withBrandTools);
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
  costLines: Array<{ costName: string; quantity: number }>;
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
  /** Direct vendors: send the reasoning-off field (a thinking-level comparison). */
  reasoningDisabled?: boolean;
  /** False = the turn as it ran before the brand's tools existed (`--no-brand-tools`, the baseline). */
  brandTools?: boolean;
}): Promise<ReplayedTurn> {
  const { def, scenario, provider, model, apiKey, executeTool, uiText } = args;
  if (!isVendorProvider(provider) && provider !== "google") {
    throw new Error(`[evals] provider "${provider}" is not wired in the replay yet (direct vendors and google; the Anthropic loop lives inside the /chat handler)`);
  }
  const resolved = resolveModel(provider as Provider, model as ModelAlias);
  // Same order as /chat: the client brief, then where the account stands. A lead
  // turn carries neither here (it runs in the writing brand's thread; its
  // context is the writer's message).
  const brief = scenario.surface === "lead" ? "" :
    (def.clientBrief ? await fixtureClientBrief(scenario).catch((err) => clientBriefUnavailable(err)) : "") +
    (def.situationBrief ? await buildSituationBrief(fixtureSituationReader(scenario), { now: scenarioDay(scenario) }) : "");
  const modelDisplay = modelDisplayName(resolved.apiModelId);
  const images = await scenarioImages(scenario);
  if (images.length > 0 && provider === "google") throw new Error("[evals] photos are wired on the direct-vendor loop only (Sophie's)");
  const turn = assembleTurn(def, scenario, modelDisplay, brief, images, args.brandTools !== false);
  let llmCalls = 0;
  const started = Date.now();
  const history = scenario.history.map((m) => ({ role: m.role, content: m.content, toolCalls: m.toolCalls as never }));
  const hooks = {
    res: silentResponse(),
    sendSSE: () => undefined,
    executeTool,
    signal: new AbortController().signal,
    holdTextBesideToolCalls: turn.holdTextBesideToolCalls,
    ...(turn.endToolName ? { endToolName: turn.endToolName } : {}),
  };
  // Gemini reads the stable prompt and the turn's context joined, as /chat sends it.
  const result =
    provider === "google"
      ? await streamGeminiChat({
          ...hooks,
          apiKey,
          model: resolved.apiModelId,
          systemPrompt: turn.systemPrompt + turn.turnContext,
          history,
          userMessage: scenario.message,
          tools: turn.tools,
          beforeProviderCall: async () => {
            llmCalls++;
          },
        })
      : await streamVendorChat({
    vendor: provider as VendorId,
    apiKey,
    model: resolved.apiModelId,
    costPrefix: resolved.costPrefix,
    systemPrompt: turn.systemPrompt,
    turnContext: turn.turnContext,
    history,
    userMessage: scenario.message,
    images,
    tools: turn.tools,
    ...hooks,
    beforeProviderCall: async () => {
      llmCalls++;
    },
    reasoningDisabled: args.reasoningDisabled ?? def.reasoning === "off",
  });
  const ui = uiText();
  return {
    reply: [result.fullResponse.trim(), ui && !result.fullResponse.includes(ui) ? ui : ""].filter(Boolean).join("\n\n"),
    // The judge reads the turn's whole context as the model read it (briefs,
    // channel or Lead event block, page context) and its "## You" line.
    turnContext: turn.turnContext + aboutYouBlock(modelDisplay),
    toolCalls: result.toolCalls.map((c) => ({ name: c.name, args: (c.args ?? {}) as Record<string, unknown>, result: c.result })),
    llmCalls,
    tokensInput: result.tokensInput,
    tokensOutput: result.tokensOutput,
    costLines: result.costLines,
    latencyMs: Date.now() - started,
  };
}

/** The scenario's photos, fitted the way production fits them (files are read from the repo root). */
export async function scenarioImages(scenario: Scenario, root = process.cwd()): Promise<TurnImage[]> {
  return Promise.all(
    (scenario.images ?? []).map((img) =>
      prepareTurnImage(readFileSync(`${root}/${img.file}`), { at: img.at ?? null, caption: img.caption ?? null }),
    ),
  );
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
    reasoning: SOPHIE_MODEL.reasoning,
    skills,
  };
}
