// ---------------------------------------------------------------------------
// The latest real Distry turn per audience, as the model received it
// (DISTRY-PROMPT-PARTS-1120). /chat records it right before the first model
// call; the editor reads it as the whole-prompt preview and as each live
// part's example. One row per audience, overwritten: never a history.
// ---------------------------------------------------------------------------

import { desc } from "drizzle-orm";
import type { db } from "../db/index.js";
import { distryPromptSamples, type DistryPromptSample } from "../db/schema.js";
import { PROMPT_PARTS, type AssembledPrompt } from "./distry-prompt.js";

type Database = typeof db;

export type PromptAudience = "staff" | "client" | "guest" | "lead";

/** Whose turn it is, for the preview: never a fact the turn acts on. */
export function promptAudience(t: { principal: boolean; leadTurn: boolean; guest: boolean }): PromptAudience {
  if (t.leadTurn) return "lead";
  if (t.principal) return "staff";
  return t.guest ? "guest" : "client";
}

export interface PromptSampleInput {
  audience: PromptAudience;
  version: number | null;
  orgId: string;
  sessionId: string | null;
  provider: string;
  model: string;
  assembled: AssembledPrompt;
  tools: Array<{ name: string; description?: string; input_schema: unknown }>;
  historyMessages: number;
  userMessage: string;
}

export async function recordPromptSample(database: Database, s: PromptSampleInput): Promise<void> {
  const row = {
    version: s.version,
    orgId: s.orgId,
    sessionId: s.sessionId,
    provider: s.provider,
    model: s.model,
    systemPrompt: s.assembled.system,
    turnContext: s.assembled.turn,
    tools: s.tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.input_schema })),
    parts: s.assembled.parts,
    historyMessages: s.historyMessages,
    userMessage: s.userMessage,
    recordedAt: new Date(),
  };
  await database
    .insert(distryPromptSamples)
    .values({ audience: s.audience, ...row })
    .onConflictDoUpdate({ target: [distryPromptSamples.audience], set: row });
}

export async function listPromptSamples(database: Database): Promise<DistryPromptSample[]> {
  return database.select().from(distryPromptSamples).orderBy(desc(distryPromptSamples.recordedAt));
}

const NAME_OF = new Map(PROMPT_PARTS.map((p) => [p.id, p.name]));

/** The preview body: the sample, each part named, and whether its parts add up to what was sent. */
export function previewBody(s: DistryPromptSample) {
  const sent = s.parts.filter((p) => p.sent && p.text !== null);
  const joined = (place: string) => sent.filter((p) => p.placedIn === place).map((p) => p.text).join("");
  return {
    audience: s.audience,
    recordedAt: s.recordedAt.toISOString(),
    version: s.version ?? null,
    orgId: s.orgId,
    sessionId: s.sessionId ?? null,
    provider: s.provider,
    model: s.model,
    tools: s.tools,
    systemPrompt: s.systemPrompt,
    historyMessages: s.historyMessages,
    userMessage: s.userMessage,
    turnContext: s.turnContext,
    parts: s.parts.map((p) => ({ ...p, name: NAME_OF.get(p.id) ?? p.id })),
    partsMatch: joined("system") === s.systemPrompt && joined("turn") === s.turnContext,
  };
}

const AUDIENCE_RANK: Record<PromptAudience, number> = { staff: 0, client: 1, guest: 2, lead: 3 };

/** Per part, what it sent in the latest real turn carrying it (a staff turn first, then client, guest, lead). */
export function examplesByPart(samples: readonly DistryPromptSample[]): Map<string, { audience: PromptAudience; orgId: string; recordedAt: string; text: string }> {
  const out = new Map<string, { audience: PromptAudience; orgId: string; recordedAt: string; text: string }>();
  const ranked = [...samples].sort((a, b) => AUDIENCE_RANK[a.audience] - AUDIENCE_RANK[b.audience]);
  for (const s of ranked) {
    for (const p of s.parts) {
      if (!p.sent || p.text === null || out.has(p.id)) continue;
      out.set(p.id, { audience: s.audience, orgId: s.orgId, recordedAt: s.recordedAt.toISOString(), text: p.text });
    }
  }
  return out;
}
