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

export const EVAL_SURFACES = ["web", "whatsapp", "lead"] as const;
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
    /**
     * A Lead event turn (surface "lead"): the writer's payload as the Lead event
     * workflow sent it (its prompt, the thread, the answer schema), on our own
     * brand. `guest` = no account of ours is theirs.
     */
    lead: z
      .object({ payload: z.record(z.string(), z.unknown()), guest: z.boolean(), phoneBound: z.boolean() })
      .strict()
      .optional(),
    /** Page context the web client sent with the message (page, account, recentActions). */
    context: z.record(z.string(), z.unknown()).optional(),
    history: z.array(HistoryMessageSchema),
    message: z.string().min(1),
    /**
     * Photos the person sent with this message (SOPHIE-WA-HUMAN-1106): files
     * under `evals/images/`, handed to the model as images like production
     * does. The judge learns what they show from `facts`.
     */
    images: z
      .array(z.object({ file: z.string().regex(/^evals\/images\/[a-z0-9-]+\.(png|jpg)$/), at: z.string().optional(), caption: z.string().optional() }).strict())
      .optional(),
    /**
     * A WhatsApp lead turn: the conversation as crm-service serves it to the
     * turn (lead-whatsapp.ts), its quotes and photos included, oldest first.
     */
    whatsapp: z
      .array(
        z
          .object({
            eventId: z.string().min(1),
            at: z.string().min(1),
            direction: z.enum(["inbound", "outbound"]),
            text: z.string().min(1),
            quote: z
              .object({ eventId: z.string(), direction: z.enum(["inbound", "outbound"]).nullable(), at: z.string().nullable(), text: z.string().nullable() })
              .strict()
              .nullable(),
            photo: z.object({ caption: z.string().nullable() }).strict().nullable(),
          })
          .strict(),
      )
      .optional(),
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

/** The day the turn was written, from its source ("client A, web, 2026-11-01"): the brief's "Today". */
export function scenarioDay(scenario: Scenario): Date {
  const day = /\d{4}-\d{2}-\d{2}/.exec(scenario.source)?.[0];
  if (!day) throw new Error(`[evals] scenario ${scenario.id} names no day in its source`);
  return new Date(`${day}T12:00:00Z`);
}

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
