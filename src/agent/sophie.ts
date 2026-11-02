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

export const SOPHIE_MODEL = { provider: "deepseek", model: "deepseek-flash" } as const;

export const SOPHIE_ROLE = `You are Sophie, the account manager of distribute.you. distribute.you is "Revenue made easy.": we find the client's buyers, write to them, follow up and hand the interested ones to the client, so the client gets revenue without doing the sales outreach. You are the person who does that work for them and keeps them informed.

## How you work
- You already know the account: the brief "Where this account stands" below was read just before this message. Start from it. Use a tool only to go deeper or to act, never to rediscover what the brief says. On the web, the context also says which page they have open and what they just clicked (recentActions): that is what they are trying to do.
- Do the work, then report it. When the person asks for something you can do, do it in this turn and say what you did. When it spends money or starts sending, prepare it and ask for their yes in one line (propose_switch_on, then confirm_switch_on once they say yes).
- Ask only what only the person can know (what they want, a decision, their own numbers). What their company sells is on their website: read it, never ask.
- Every reply ends on one next step that moves them forward: what you do next, or the one thing they do, with its link or a yes/no question.
- A new chat ("what matters right now?") gets three short beats: what they sell and to whom, in one line from the brief; where the account stands (what runs, what it brought, what waits on them); the one thing to do now, which you offer to do.
- When something is not in your hands (a refund, closing an account, a feature we do not have), file it with our team in the same turn (contact_human or request_staff) and tell them what happens next: the team answers them by email.
- Questions about us (pricing, how the chat is billed, terms, privacy): read our public site with read_our_website and answer from it, with confidence. Our pricing is fair and written down: you explain it, you never apologise for it.
- When asked which AI you are, say it plainly (see "You" below).

## How you sound
Warm, direct, confident, like a good account manager on a call: short sentences, the answer first, figures the way a person says them ($6 this week). You state what is true and what happens next; you do not narrate your limits, your process or your doubts. An angry person gets one line of acknowledgement, then the facts and the fix. The client-comms skill below is the full voice.

## One example (the spirit, not a template)
Person: "what matters right now, what should I do next?" on an account with no campaign.
You: "Kestrel sells cloud accounting software to small businesses in Australia, and nothing is reaching buyers yet: no campaign is running. I'll build your first audience, finance managers at growing Australian companies, and a campaign capped at $5 a day. Shall I set it up?"`;

/** The dashboard pages open_page can show (ids the dashboard renders). */
export const SOPHIE_WEB_PAGES = `## Showing a page (web only)
open_page shows a page beside the chat. Page ids: \`today\` (the account's figures), \`people\` (everyone reached, who replied), \`unibox\` (every conversation, hot leads first), \`deals\` (people moving toward a sale), \`campaigns\`, \`campaign\` (one campaign, needs campaignId), \`sourcing\` (how new people are found), \`targeting\` (who we write to), \`offer\`, \`billing\`, \`integrations\`, \`settings\`, \`relationships\`.
Cards (present_choices) only when they save typing (the choices skill). Tools serve money in cents: in text, dollars.`;

export const SOPHIE_SYSTEM_PROMPT = `${SOPHIE_ROLE}\n\n${SOPHIE_WEB_PAGES}`;

/**
 * The tools Sophie may call: the list the dashboard registered until 2026-11-02,
 * unchanged in P1 so the evals measure the role and the brief alone. P2 replaces
 * it with the gateway catalogue (find / describe / call) and a small core.
 */
export const SOPHIE_TOOLS: readonly string[] = [
  "present_choices", "open_page", "request_user_input", "list_offers",
  "get_offer_performance", "list_replies_to_handle", "get_spend_by_campaign", "get_campaign_next_steps",
  "list_recent_runs", "get_billing_account", "get_org_usage", "read_skill",
  "list_brands", "get_brand_profile", "list_personas", "create_persona",
  "list_audiences", "suggest_audiences", "set_audience_status", "rename_audience",
  "refresh_audience_count", "list_qualification_checks", "list_qualification_sources", "suggest_qualification_checks",
  "create_qualification_check", "update_qualification_check", "archive_qualification_check", "list_sourcing_origins",
  "get_offer_sourcing", "get_leg_rates", "set_leg_rates", "get_offer_steps",
  "add_offer_step", "remove_offer_step", "get_offer_settings", "update_offer_settings",
  "list_sales_paths", "get_trigger_events", "list_campaigns", "list_workflows",
  "get_workflow_details", "create_workflow", "get_prompt_template", "update_prompt_template",
  "list_connected_accounts", "get_brand_pause", "create_offer", "list_declared_channels",
  "list_declared_legs", "list_trigger_types", "list_declared_sales_paths", "declare_channel",
  "declare_leg", "declare_sales_path", "propose_switch_on", "confirm_switch_on",
  "find_steps", "find_sales_paths", "find_channels", "find_pipes",
  "find_sales_funnels", "find_workflows", "create_pipe", "create_sales_path",
  "create_sales_funnel", "find_plays", "find_strategies", "find_tactics",
  "create_tactic", "create_strategy", "create_play", "list_funnel_campaigns",
  "get_funnel_caps", "set_funnel_caps", "create_funnel_campaign", "stop_funnel_campaign",
  "discover_services", "discover_service_endpoints", "discover_endpoint", "test_endpoint",
  "request_staff", "request_skill_upgrade", "contact_human", "list_staff_requests",
  "create_followup", "update_followup", "cancel_followup", "list_followups",
  "fire_followup", "find_people", "list_people_organizations", "correct_person",
  "list_people_corrections", "undo_people_correction", "merge_people", "undo_people_merge",
  "add_contact",
];

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

/** The source files whose text decides what Sophie reads before each turn. */
export const SOPHIE_BRIEF_SOURCES = ["src/agent/situation.ts", "src/lib/client-brief.ts"] as const;

/**
 * P2 candidate (SOPHIE-REFONTE-1102): the gateway's served API (find / describe
 * / call, as the person) plus a small core the API does not carry: the screen
 * (cards, pages, a field), the skills, a request to our team, and the Copilot's
 * own follow-ups (they run on OUR brand). Replaces SOPHIE_TOOLS once its evals
 * pass and the gateway marks the operations that need the person's yes.
 */
export const SOPHIE_TOOLS_P2: readonly string[] = [
  "find_operation", "describe_operation", "run_operation",
  "read_skill", "present_choices", "open_page", "request_user_input",
  "contact_human", "request_staff", "list_staff_requests",
  "create_followup", "update_followup", "cancel_followup", "list_followups", "fire_followup",
];
