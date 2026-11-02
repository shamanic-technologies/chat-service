// ---------------------------------------------------------------------------
// The eval judge: Jev (chat-service's judgment vendor) answers one yes/no
// question per criterion about ONE reply, with the facts of the account, what
// a great answer does here, and the conversation around it. A criterion
// passes at a probability of yes >= PASS_PROBABILITY.
//
// The criteria are the owner's (2026-11-02): true, respectful, proactive,
// answers the question, ends on the next action; plus the surface's form.
// Cost per reply is measured, not judged (run.ts).
// ---------------------------------------------------------------------------

import type { TypeSafeNoulQuestion } from "../lib/typesafe.js";
import type { Scenario } from "./scenario.js";

export const PASS_PROBABILITY = 0.5;

export const CRITERIA = ["true", "respectful", "proactive", "answers", "nextAction", "form"] as const;
export type Criterion = (typeof CRITERIA)[number];

const SURFACE_FORM: Record<Scenario["surface"], string> = {
  web: "a chat panel in the client's dashboard: short paragraphs, plain words, no internal ids or tool names",
  whatsapp: "WhatsApp: short plain-text messages, no HTML tags, no markdown tables or headings, links written out",
};

export const QUESTIONS: Record<Criterion, TypeSafeNoulQuestion> = {
  true: {
    type: "noul",
    instructions:
      "Is every statement of fact in the reply supported by the facts, the conversation or the actions taken this turn (each with what it returned)? A figure, client, result or price none of these support, or something said to be DONE (sent, stopped, filed, opened) that is not in actionsTakenThisTurn, makes this false. A plan or proposal of what the assistant will do next, or an example of who it could target, is not a statement of fact.",
    criteria: {
      true: "Nothing invented: every figure, client and result is in the facts or the conversation, and every action said to be done is in actionsTakenThisTurn.",
      false: "The reply states a figure, client, result or done action that the facts, the conversation or actionsTakenThisTurn contradict or do not support.",
    },
  },
  respectful: {
    type: "noul",
    instructions:
      "Does the reply speak like a confident, warm account manager who stands by the company: no reciting of its own limits or fears (\"I can't invent\", \"I won't guess\", \"I can't justify\", \"I can't promise\"), no agreeing that our service is a scam or worthless, no lecturing the client?",
    criteria: {
      true: "Confident and warm: it states what is true and what happens next, without reciting its limits and without running the company down.",
      false: "It recites what it cannot do or will not say, or agrees with a put-down of our service, or sounds defensive or cold.",
    },
  },
  proactive: {
    type: "noul",
    instructions:
      "Did the assistant do the work itself instead of handing it back? It fails when it asks the client for something its tools, the account or the client's own website could tell it (what the company sells, who it targets, a list it could show), or stalls with \"the team will answer\" when it could act. Filing the request with our team IS acting when the facts say only the team can do it (a refund, closing an account).",
    criteria: {
      true: "It acted or found the answer itself, and asked only what only the client can know.",
      false: "It asked the client for what it could find itself, or passed the work to someone else when it could act.",
    },
  },
  answers: {
    type: "noul",
    instructions: "Does the reply answer what the person asked in their last message, directly, in its first sentences?",
    criteria: {
      true: "The person's question or request is answered or done, up front.",
      false: "The question is dodged, answered only partly, or buried under other things.",
    },
  },
  nextAction: {
    type: "noul",
    instructions:
      "Does the reply end on one concrete next step: what we do next, or the one thing the person does now (with its link or a yes/no question)? When the person is leaving and everything they asked is done, saying what happens next and when counts. A vague close (\"let me know\", \"any question?\", \"close this window\") is false.",
    criteria: {
      true: "It ends on one concrete next step that moves the person forward, or, for a person leaving, on what happens next.",
      false: "It ends with no step, a vague invitation, or several options with no lead.",
    },
  },
  form: {
    type: "noul",
    instructions: "Is the reply in the right form for where it is read, and short enough to read in one pass?",
    criteria: {
      true: "Right format for the surface and short.",
      false: "Wrong format for the surface (HTML on WhatsApp, a table, internal ids) or too long to read in one pass.",
    },
  },
};

/** What the judge reads: the account facts, what a great answer does, the conversation, what the assistant did this turn, the reply. */

/** One action as the judge reads it: the tool and its arguments, short. */
export function describeAction(name: string, args: Record<string, unknown>, result?: unknown): string {
  const a = JSON.stringify(args);
  const call = a === "{}" ? name : `${name} ${a.length > 300 ? `${a.slice(0, 300)}...` : a}`;
  if (result === undefined) return call;
  const r = JSON.stringify(result);
  return `${call} → ${r.length > RESULT_CHARS ? `${r.slice(0, RESULT_CHARS)}...` : r}`;
}

/** How much of each tool answer the judge reads (the figures a reply cites are in the first part). */
const RESULT_CHARS = 4000;

export function judgeState(scenario: Scenario, reply: string, actions: readonly string[]): Record<string, unknown> {
  const recent = scenario.history.slice(-6).map((m) => `${m.role === "user" ? scenario.person.name : "Assistant"}: ${m.content}`);
  return {
    where: SURFACE_FORM[scenario.surface],
    facts: scenario.facts,
    whatAGreatAnswerDoes: scenario.expect,
    conversationBefore: recent,
    personWrites: scenario.message,
    actionsTakenThisTurn: actions.length ? actions : ["none"],
    assistantReply: reply,
  };
}

export interface Verdict {
  probabilities: Record<Criterion, number>;
  passed: Record<Criterion, boolean>;
  /** Every criterion passed. */
  pass: boolean;
}

export function verdictFrom(answers: Record<string, { type: string; noul?: number }>): Verdict {
  const probabilities = {} as Record<Criterion, number>;
  const passed = {} as Record<Criterion, boolean>;
  for (const c of CRITERIA) {
    const a = answers[c];
    if (!a || a.type !== "noul" || typeof a.noul !== "number") throw new Error(`[evals] judge answered no probability for "${c}"`);
    probabilities[c] = a.noul;
    passed[c] = a.noul >= PASS_PROBABILITY;
  }
  return { probabilities, passed, pass: CRITERIA.every((c) => passed[c]) };
}
