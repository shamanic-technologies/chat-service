// ---------------------------------------------------------------------------
// Eval scenarios (SOPHIE-REFONTE-1102, owner 2026-11-02: « evals first »).
//
// A scenario is ONE turn of a real conversation, replayed: what the person
// said before, what our assistant answered before (tool calls included), the
// message to answer now, and the account as it stood (the answers its tools
// gave, recorded from the real session). Names are replaced: a scenario never
// names a client, and a replay never reaches one (every tool is answered from
// the scenario, nothing is sent, started or written).
//
// `facts` is what the judge holds true about the account and about us; it is
// how the judge tells a true reply from an invented one.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const EVAL_SURFACES = ["web", "whatsapp"] as const;
export type EvalSurface = (typeof EVAL_SURFACES)[number];

const ToolCallSchema = z
  .object({
    name: z.string().min(1),
    args: z.record(z.string(), z.unknown()).optional(),
    result: z.unknown().optional(),
  })
  .passthrough();

const HistoryMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    toolCalls: z.array(ToolCallSchema).optional(),
  })
  .strict();

export const ScenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    title: z.string().min(1),
    /** Where it comes from, anonymised ("client A, web, 2026-11-01"). */
    source: z.string().min(1),
    surface: z.enum(EVAL_SURFACES),
    /** Who writes (first name, anonymised) and what our records say about them. */
    person: z.object({ name: z.string().min(1), email: z.string().email().optional() }).strict(),
    /** Page context the web client sent with the message (page, account, recentActions). */
    context: z.record(z.string(), z.unknown()).optional(),
    history: z.array(HistoryMessageSchema),
    message: z.string().min(1),
    /**
     * Recorded tool answers, by tool name, in the order the real session got
     * them (the last one repeats). A tool absent here answers that the replay
     * holds no data for it.
     */
    fixtures: z.record(z.string(), z.array(z.unknown()).min(1)),
    /** True statements about this account and about us, for the judge. */
    facts: z.array(z.string().min(1)).min(1),
    /** What a great answer does here, in one or two sentences, for the judge. */
    expect: z.string().min(1),
    /** The reply production gave (calibration: the judge must FAIL it when `badReplyFails`). */
    prodReply: z.string().optional(),
    /** True when the production reply is a known failure the judge must catch. */
    badReplyFails: z.boolean().optional(),
    /** The tool calls the production reply made (calibration: what the judge sees as done). */
    prodReplyActions: z.array(z.string()).optional(),
    /** A hand-written reply the judge must PASS (calibration). */
    goodReply: z.string().optional(),
    /** The tool calls that good reply stands on ("stop_funnel_campaign {campaign}"). */
    goodReplyActions: z.array(z.string()).optional(),
  })
  .strict();

export type Scenario = z.infer<typeof ScenarioSchema>;

/** Every scenario in a directory, validated; a bad file fails loud with its name. */
export function loadScenarios(dir: string): Scenario[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort();
  return files.map((f) => {
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as unknown;
    const parsed = ScenarioSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`[evals] scenario ${f} is invalid: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
    }
    if (`${parsed.data.id}.json` !== f) throw new Error(`[evals] scenario ${f} carries id "${parsed.data.id}": name the file after its id`);
    return parsed.data;
  });
}
