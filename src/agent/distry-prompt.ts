// ---------------------------------------------------------------------------
// Everything Distry reads, as an ordered list of parts (DISTRY-PROMPT-PARTS-1120,
// owner 2026-11-20: « 100% de ce que tu lui donnes devrait être visible sur
// cette page et éditable par moi ! … dans quel ordre tu donnes les prompts »).
//
// One turn sends the model: the tool definitions, the system prompt, the
// conversation (history + the person's message), the turn's context after it,
// and (only when a turn runs long or goes silent) a note beside the last tool
// results. Each piece of TEXT in there is a part here: the role, how the skill
// index is introduced, the model line, the surface's form block, the account
// briefs, the dashboard page list, the loop notes, each tool's description.
//
// - A `text` part is fixed words: editable as is.
// - A `template` part mixes words and data: the words are editable, the data
//   arrives through named placeholders (`{{modelName}}`).
// - A `live` part is a block a builder writes from the account at each turn
//   (the situation brief, the surface's block): its template wraps the
//   builder's output (`{{situationBrief}}`), so text can be put around it,
//   and a real rendered example is served beside it.
//
// The ORDER is part of Distry's definition: the parts above `conversation`
// form the system prompt (cached on Anthropic), the parts below it are this
// turn's context, sent after the person's message (CHAT-COST-1101). `tools`
// stays first (that is where every provider reads them); the loop notes and
// the Engine tool template are not in the order (they are sent where they
// apply). Code values = what /chat sent before this module, byte for byte
// (pinned by tests/unit/distry-prompt.test.ts).
//
// Overrides are stored ONLY where staff changed the code's text, so a code
// edit to a part nobody touched still reaches Distry (like the skill seed).
// ---------------------------------------------------------------------------

import { dashboardPagesBlock } from "./sophie.js";
import { buildTelegramBlock } from "../lib/telegram-copilot.js";
import { brandToolsBlock } from "../lib/lead-turn.js";
import { EMPTY_ANSWER_NOTE, FINAL_ROUND_NOTE, type LoopNotes } from "../lib/tool-budget.js";
import { SKILL_INDEX_TEMPLATE, type SkillIndexPieces } from "../lib/skills.js";
import { fillTemplate, placeholdersIn } from "../lib/prompt-template.js";
import { ENGINE_TOOL_DESCRIPTION_TEMPLATE } from "./engine-tools.js";
import { NUDGE_TRIGGER_MESSAGE } from "../lib/copilot-nudge.js";

export type PartKind = "marker" | "text" | "template" | "live";

/** Where the model reads a part: by its position for ordered parts, fixed for the rest. */
export type PartPlace = "ordered" | "message" | "loop" | "tool";

export interface PromptPartSpec {
  id: string;
  name: string;
  /** What it is for, in plain words. */
  purpose: string;
  /** When it is sent, in plain words. */
  when: string;
  kind: PartKind;
  place: PartPlace;
  /** The data a template part is filled with: name -> what it holds. */
  placeholders: Record<string, string>;
  /** The code's text (null for a marker, and for `role`, whose text is the definition's systemPrompt). */
  codeText: string | null;
}

const FINAL_ROUND_END_TOOL_TEMPLATE = "Tool budget for this turn is used up: call {{toolName}} now with what you already have. No other tool.";
const SILENT_END_TOOL_TEMPLATE =
  "You ended your turn without calling {{toolName}}. Your turn only counts once you call it: call {{toolName}} now, from the conversation and what you already found.";

/** Every part, in the code's order. Changing a codeText here changes what Distry reads: an eval run first. */
export const PROMPT_PARTS: readonly PromptPartSpec[] = [
  {
    id: "tools",
    name: "Tool definitions",
    purpose: "Every tool this turn may call, each with its description and its fields. Descriptions are edited in the Tools list.",
    when: "Always. A staff conversation adds the principal tools; a guest gets the short guest list; a Lead event adds its answer tool.",
    kind: "marker",
    place: "ordered",
    placeholders: {},
    codeText: null,
  },
  {
    id: "role",
    name: "Role",
    purpose: "Who Distry is and how it works: the system prompt itself.",
    when: "Always.",
    kind: "text",
    place: "ordered",
    placeholders: {},
    codeText: null,
  },
  {
    id: "skill-index",
    name: "Skill index",
    purpose: "Introduces the skills: what a mention (`@skill:<slug>`, `@tool:<name>`) means, then one line per skill the Prompt mentions, which Distry loads with read_skill.",
    when: "When read_skill is one of the turn's tools (every Distry turn).",
    kind: "template",
    place: "ordered",
    placeholders: {
      skills: "One line per skill the Prompt mentions, in the Prompt's order: slug, title, description.",
    },
    codeText: SKILL_INDEX_TEMPLATE,
  },
  {
    id: "about-you",
    name: "Which AI it is",
    purpose: "Tells Distry which model it runs on, so it can say so when asked.",
    when: "When the chat speaks for us (it reads our skills), on every surface.",
    kind: "template",
    place: "ordered",
    placeholders: { modelName: "The public name of the model this turn runs on (e.g. Claude Haiku 5.5)." },
    codeText: "\n\n---\n## You\nYou are an AI agent running on {{modelName}}. That name is public: give it when someone asks which AI or model you are.",
  },
  {
    id: "conversation",
    name: "The conversation",
    purpose: "The history with this person, then their new message. Parts above it are the system prompt; parts below it are this turn's context, read after their message.",
    when: "Always.",
    kind: "marker",
    place: "ordered",
    placeholders: {},
    codeText: null,
  },
  {
    id: "campaign-context",
    name: "Campaign inputs",
    purpose: "The inputs the user launched the campaign with, when the turn is about one campaign.",
    when: "When the request names a campaign (not a proactive turn).",
    kind: "template",
    place: "ordered",
    placeholders: { campaignInputs: "The campaign's inputs, as JSON." },
    codeText:
      "\n\n---\n## Campaign Context\nThe user launched this campaign with the following inputs. Use them to inform your responses, suggestions, and any content you generate.\n{{campaignInputs}}",
  },
  {
    id: "request-context",
    name: "Page and recent actions",
    purpose: "What the app sent with this message: the page open, what the person just clicked (recentActions), ids in view.",
    when: "When the app sends context with the message (the web dashboard does).",
    kind: "template",
    place: "ordered",
    placeholders: { requestContext: "The context the app sent, as JSON." },
    codeText: "\n\n---\n## Additional Context (this request only)\n{{requestContext}}",
  },
  {
    id: "lead-turn",
    name: "Lead event answer",
    purpose: "Who Distry writes to and for, how it answers (answer_person), then the writer's own prompt and message as context.",
    when: "A Lead event turn (a campaign asks Distry to answer a person).",
    kind: "live",
    place: "ordered",
    placeholders: { leadTurnBlock: "The block built from the Lead event: brand, person, channel, the writer's prompt." },
    codeText: "{{leadTurnBlock}}",
  },
  {
    id: "telegram",
    name: "Telegram form",
    purpose: "How to write on Telegram: plain text, short, numbered choices.",
    when: "A Telegram turn.",
    kind: "text",
    place: "ordered",
    placeholders: {},
    codeText: buildTelegramBlock(),
  },
  {
    id: "website",
    name: "Website form",
    purpose: "How to write in the chat window of our website, who the visitor is, and the hand-off to another channel.",
    when: "A turn from our website's chat.",
    kind: "live",
    place: "ordered",
    placeholders: { websiteBlock: "The block built for this visitor: form, identity, hand-off." },
    codeText: "{{websiteBlock}}",
  },
  {
    id: "whatsapp",
    name: "WhatsApp form",
    purpose: "How to write on WhatsApp, the persona of the line, who the person is, the conversation strategy.",
    when: "A WhatsApp turn (not a Lead event).",
    kind: "live",
    place: "ordered",
    placeholders: { whatsappBlock: "The block built for this WhatsApp turn: line persona, identity, strategy." },
    codeText: "{{whatsappBlock}}",
  },
  {
    id: "dashboard-pages",
    name: "Dashboard pages",
    purpose: "The pages open_page can show beside the chat, and when to use cards.",
    when: "A dashboard turn (not WhatsApp, Telegram, the website or a Lead event).",
    kind: "text",
    place: "ordered",
    placeholders: {},
    codeText: dashboardPagesBlock(),
  },
  {
    id: "engines-unreadable",
    name: "Engines not read",
    purpose: "Says the Engine list could not be read this turn, so no Engine can be called.",
    when: "A staff conversation, when workflow-service's Engine list failed.",
    kind: "template",
    place: "ordered",
    placeholders: { why: "Why the read failed (first 200 characters)." },
    codeText: "\n\n---\n(Not read this turn: the list of Engines ({{why}}). No Engine can be called in this turn.)",
  },
  {
    id: "client-brief",
    name: "Their business",
    purpose: "What the client's business sells and to whom, read from their website and account.",
    when: "An account holder (or a guest whose website opened a plan) on a chat that speaks for us; never another brand's lead.",
    kind: "live",
    place: "ordered",
    placeholders: { clientBrief: "The brief: their brands, offers, what each sells and who buys (or why it could not be read)." },
    codeText: "{{clientBrief}}",
  },
  {
    id: "situation-brief",
    name: "Where the account stands",
    purpose: "The account as the client's dashboard shows it: today's date, campaigns and their state, results, replies waiting, money.",
    when: "An account holder's own turn (not a guest, a Lead event or a proactive turn).",
    kind: "live",
    place: "ordered",
    placeholders: { situationBrief: "The brief read from the account just before the message." },
    codeText: "{{situationBrief}}",
  },
  {
    id: "waiting-campaign",
    name: "Their campaign waits for them",
    purpose: "The campaign the founder built and paid for on the signup page, created stopped: it starts on their first message to Distry, on any channel (DISTRY-CHANNEL-HANDOFF-1125).",
    when: "A turn of that person (web, WhatsApp, email reply, Telegram) while that campaign has not been started yet.",
    kind: "template",
    place: "ordered",
    placeholders: { campaignId: "The id of the waiting campaign (campaign-service)." },
    codeText:
      "\n\n---\n## Their campaign is waiting for them\nOn our signup page they built a campaign (id {{campaignId}}), paid, and asked us to start it when they first talk to you. This message is that moment: start it in this turn with run_operation, method PATCH, path /v1/sales-funnel-campaigns/{{campaignId}}, body {\"status\": \"activate\"}. Their yes was given on the signup page, so this one call runs at once with no proposal; then tell them in a few words that it is running, and answer what they wrote. If they ask you to wait, or not to start it, do not start it.",
  },
  {
    id: "carried-work",
    name: "Lookups already made this turn",
    purpose: "When the model that started this answer went silent and another model takes over: what was already looked up, so it is not looked up again.",
    when: "A turn moved to the next model after its first model sent nothing for 30 s.",
    kind: "template",
    place: "ordered",
    placeholders: { lookups: "Each tool already called this turn, its arguments and its result." },
    codeText:
      "\n\n---\n## Already looked up for this message\nAnother model started this answer and stopped responding. These calls were made and their results stand: use them, do not make them again, and carry on from there.\n{{lookups}}",
  },
  {
    id: "brand-tools",
    name: "The brand's own tools",
    purpose: "How to use the MCP tools the writing brand plugged in.",
    when: "A Lead event turn whose brand plugged its own MCP tools.",
    kind: "text",
    place: "ordered",
    placeholders: {},
    codeText: brandToolsBlock(),
  },
  {
    id: "nudge-trigger",
    name: "Speak-first trigger",
    purpose: "Sent in the person's place when Distry decides to speak first on the dashboard (the nudge): what to look at and how to open.",
    when: "A nudge turn (the dashboard asked whether Distry speaks first, and the judgment said yes).",
    kind: "text",
    place: "message",
    placeholders: {},
    codeText: NUDGE_TRIGGER_MESSAGE,
  },
  {
    id: "final-round",
    name: "Last round note",
    purpose: "Sent beside the last tool results when the turn used its tool budget: answer now.",
    when: "After 10 tool rounds in one turn.",
    kind: "text",
    place: "loop",
    placeholders: {},
    codeText: FINAL_ROUND_NOTE,
  },
  {
    id: "silent-turn",
    name: "Silent turn note",
    purpose: "Sent once when tools ran but Distry wrote nothing: write the answer now.",
    when: "A turn that ran tools and ended without text.",
    kind: "text",
    place: "loop",
    placeholders: {},
    codeText: EMPTY_ANSWER_NOTE,
  },
  {
    id: "final-round-answer-tool",
    name: "Last round note (Lead event)",
    purpose: "The last-round note of a turn that must end by calling its answer tool.",
    when: "A Lead event turn after 10 tool rounds.",
    kind: "template",
    place: "loop",
    placeholders: { toolName: "The tool the turn must end on (answer_person)." },
    codeText: FINAL_ROUND_END_TOOL_TEMPLATE,
  },
  {
    id: "silent-turn-answer-tool",
    name: "Silent turn note (Lead event)",
    purpose: "Sent once when a Lead event turn stopped without calling its answer tool.",
    when: "A Lead event turn that ended without calling answer_person.",
    kind: "template",
    place: "loop",
    placeholders: { toolName: "The tool the turn must end on (answer_person)." },
    codeText: SILENT_END_TOOL_TEMPLATE,
  },
  {
    id: "engine-tool",
    name: "Engine tool description",
    purpose: "The description of each Engine tool (one tool per Engine that can run).",
    when: "A staff conversation, for each Engine in workflow-service's live list.",
    kind: "template",
    place: "tool",
    placeholders: {
      engineName: "The Engine's name (e.g. Message written).",
      waysToCall: "How the Engine can be called: its channels and the Units it takes.",
    },
    codeText: ENGINE_TOOL_DESCRIPTION_TEMPLATE,
  },
];

const SPEC_BY_ID = new Map(PROMPT_PARTS.map((p) => [p.id, p]));
const ORDERED_IDS = PROMPT_PARTS.filter((p) => p.place === "ordered").map((p) => p.id);

/** What a version stores: the order of the ordered parts, and the texts staff changed. */
export interface DistryPromptOverrides {
  /** Every ordered part id, once, `tools` first. */
  order: string[];
  /** Part id -> its text, ONLY where it differs from the code's (never `role`, never a marker). */
  texts: Record<string, string>;
  /** Tool name -> its description, ONLY where it differs from the code's. */
  toolDescriptions: Record<string, string>;
}

export function codePromptOverrides(): DistryPromptOverrides {
  return { order: [...ORDERED_IDS], texts: {}, toolDescriptions: {} };
}

export class PromptPartsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptPartsError";
  }
}

/**
 * Normalize + check what a save sends: the order names every ordered part once
 * with `tools` first; a text is set only on an editable part and may only use
 * that part's placeholders; a text or description equal to the code's is
 * dropped (it then follows the code). `codeToolDescription` = null for an unknown tool.
 */
export function normalizePromptOverrides(
  input: { order: string[]; texts: Record<string, string | null>; toolDescriptions: Record<string, string | null> },
  codeToolDescription: (name: string) => string | null,
): DistryPromptOverrides {
  const missing = ORDERED_IDS.filter((id) => !input.order.includes(id));
  const unknown = input.order.filter((id) => !ORDERED_IDS.includes(id));
  if (unknown.length) throw new PromptPartsError(`Unknown parts in order: ${unknown.join(", ")}.`);
  if (missing.length) throw new PromptPartsError(`The order must list every part: missing ${missing.join(", ")}.`);
  if (new Set(input.order).size !== input.order.length) throw new PromptPartsError("The order lists a part twice.");
  if (input.order[0] !== "tools") throw new PromptPartsError("`tools` stays first: every provider reads the tool definitions before the prompt.");
  const texts: Record<string, string> = {};
  for (const [id, text] of Object.entries(input.texts)) {
    const spec = SPEC_BY_ID.get(id);
    if (!spec) throw new PromptPartsError(`Unknown part: ${id}.`);
    if (spec.kind === "marker") throw new PromptPartsError(`${id} has no text of its own: it marks where ${spec.name.toLowerCase()} goes.`);
    if (id === "role") throw new PromptPartsError("The role's text is `systemPrompt`: edit it there.");
    if (text === null || text === spec.codeText) continue;
    const allowed = Object.keys(spec.placeholders);
    const bad = placeholdersIn(text).filter((n) => !allowed.includes(n));
    if (bad.length) {
      throw new PromptPartsError(`${id} uses {{${bad.join("}}, {{")}}}: it can only use ${allowed.length ? allowed.map((n) => `{{${n}}}`).join(", ") : "no placeholder"}.`);
    }
    texts[id] = text;
  }
  const toolDescriptions: Record<string, string> = {};
  for (const [name, description] of Object.entries(input.toolDescriptions)) {
    const code = codeToolDescription(name);
    if (code === null) throw new PromptPartsError(`Unknown tool: ${name}.`);
    if (description === null || description === code) continue;
    if (description.trim() === "") throw new PromptPartsError(`${name}: a tool description cannot be empty.`);
    toolDescriptions[name] = description;
  }
  return { order: [...input.order], texts, toolDescriptions };
}

/** A part's text as this definition sends it (the override, else the code's). */
export function partText(overrides: DistryPromptOverrides, id: string): string {
  const spec = SPEC_BY_ID.get(id);
  if (!spec || spec.codeText === null) throw new Error(`[distry-prompt] part "${id}" has no text`);
  return overrides.texts[id] ?? spec.codeText;
}

/**
 * The data one turn fills the parts with. A part whose data is absent (null /
 * false) is not sent this turn.
 */
export interface TurnPromptData {
  role: string;
  skillIndex: SkillIndexPieces | null;
  /** The model's public name, when the chat speaks for us. */
  modelName: string | null;
  campaignInputs: Record<string, unknown> | null;
  requestContext: Record<string, unknown> | null;
  leadTurnBlock: string | null;
  telegram: boolean;
  websiteBlock: string | null;
  whatsappBlock: string | null;
  dashboard: boolean;
  enginesUnreadable: string | null;
  clientBrief: string | null;
  situationBrief: string | null;
  /** The campaign waiting for this person's first message (copilot-handoff.ts), or null. */
  waitingCampaignId: string | null;
  brandTools: boolean;
  /** The lookups a silent model left behind (COPILOT-LATENCY-1125), formatted; null = a turn's first model. */
  carriedWork: string | null;
}

export function emptyTurnPromptData(role: string): TurnPromptData {
  return {
    role, skillIndex: null, modelName: null, campaignInputs: null, requestContext: null, leadTurnBlock: null, telegram: false,
    websiteBlock: null, whatsappBlock: null, dashboard: false, enginesUnreadable: null, clientBrief: null, situationBrief: null, waitingCampaignId: null, brandTools: false,
    carriedWork: null,
  };
}

/** The placeholder values of one part this turn, or null when the part is not sent. */
function partValues(id: string, d: TurnPromptData): Record<string, string> | null {
  switch (id) {
    case "role": return {};
    case "skill-index": return d.skillIndex ? { ...d.skillIndex } : null;
    case "about-you": return d.modelName !== null ? { modelName: d.modelName } : null;
    case "campaign-context": return d.campaignInputs && Object.keys(d.campaignInputs).length > 0 ? { campaignInputs: JSON.stringify(d.campaignInputs, null, 2) } : null;
    case "request-context": return d.requestContext && Object.keys(d.requestContext).length > 0 ? { requestContext: JSON.stringify(d.requestContext, null, 2) } : null;
    case "lead-turn": return d.leadTurnBlock !== null ? { leadTurnBlock: d.leadTurnBlock } : null;
    case "telegram": return d.telegram ? {} : null;
    case "website": return d.websiteBlock !== null ? { websiteBlock: d.websiteBlock } : null;
    case "whatsapp": return d.whatsappBlock !== null ? { whatsappBlock: d.whatsappBlock } : null;
    case "dashboard-pages": return d.dashboard ? {} : null;
    case "engines-unreadable": return d.enginesUnreadable !== null ? { why: d.enginesUnreadable } : null;
    case "client-brief": return d.clientBrief !== null ? { clientBrief: d.clientBrief } : null;
    case "situation-brief": return d.situationBrief !== null ? { situationBrief: d.situationBrief } : null;
    case "waiting-campaign": return d.waitingCampaignId !== null ? { campaignId: d.waitingCampaignId } : null;
    case "brand-tools": return d.brandTools ? {} : null;
    case "carried-work": return d.carriedWork !== null ? { lookups: d.carriedWork } : null;
    default: throw new Error(`[distry-prompt] no data rule for part "${id}"`);
  }
}

export interface RenderedPart {
  id: string;
  /** Where it went this turn. */
  placedIn: "tools" | "system" | "conversation" | "turn";
  sent: boolean;
  /** The text sent (null when not sent, or for a marker). */
  text: string | null;
}

export interface AssembledPrompt {
  /** The system prompt: every sent part above `conversation`, joined. */
  system: string;
  /** The turn's context: every sent part below `conversation`, joined. */
  turn: string;
  parts: RenderedPart[];
}

/** The one assembly /chat sends and the preview serves: system = parts above `conversation`, turn = parts below. */
export function assemblePrompt(overrides: DistryPromptOverrides, data: TurnPromptData): AssembledPrompt {
  let below = false;
  let system = "";
  let turn = "";
  const parts: RenderedPart[] = [];
  for (const id of overrides.order) {
    const spec = SPEC_BY_ID.get(id)!;
    if (spec.kind === "marker") {
      if (id === "conversation") below = true;
      parts.push({ id, placedIn: id === "tools" ? "tools" : "conversation", sent: true, text: null });
      continue;
    }
    const values = partValues(id, data);
    if (values === null) {
      parts.push({ id, placedIn: below ? "turn" : "system", sent: false, text: null });
      continue;
    }
    const text = id === "role" ? data.role : fillTemplate(partText(overrides, id), values);
    if (below) turn += text;
    else system += text;
    parts.push({ id, placedIn: below ? "turn" : "system", sent: true, text });
  }
  return { system, turn, parts };
}

/** The notes the tool loops send beside the last tool results (both loops, every provider). */
export function loopNotesFrom(overrides: DistryPromptOverrides): LoopNotes {
  return {
    finalRound: partText(overrides, "final-round"),
    silentTurn: partText(overrides, "silent-turn"),
    finalRoundAnswerTool: (toolName) => fillTemplate(partText(overrides, "final-round-answer-tool"), { toolName }),
    silentTurnAnswerTool: (toolName) => fillTemplate(partText(overrides, "silent-turn-answer-tool"), { toolName }),
  };
}

/** A tool's description as this definition sends it. */
export function withToolDescriptions<T extends { name: string; description?: string }>(tools: readonly T[], overrides: DistryPromptOverrides): T[] {
  return tools.map((t) => (Object.prototype.hasOwnProperty.call(overrides.toolDescriptions, t.name) ? { ...t, description: overrides.toolDescriptions[t.name] } : t));
}

/**
 * Distry's current overrides, held in memory (one process; set at boot and on
 * every save, like the skill set). Every other chat config reads the code's.
 */
let current: DistryPromptOverrides = codePromptOverrides();
export function setCurrentDistryPrompt(o: DistryPromptOverrides): void {
  current = { order: [...o.order], texts: { ...o.texts }, toolDescriptions: { ...o.toolDescriptions } };
}
export function currentDistryPrompt(): DistryPromptOverrides {
  return current;
}

/**
 * A stored version read against today's parts: an id the code no longer has is
 * dropped, a part the code added since goes right after the part it follows in
 * the code's order (never silently missing from the prompt).
 */
export function resolveStoredPrompt(stored: DistryPromptOverrides | null): DistryPromptOverrides {
  if (!stored) return codePromptOverrides();
  const order = stored.order.filter((id) => ORDERED_IDS.includes(id));
  ORDERED_IDS.forEach((id, i) => {
    if (order.includes(id)) return;
    const prev = ORDERED_IDS.slice(0, i).reverse().find((p) => order.includes(p));
    order.splice(prev ? order.indexOf(prev) + 1 : 0, 0, id);
  });
  // A text written for placeholders the part no longer has (skill-index before DISTRY-SKILL-MENTIONS-1122)
  // follows the code again: filling it would throw on every turn.
  const fits = (id: string, text: string) => placeholdersIn(text).every((n) => Object.keys(SPEC_BY_ID.get(id)!.placeholders).includes(n));
  const texts = Object.fromEntries(
    Object.entries(stored.texts).filter(([id, text]) => SPEC_BY_ID.has(id) && SPEC_BY_ID.get(id)!.codeText !== text && fits(id, text)),
  );
  return { order, texts, toolDescriptions: { ...stored.toolDescriptions } };
}

/** The parts as the editor shows them: in this version's order (ordered parts), then the loop notes and the tool template. */
export function partsForEditor(overrides: DistryPromptOverrides, role: string) {
  const row = (spec: PromptPartSpec) => ({
    id: spec.id,
    name: spec.name,
    purpose: spec.purpose,
    when: spec.when,
    kind: spec.kind,
    place: spec.place,
    placeholders: Object.entries(spec.placeholders).map(([name, means]) => ({ name, means })),
    editable: spec.kind !== "marker",
    text: spec.kind === "marker" ? null : spec.id === "role" ? role : partText(overrides, spec.id),
    codeText: spec.codeText,
    edited: Object.prototype.hasOwnProperty.call(overrides.texts, spec.id),
  });
  return [
    ...overrides.order.map((id) => row(SPEC_BY_ID.get(id)!)),
    ...PROMPT_PARTS.filter((p) => p.place !== "ordered").map(row),
  ];
}

/** The lookups a silent model left behind, one line each, for the `carried-work` part. */
export function formatCarriedWork(calls: ReadonlyArray<{ name: string; args: Record<string, unknown>; result?: unknown }>): string {
  return calls
    .map((c) => `- ${c.name}(${JSON.stringify(c.args)}) returned ${JSON.stringify(c.result ?? null)}`)
    .join("\n");
}
