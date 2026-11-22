import { describe, it, expect } from "vitest";
import {
  PROMPT_PARTS,
  assemblePrompt,
  codePromptOverrides,
  emptyTurnPromptData,
  loopNotesFrom,
  normalizePromptOverrides,
  partText,
  partsForEditor,
  resolveStoredPrompt,
  withToolDescriptions,
  PromptPartsError,
  type TurnPromptData,
} from "../../src/agent/distry-prompt.js";
import { examplesByPart, previewBody, promptAudience } from "../../src/agent/distry-prompt-samples.js";
import { buildSystemPrompt } from "../../src/lib/anthropic.js";
import { aboutYouBlock } from "../../src/lib/person-facing.js";
import { dashboardPagesBlock } from "../../src/agent/sophie.js";
import { buildTelegramBlock } from "../../src/lib/telegram-copilot.js";
import { brandToolsBlock } from "../../src/lib/lead-turn.js";
import { skillIndexBlockFrom, skillIndexPiecesFrom } from "../../src/lib/skills.js";
import { SEED_SKILLS } from "../../src/lib/skill-seed.js";
import { CODE_LOOP_NOTES, EMPTY_ANSWER_NOTE, FINAL_ROUND_NOTE, endToolFinalNote, endToolNudgeNote } from "../../src/lib/tool-budget.js";
import { NUDGE_TRIGGER_MESSAGE } from "../../src/lib/copilot-nudge.js";
import { fillTemplate, placeholdersIn } from "../../src/lib/prompt-template.js";
import type { DistryPromptSample } from "../../src/db/schema.js";

const ROLE = "You are Distry.";
const CODE = codePromptOverrides();
const noTool = () => null;

function fullData(): TurnPromptData {
  return {
    ...emptyTurnPromptData(ROLE),
    skillIndex: skillIndexPiecesFrom(ROLE, SEED_SKILLS),
    modelName: "Claude Haiku 5.5",
    campaignInputs: { goal: "meetings" },
    requestContext: { page: "today", recentActions: ["opened billing"] },
    dashboard: true,
    enginesUnreadable: "workflow-service 502",
    clientBrief: "\n\n---\n## Your client's business\nThey sell shoes.",
    situationBrief: "\n\n---\n## Where their account stands\n2 campaigns running.",
    brandTools: true,
  };
}

/** What /chat sent before the parts existed (DISTRY-PRINCIPAL-1119 code), rebuilt from the same builders. */
function legacy(d: TurnPromptData, surface: string): { system: string; turn: string } {
  const system = ROLE + (d.skillIndex ? skillIndexBlockFrom(ROLE, SEED_SKILLS) : "") + (d.modelName ? aboutYouBlock(d.modelName) : "");
  const turn =
    buildSystemPrompt("", d.requestContext ?? undefined, d.campaignInputs) +
    surface +
    (d.dashboard ? dashboardPagesBlock() : "") +
    (d.enginesUnreadable ? `\n\n---\n(Not read this turn: the list of Engines (${d.enginesUnreadable}). No Engine can be called in this turn.)` : "") +
    (d.clientBrief ?? "") +
    (d.situationBrief ?? "") +
    (d.brandTools ? brandToolsBlock() : "");
  return { system, turn };
}

describe("Distry's prompt parts (DISTRY-PROMPT-PARTS-1120)", () => {
  it("the code's parts assemble byte for byte what /chat sent before them, on every surface", () => {
    const d = fullData();
    const a = assemblePrompt(CODE, d);
    expect({ system: a.system, turn: a.turn }).toEqual(legacy(d, ""));

    const telegram = { ...d, telegram: true, dashboard: false };
    expect(assemblePrompt(CODE, telegram).turn).toBe(legacy(telegram, buildTelegramBlock()).turn);
    for (const [key, block] of [["leadTurnBlock", "\n\n## Lead turn"], ["websiteBlock", "\n\n## Website"], ["whatsappBlock", "\n\n## WhatsApp"]] as const) {
      const one = { ...d, [key]: block, dashboard: false };
      expect(assemblePrompt(CODE, one).turn).toBe(legacy(one, block).turn);
    }
    // A bare turn: the role alone, nothing after the conversation.
    const bare = emptyTurnPromptData(ROLE);
    expect(assemblePrompt(CODE, bare)).toMatchObject({ system: ROLE, turn: "" });
    // An empty context object adds nothing (as buildSystemPrompt did).
    expect(assemblePrompt(CODE, { ...bare, requestContext: {}, campaignInputs: {} }).turn).toBe("");
  });

  it("the sent parts add up to exactly the system prompt and the turn context: no hidden text", () => {
    const a = assemblePrompt(CODE, fullData());
    const join = (place: string) => a.parts.filter((p) => p.sent && p.placedIn === place).map((p) => p.text).join("");
    expect(join("system")).toBe(a.system);
    expect(join("turn")).toBe(a.turn);
    expect(a.parts.map((p) => p.id)).toEqual(CODE.order);
    expect(a.parts.find((p) => p.id === "telegram")).toMatchObject({ sent: false, text: null });
  });

  it("the loop notes, the nudge trigger and the skill index are the code's own texts", () => {
    const notes = loopNotesFrom(CODE);
    expect(notes.finalRound).toBe(FINAL_ROUND_NOTE);
    expect(notes.silentTurn).toBe(EMPTY_ANSWER_NOTE);
    expect(notes.finalRoundAnswerTool("answer_person")).toBe(endToolFinalNote("answer_person"));
    expect(notes.silentTurnAnswerTool("answer_person")).toBe(endToolNudgeNote("answer_person"));
    expect(CODE_LOOP_NOTES.finalRound).toBe(FINAL_ROUND_NOTE);
    expect(partText(CODE, "nudge-trigger")).toBe(NUDGE_TRIGGER_MESSAGE);
  });

  it("a reorder moves the text: two parts swapped, and a part dragged above the conversation joins the system prompt", () => {
    const d = fullData();
    const order = [...CODE.order];
    const i = order.indexOf("client-brief");
    const j = order.indexOf("situation-brief");
    [order[i], order[j]] = [order[j]!, order[i]!];
    const swapped = assemblePrompt({ ...CODE, order }, d);
    expect(swapped.turn.indexOf("2 campaigns running")).toBeLessThan(swapped.turn.indexOf("They sell shoes"));

    const up = CODE.order.filter((id) => id !== "dashboard-pages");
    up.splice(up.indexOf("conversation"), 0, "dashboard-pages");
    const moved = assemblePrompt({ ...CODE, order: up }, d);
    expect(moved.system.endsWith(dashboardPagesBlock())).toBe(true);
    expect(moved.turn).not.toContain(dashboardPagesBlock());
    expect(moved.parts.find((p) => p.id === "dashboard-pages")?.placedIn).toBe("system");
  });

  it("an edited text is sent in place of the code's; a live part's template wraps the built block", () => {
    const o = normalizePromptOverrides(
      { order: CODE.order, texts: { "about-you": "\n\n## Model\nYou run on {{modelName}}.", "situation-brief": "\n\nREAD THIS FIRST{{situationBrief}}", telegram: null }, toolDescriptions: {} },
      noTool,
    );
    const a = assemblePrompt(o, fullData());
    expect(a.system).toContain("\n\n## Model\nYou run on Claude Haiku 5.5.");
    expect(a.turn).toContain("\n\nREAD THIS FIRST\n\n---\n## Where their account stands");
    // A null text, or the code's own text, follows the code (stored as no override).
    expect(o.texts).not.toHaveProperty("telegram");
    expect(normalizePromptOverrides({ order: CODE.order, texts: { telegram: buildTelegramBlock() }, toolDescriptions: {} }, noTool).texts).toEqual({});
  });

  it("refuses what /chat could not send: a missing or unknown part, tools moved, a foreign placeholder, a marker or the role edited", () => {
    const save = (patch: Partial<{ order: string[]; texts: Record<string, string | null>; toolDescriptions: Record<string, string | null> }>) => () =>
      normalizePromptOverrides({ order: CODE.order, texts: {}, toolDescriptions: {}, ...patch }, (n) => (n === "read_skill" ? "Read a skill." : null));
    expect(save({ order: CODE.order.slice(1) })).toThrow(/missing tools/);
    expect(save({ order: [...CODE.order, "ghost"] })).toThrow(/Unknown parts in order: ghost/);
    expect(save({ order: [...CODE.order.slice(1, 3), "tools", ...CODE.order.slice(3)] })).toThrow(/`tools` stays first/);
    expect(save({ order: [...CODE.order, "role"] })).toThrow(/twice/);
    expect(save({ texts: { "about-you": "on {{orgName}}" } })).toThrow(/can only use \{\{modelName\}\}/);
    expect(save({ texts: { telegram: "Hi {{name}}" } })).toThrow(/no placeholder/);
    expect(save({ texts: { conversation: "x" } })).toThrow(PromptPartsError);
    expect(save({ texts: { role: "x" } })).toThrow(/systemPrompt/);
    expect(save({ toolDescriptions: { nope: "x" } })).toThrow(/Unknown tool: nope/);
    expect(save({ toolDescriptions: { read_skill: " " } })).toThrow(/cannot be empty/);
    expect(save({ toolDescriptions: { read_skill: "Read a skill." } })().toolDescriptions).toEqual({});
    expect(save({ toolDescriptions: { read_skill: "Read one skill." } })().toolDescriptions).toEqual({ read_skill: "Read one skill." });
  });

  it("a tool description staff rewrote replaces the code's for that tool only", () => {
    const tools = [{ name: "read_skill", description: "code" }, { name: "open_page", description: "code 2" }];
    expect(withToolDescriptions(tools, { ...CODE, toolDescriptions: { read_skill: "edited" } })).toEqual([
      { name: "read_skill", description: "edited" },
      { name: "open_page", description: "code 2" },
    ]);
  });

  it("a stored version from before a new part reads it at its code place; a removed part is dropped", () => {
    const old = { order: CODE.order.filter((id) => id !== "brand-tools" && id !== "about-you"), texts: { telegram: "T" }, toolDescriptions: {} };
    const resolved = resolveStoredPrompt({ ...old, order: [...old.order, "retired-part"] });
    expect(resolved.order).toEqual(CODE.order);
    expect(resolved.texts).toEqual({ telegram: "T" });
    expect(resolveStoredPrompt(null)).toEqual(CODE);
  });

  it("serves every part in order, then the message trigger, loop notes and Engine tool template, with the role's text = systemPrompt", () => {
    const rows = partsForEditor(CODE, ROLE);
    expect(rows.map((r) => r.id)).toEqual([...CODE.order, ...PROMPT_PARTS.filter((p) => p.place !== "ordered").map((p) => p.id)]);
    expect(rows.find((r) => r.id === "role")).toMatchObject({ text: ROLE, editable: true, edited: false });
    expect(rows.find((r) => r.id === "conversation")).toMatchObject({ text: null, editable: false });
    for (const r of rows) {
      if (r.kind === "template" || r.kind === "live") {
        expect(placeholdersIn(r.codeText!).sort()).toEqual(r.placeholders.map((p) => p.name).sort());
      }
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.when.length).toBeGreaterThan(0);
    }
  });

  it("a staff-only part reaches no client turn: no Engine note without the staff Engine read", () => {
    const client = { ...fullData(), enginesUnreadable: null };
    expect(assemblePrompt(CODE, client).turn).not.toContain("list of Engines");
    expect(promptAudience({ principal: false, leadTurn: false, guest: false })).toBe("client");
    expect(promptAudience({ principal: true, leadTurn: false, guest: false })).toBe("staff");
    expect(promptAudience({ principal: false, leadTurn: true, guest: true })).toBe("lead");
  });

  it("fills a template in one pass: data that quotes {{x}} is inserted verbatim; a missing value throws", () => {
    expect(fillTemplate("A {{a}} B", { a: "{{b}}" })).toBe("A {{b}} B");
    expect(() => fillTemplate("{{a}}", {})).toThrow(/no value was given/);
  });

  it("the preview says whether a recorded turn's parts add up, and each part's example comes from a staff turn first", () => {
    const a = assemblePrompt(CODE, fullData());
    const row = (audience: "staff" | "client", parts = a.parts): DistryPromptSample => ({
      audience, version: 3, orgId: `org-${audience}`, sessionId: null, provider: "anthropic", model: "claude-haiku-5-5",
      systemPrompt: a.system, turnContext: a.turn, tools: [], parts, historyMessages: 2, userMessage: "hi", recordedAt: new Date("2026-11-20T10:00:00Z"),
    });
    expect(previewBody(row("staff")).partsMatch).toBe(true);
    expect(previewBody(row("staff", a.parts.filter((p) => p.id !== "situation-brief"))).partsMatch).toBe(false);
    const ex = examplesByPart([row("client"), row("staff")]);
    expect(ex.get("situation-brief")).toMatchObject({ audience: "staff", orgId: "org-staff" });
    expect(ex.has("telegram")).toBe(false);
  });
});
