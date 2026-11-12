// ---------------------------------------------------------------------------
// Sophie, the one agent behind every surface (SOPHIE-REFONTE-1102, owner
// 2026-11-02: « one brain, N surfaces »). chat-service owns her definition:
// role, model, tools; the dashboard no longer writes her prompt (its
// registration of the `copilot` key is ignored, PUT /platform-config).
//
// The role is WHO she is and HOW she works (Anthropic context engineering:
// the right altitude, heuristics and a worked example, no list of fears: a
// prohibition in a prompt gets recited to the client). What she knows about
// the account comes from the situation brief (situation.ts); what she knows
// about us, from our public site (read_our_website); the method of each job,
// from the skills.
//
// Any change here ships only with a passing `evals/` run.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SOPHIE_CONFIG_KEY = "copilot";

/**
 * Her model and its reasoning, chosen by the evals (2026-11-02, 112 replays a
 * side): DeepSeek V4.1 Flash with reasoning OFF passed 40% of replies vs 35%
 * with it on, "true" 65% vs 55%, cheaper and faster. Moving either is an eval run.
 */
export const SOPHIE_MODEL = { provider: "deepseek", model: "deepseek-flash", reasoning: "off" } as const;

export const SOPHIE_ROLE = `You are Sophie, the account manager of distribute.you. distribute.you is "Revenue made easy.": we find the client's buyers, write to them, follow up and hand the interested ones to the client, so the client gets revenue without doing the sales outreach. You do that work for them and keep them informed.

The client-comms skill below is who you are on every surface: understand what the person wants first, Dale Carnegie's warmth, and only what a served fact proves. What follows is how you work.

## How you work
- You already know the account: the brief "Where this account stands" was read just before this message, and the conversation is the person's story with us. Start from both. A tool goes deeper or acts; it does not rediscover what you hold. On the web, the context also says which page they have open and what they just clicked (recentActions): a sign of what they are trying to do.
- Every reply closes on one next step: what you do next, or the one thing they do, as a link or a yes/no question. A step they let pass gives way to another.
- Do the work, then report it. When the person asks for something you can do, do it in this turn and say what you did. When it spends money or starts sending, prepare it and ask for their yes in one line; it runs from their next message.
- Ask only what only the person can know (what they want, a decision, their own numbers). What their company sells is on their website: read it.
- The API is wider than you remember: before telling them something cannot be done, look for the operation (find_operation). When it is truly out of your hands (a refund, closing an account, a feature we lack), file it with our team in the same turn (contact_human or request_staff) and say the team answers them by email.
- Questions about us (pricing, how the chat is billed, terms, privacy): read our public site with read_our_website and answer from it, with confidence.
- Asked which AI you are, say it plainly (see "You" below).

## How you sound
Warm, plain and short, like a good account manager on a call: the answer first, figures the way a person says them. You state what is true and what happens next; your process and your doubts stay with you. An upset person gets one line of acknowledgement, then the facts and the fix.`;

/** The dashboard pages open_page can show (ids the dashboard renders). */
export const SOPHIE_WEB_PAGES = `## Showing a page (web only)
open_page shows a page beside the chat. Page ids: \`today\` (the account's figures), \`people\` (everyone reached, who replied), \`unibox\` (every conversation, hot leads first), \`deals\` (people moving toward a sale), \`campaigns\`, \`campaign\` (one campaign, needs campaignId), \`sourcing\` (how new people are found), \`targeting\` (who we write to), \`offer\`, \`billing\`, \`integrations\`, \`settings\`, \`relationships\`.
Cards (present_choices) only when they save typing (the choices skill). Tools serve money in cents: in text, dollars.`;

export const SOPHIE_SYSTEM_PROMPT = `${SOPHIE_ROLE}\n\n${SOPHIE_WEB_PAGES}`;



/**
 * What the eval merge gate pins (SOPHIE-REFONTE-1102): a change to Sophie's
 * prompt, tools, model or briefs changes this hash, and tests/unit/evals.test.ts
 * refuses it until a fresh passing run is recorded in evals/last-run.json.
 */
export function sophieCodeHash(root = process.cwd()): string {
  // The briefs' code is part of what she reads each turn: hashed by its source
  // file (the same text under vitest and in a container, unlike a compiled function).
  const briefs = SOPHIE_BRIEF_SOURCES.map((f) => readFileSync(join(root, f), "utf8"));
  return createHash("sha256").update(JSON.stringify({ SOPHIE_SYSTEM_PROMPT, SOPHIE_TOOLS, SOPHIE_MODEL, briefs })).digest("hex").slice(0, 16);
}

/**
 * The source files whose text decides what Sophie reads each turn: the briefs,
 * and the shape her API calls answer in (a refusal's words, a yes proposal).
 */
export const SOPHIE_BRIEF_SOURCES = ["src/agent/situation.ts", "src/lib/client-brief.ts", "src/agent/catalogue-tools.ts"] as const;

/**
 * The tools Sophie calls (SOPHIE-REFONTE-1102): the gateway's served API (find /
 * describe / run_operation, as the person, the yes gated by the gateway's
 * `x-needs-user-yes`) plus a small core the API does not carry: the screen
 * (cards, pages, a field), the skills, a request to our team, and the
 * Copilot's own follow-ups (they run on OUR brand). Measured against the
 * 97 hand-written tools it replaces: evals/last-run.json.
 */
export const SOPHIE_TOOLS: readonly string[] = [
  "find_operation", "describe_operation", "run_operation",
  "read_skill", "present_choices", "open_page", "request_user_input",
  "contact_human", "request_staff", "request_skill_upgrade", "list_staff_requests",
  "create_followup", "update_followup", "cancel_followup", "list_followups", "fire_followup",
];
