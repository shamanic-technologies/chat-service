// ---------------------------------------------------------------------------
// Copilot nudge — the Copilot speaks FIRST when the user looks stuck
// (owner 2026-10-15: a Copilot turn, coded in the Copilot, never a campaign).
//
// The dashboard asks `/chat` with `nudge: true` on a page change or after an
// idle spell, while the Copilot is open. Whether to speak is a Jev judgment
// (input-billed, cheap), never a full Copilot model turn: on "no" nothing is
// stored and no model runs. On "yes" the turn runs like any other, fed the
// trigger below as its user turn, and that trigger row is stored with
// `proactive_trigger = true` so history replay keeps the turn pairing while
// GET /sessions/* never shows it as a user bubble.
// ---------------------------------------------------------------------------

import type { TypeSafeAnswer, TypeSafeQuestion } from "./typesafe.js";

/**
 * The user turn of a speak turn. The model reads it (now and on every later
 * turn's replay); the user never does. States the game, not canned replies.
 */
export const NUDGE_TRIGGER_MESSAGE = [
  "(Not written by the user. The dashboard asked you to speak first: the user has the Copilot open and seems stuck or looking for something.",
  "Read `currentPage` and `recentActions` in the context, and the conversation so far, to guess what they are trying to do.",
  "Answer that in one or two short sentences, then call present_choices with 2 or 3 options that move them forward: open the right page, start the action, or answer what they look for.",
  "Never pushy, never a sales pitch, no greeting, and do not say you noticed their clicks.)",
].join(" ");

/** The Jev question's key in the judgment request (and in its answers). */
export const NUDGE_QUESTION_KEY = "speak_first";

/** Probability of "yes" at or above which the Copilot speaks. Above 0.5: when Jev hesitates, stay quiet. */
export const NUDGE_SPEAK_THRESHOLD = 0.6;

/** How many of the latest stored turns Jev reads, and how much of each. */
const NUDGE_LAST_TURNS = 6;
const NUDGE_TURN_CHARS = 600;

export const NUDGE_QUESTION: TypeSafeQuestion = {
  type: "noul",
  instructions:
    "A user of a marketing dashboard has its AI assistant (the Copilot) open beside the page. " +
    "Should the Copilot speak first now, without being asked, with a short message and 2-3 clickable next steps? " +
    "Read the page they are on, what they just did on the dashboard (recentActions, newest last, with times), " +
    "the last turns of the conversation and the account figures.",
  criteria: {
    true:
      "The user looks stuck or searching: going back and forth between the same pages, opening pages without acting, " +
      "clicking around without finishing anything, or idle on a page after an error or an empty result. " +
      "A short offer of help would save them time.",
    false:
      "The user is plainly progressing (each action moves a task forward), or the Copilot already spoke first less than " +
      "a few minutes ago (secondsSinceLastProactiveMessage), or the user is typing or answering a question the Copilot " +
      "just asked (the last turn is the Copilot asking something, or the user wrote very recently), or there is too little " +
      "activity to tell. When unsure, stay quiet.",
  },
};

export interface NudgeTurn {
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: Date;
  proactiveTrigger: boolean;
  hasChoices: boolean;
}

/** The state Jev judges: the request context plus what the stored session says about timing. */
export function buildNudgeState(
  context: Record<string, unknown> | undefined,
  turns: NudgeTurn[],
  now: Date,
): Record<string, unknown> {
  const secondsAgo = (d: Date) => Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
  const visible = turns.filter((t) => t.role !== "tool");
  const lastTrigger = [...turns].reverse().find((t) => t.proactiveTrigger);
  const lastUser = [...visible].reverse().find((t) => t.role === "user" && !t.proactiveTrigger);
  const last = visible[visible.length - 1];
  return {
    now: now.toISOString(),
    context: context ?? {},
    secondsSinceLastProactiveMessage: lastTrigger ? secondsAgo(lastTrigger.createdAt) : null,
    secondsSinceLastUserMessage: lastUser ? secondsAgo(lastUser.createdAt) : null,
    copilotIsWaitingForAnAnswer: last?.role === "assistant" && (last.hasChoices || last.content.trim().endsWith("?")),
    lastTurns: visible
      .filter((t) => !t.proactiveTrigger)
      .slice(-NUDGE_LAST_TURNS)
      .map((t) => ({
        from: t.role === "user" ? "user" : "copilot",
        secondsAgo: secondsAgo(t.createdAt),
        text: t.content.length > NUDGE_TURN_CHARS ? `${t.content.slice(0, NUDGE_TURN_CHARS)}…` : t.content,
      })),
  };
}

/** Jev's verdict → speak or not. A missing or mistyped answer throws (fail loud, never a silent default). */
export function nudgeVerdict(answers: Record<string, TypeSafeAnswer>): { speak: boolean; probability: number } {
  const a = answers[NUDGE_QUESTION_KEY];
  if (!a || a.type !== "noul" || typeof a.noul !== "number") {
    throw new Error(`[copilot-nudge] Jev answered no "${NUDGE_QUESTION_KEY}" noul: ${JSON.stringify(a)}`);
  }
  return { speak: a.noul >= NUDGE_SPEAK_THRESHOLD, probability: a.noul };
}
