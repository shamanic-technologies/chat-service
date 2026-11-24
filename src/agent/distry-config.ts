// ---------------------------------------------------------------------------
// Distry's definition, versioned and editable (DISTRY-PRINCIPAL-1119, owner
// 2026-11-19: « Add an editor for Distry, which is OUR agent »).
//
// What Distry is (prompt, the tools it may call, its model) used to live in code only (sophie.ts). It is now a row per save in
// `distry_config_versions`: the highest version is current and is written onto
// the `copilot` platform config, which is what /chat reads on every turn. So a
// save changes the next turn, and a restore (a NEW version carrying an old
// one's values) does too. Nothing is ever updated in place.
//
// The code still seeds it, the way skills are seeded: version 1 = the code's
// values at ship (no behaviour change), and while every version since the last
// human save was written by the seed, a code change adds the next version at
// boot. Once staff saved one, a deploy never overwrites it (it logs that the
// code moved, so the editor shows the code's values beside the current ones).
// ---------------------------------------------------------------------------

import { desc, eq } from "drizzle-orm";
import type { db } from "../db/index.js";
import { distryConfigVersions, platformConfigs, type DistryConfigVersion } from "../db/schema.js";
import { CHAT_CONFIG_PROVIDERS, type AnthropicEffort } from "../schemas.js";
import { thinkingLevelRefusal } from "../lib/thinking-levels.js";
import type { GeminiThinkingLevel } from "../lib/gemini.js";
import { resolveModel, TOOL_REGISTRY, type Provider } from "../lib/anthropic.js";
import { SEED_EDITOR, listSkills, resolveSkillSlug, writeSkill, type SkillText } from "../lib/skills.js";
import { MERGED_SKILL_SLUGS, SEED_SKILLS } from "../lib/skill-seed.js";
import {
  buildMentionGraph,
  convertReferencesToMentions,
  foldAlwaysReadIntoPrompt,
  foldChildrenIntoSkill,
  linksOfOffGraph,
  mentionedSkillSlugs,
  type MentionGraph,
  type SkillLinks,
} from "../lib/skill-mentions.js";
import { SOPHIE_CONFIG } from "../lib/seed-platform-configs.js";
import { PRINCIPAL_TOOL_DESCRIPTIONS } from "./principal-tools.js";
import { OUTCOME_TOOL_NAMES } from "./outcome-tools.js";
import {
  codePromptOverrides,
  normalizePromptOverrides,
  PromptPartsError,
  resolveStoredPrompt,
  setCurrentDistryPrompt,
  type DistryPromptOverrides,
} from "./distry-prompt.js";

type Database = typeof db;

export type DistryProvider = (typeof CHAT_CONFIG_PROVIDERS)[number];

/** What a version holds: everything Distry is, nothing about who saved it. */
export interface DistryDefinition {
  systemPrompt: string;
  enabledTools: string[];
  provider: DistryProvider;
  model: string;
  /**
   * The thinking level Distry runs its model at, any provider (DISTRY-THINKING-1122): Anthropic
   * `output_config.effort`, Gemini `thinkingLevel`, a direct vendor's level (`none` = reasoning off).
   * One of `chatThinkingLevels(provider, model)`; null = the model's default.
   */
  effort: string | null;
  /**
   * Every other text Distry reads and its order (DISTRY-PROMPT-PARTS-1120,
   * distry-prompt.ts): the order of the parts, and the texts and tool
   * descriptions staff changed (only those; the rest follows the code).
   */
  prompt: DistryPromptOverrides;
}

export class DistryConfigError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = "DistryConfigError";
  }
}

/** Distry as the code defines it (sophie.ts): version 1, and what the seed compares with. */
export function codeDistryDefinition(): DistryDefinition {
  return {
    // DISTRY-SKILL-MENTIONS-1122: the Prompt is the one text read every turn, so it carries the
    // `index` method and the `client-comms` voice, and mentions what `index` mapped.
    // References to a skill or a tool are mention tokens (owner 2026-11-22: chips in the editor).
    systemPrompt: convertReferencesToMentions(
      foldAlwaysReadIntoPrompt(SOPHIE_CONFIG.systemPrompt, SEED_SKILLS),
      new Set(SEED_SKILLS.map((s) => s.slug).filter((s) => !(s in MERGED_SKILL_SLUGS))),
      new Set(mentionableTools()),
    ).text,
    enabledTools: [...SOPHIE_CONFIG.allowedTools],
    provider: SOPHIE_CONFIG.provider,
    model: SOPHIE_CONFIG.model,
    effort: SOPHIE_CONFIG.effort,
    prompt: codePromptOverrides(),
  };
}

/**
 * The retired `engines` entry (one campaign-launching tool per Engine, DISTRY-CALL-IS-CAMPAIGN-1121)
 * stands for the Outcome tools that replaced it (ENGINE-GET-ASK-1123, owner 2026-11-23 « Distry must
 * use Outcomes exactly like a Script »): a stored version listing it reads as listing them, in its place.
 */
export const RETIRED_ENGINES_ENTRY = "engines";
export function withOutcomeToolsForEngines(tools: readonly string[]): string[] {
  if (!tools.includes(RETIRED_ENGINES_ENTRY)) return [...tools];
  const out: string[] = [];
  for (const t of tools) {
    for (const n of t === RETIRED_ENGINES_ENTRY ? OUTCOME_TOOL_NAMES : [t]) if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Who wrote the one-time move of a stored `engines` entry to the Outcome tools. */
export const ENGINES_FOLD_EDITOR = "fold ENGINE-GET-ASK-1123";

export function definitionOf(v: DistryConfigVersion): DistryDefinition {
  return {
    systemPrompt: v.systemPrompt,
    enabledTools: withOutcomeToolsForEngines(v.enabledTools),
    provider: v.provider,
    model: v.model,
    effort: v.effort ?? null,
    prompt: resolveStoredPrompt(v.promptParts ?? null),
  };
}

export function sameDefinition(a: DistryDefinition, b: DistryDefinition): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Every tool a version may turn on, with what it does: the tool registry, plus
 * Distry's principal tools. Served to the editor (each description whole, as the model reads it), and the check a save passes.
 */
export function availableDistryTools(): Array<{ name: string; description: string; staffOnly: boolean }> {
  const registry = Object.values(TOOL_REGISTRY).map((t) => ({
    name: t.name,
    // The WHOLE description, every line: what the model reads for this tool (owner 2026-11-19, a cut one read
    // « …the people l » in the editor).
    description: t.description ?? "",
    staffOnly: Object.prototype.hasOwnProperty.call(PRINCIPAL_TOOL_DESCRIPTIONS, t.name),
  }));
  const seen = new Set(registry.map((t) => t.name));
  const principal = Object.entries(PRINCIPAL_TOOL_DESCRIPTIONS)
    .filter(([name]) => !seen.has(name))
    .map(([name, description]) => ({ name, description, staffOnly: true }));
  return [...registry, ...principal].sort((a, b) => a.name.localeCompare(b.name));
}

/** A tool's description as the code writes it (null = not a tool Distry can turn on). */
export function codeToolDescription(name: string): string | null {
  return availableDistryTools().find((t) => t.name === name)?.description ?? null;
}

/** Normalize what a save sends for the prompt parts (order, changed texts, changed tool descriptions). */
export function promptOverridesFrom(input: {
  order: string[];
  texts: Record<string, string | null>;
  toolDescriptions: Record<string, string | null>;
}): DistryPromptOverrides {
  try {
    return normalizePromptOverrides(input, codeToolDescription);
  } catch (err) {
    if (err instanceof PromptPartsError) throw new DistryConfigError(err.message);
    throw err;
  }
}

/**
 * A `PUT /internal/distry/config` body -> the definition to save
 * (DISTRY-NO-SKILL-PICKS-1122: no skill list; a stray `skillSlugs` is stripped by the schema).
 * The prompt parts follow the current version unless the save sends their whole state.
 */
export function definitionFromSaveRequest(
  body: Omit<DistryDefinition, "prompt"> & {
    prompt?: { order: string[]; texts: Record<string, string | null>; toolDescriptions: Record<string, string | null> };
  },
  currentPrompt: DistryPromptOverrides,
): DistryDefinition {
  return {
    systemPrompt: body.systemPrompt,
    enabledTools: [...body.enabledTools],
    provider: body.provider,
    model: body.model,
    effort: body.effort,
    prompt: body.prompt ? promptOverridesFrom(body.prompt) : currentPrompt,
  };
}

/** Refuses a definition /chat could not run. Pure. */
export function validateDistryDefinition(def: DistryDefinition): void {
  if (typeof def.systemPrompt !== "string" || def.systemPrompt.trim() === "") throw new DistryConfigError("systemPrompt is empty.");
  const known = new Set(availableDistryTools().map((t) => t.name));
  const unknown = def.enabledTools.filter((t) => !known.has(t));
  if (unknown.length > 0) throw new DistryConfigError(`Unknown tools: ${unknown.join(", ")}. See availableTools.`);
  if (new Set(def.enabledTools).size !== def.enabledTools.length) throw new DistryConfigError("enabledTools lists a tool twice.");
  if (!(CHAT_CONFIG_PROVIDERS as readonly string[]).includes(def.provider)) {
    throw new DistryConfigError(`provider must be one of ${CHAT_CONFIG_PROVIDERS.join(", ")}.`);
  }
  let resolved: ReturnType<typeof resolveModel>;
  try {
    resolved = resolveModel(def.provider as Provider, def.model as never);
  } catch (err) {
    throw new DistryConfigError(err instanceof Error ? err.message : String(err));
  }
  if (def.effort !== null) {
    const refusal = thinkingLevelRefusal(def.provider as Provider, resolved.apiModelId, resolved.apiModelId, def.effort);
    if (refusal) throw new DistryConfigError(`effort "${def.effort}": ${refusal}`);
  }
  // Re-normalizing a stored-shape prompt is idempotent: it refuses what a hand-built definition got wrong.
  promptOverridesFrom(def.prompt);
}

export async function listDistryVersions(database: Database): Promise<DistryConfigVersion[]> {
  return database.select().from(distryConfigVersions).orderBy(desc(distryConfigVersions.version));
}

export async function currentDistryVersion(database: Database): Promise<DistryConfigVersion | null> {
  const [row] = await database.select().from(distryConfigVersions).orderBy(desc(distryConfigVersions.version)).limit(1);
  return row ?? null;
}

export async function getDistryVersion(database: Database, version: number): Promise<DistryConfigVersion> {
  const [row] = await database.select().from(distryConfigVersions).where(eq(distryConfigVersions.version, version));
  if (!row) throw new DistryConfigError(`Distry has no version ${version}.`, 404);
  return row;
}

/**
 * Distry reads EVERY live skill of the tree, new ones included (DISTRY-NO-SKILL-PICKS-1122,
 * owner 2026-11-22 « enlève même ce concept de tick box. Si je ne veux pas une skill je la
 * supprime »). A definition carries no skill list: a skill Distry must not read is deleted
 * from the tree. Old versions' stored `skill_slugs` are history only, never read.
 */

/** The current version's number, held with the rest (stamped on each recorded prompt sample). */
let currentVersionNumber: number | null = null;
export function distryVersionNumber(): number | null {
  return currentVersionNumber;
}

/**
 * One level, written where the provider's loop reads it (DISTRY-THINKING-1122): the Anthropic loop
 * reads `effort`; the Gemini and direct-vendor loops read `thinking_level`.
 */
export function thinkingColumns(def: Pick<DistryDefinition, "provider" | "effort">): { effort: AnthropicEffort | null; thinkingLevel: GeminiThinkingLevel | null } {
  if (def.provider === "anthropic") return { effort: def.effort as AnthropicEffort | null, thinkingLevel: null };
  // The column is text typed with Gemini's words; a vendor level (`none`, `xhigh`, `max`) rides it too.
  return { effort: null, thinkingLevel: def.effort as GeminiThinkingLevel | null };
}

/** Write a version's values onto the `copilot` platform config: what the next /chat turn reads. */
async function materialize(database: Database, def: DistryDefinition, version: number): Promise<void> {
  const row = {
    systemPrompt: def.systemPrompt,
    allowedTools: [...def.enabledTools],
    provider: def.provider,
    model: def.model,
    ...thinkingColumns(def),
    supportKind: SOPHIE_CONFIG.supportKind,
  };
  await database
    .insert(platformConfigs)
    .values({ key: SOPHIE_CONFIG.key, ...row })
    .onConflictDoUpdate({ target: [platformConfigs.key], set: { ...row, updatedAt: new Date() } });
  setCurrentDistryPrompt(def.prompt);
  currentVersionNumber = version;
}

/**
 * Save = a new version (current + 1), written onto the `copilot` config in the
 * same transaction. Two saves at once: the second meets the unique version and
 * is refused 409 (read again, then save).
 */
export async function saveDistryVersion(
  database: Database,
  def: DistryDefinition,
  meta: { editedBy: string; note?: string | null; restoredFrom?: number | null },
): Promise<DistryConfigVersion> {
  validateDistryDefinition(def);
  try {
    return await database.transaction(async (tx) => {
      const [latest] = await tx.select({ version: distryConfigVersions.version }).from(distryConfigVersions).orderBy(desc(distryConfigVersions.version)).limit(1);
      const [row] = await tx
        .insert(distryConfigVersions)
        .values({
          version: (latest?.version ?? 0) + 1,
          systemPrompt: def.systemPrompt,
          enabledTools: [...def.enabledTools],
          provider: def.provider,
          model: def.model,
          effort: def.effort,
          promptParts: def.prompt,
          editedBy: meta.editedBy,
          note: meta.note ?? null,
          restoredFrom: meta.restoredFrom ?? null,
        })
        .returning();
      await materialize(tx as unknown as Database, def, row.version);
      return row;
    });
  } catch (err) {
    if (err instanceof Error && /distry_config_versions_version_unique/.test(`${err.message} ${(err as { constraint_name?: string }).constraint_name ?? ""}`)) {
      throw new DistryConfigError("Another save landed first: read the current version again, then save.", 409);
    }
    throw err;
  }
}

/** Restore = a NEW version carrying an old one's values (history is never rewritten). */
export async function restoreDistryVersion(database: Database, version: number, editedBy: string): Promise<DistryConfigVersion> {
  const old = await getDistryVersion(database, version);
  return saveDistryVersion(database, definitionOf(old), { editedBy, note: `Restored version ${version}`, restoredFrom: version });
}

/**
 * At boot: version 1 from the code when none exists; a new seed version when
 * the code moved and no human saved since; then the current version is written
 * onto the `copilot` config. O(1), safe before listen(). Fails loud.
 */
export async function seedDistryConfig(database: Database): Promise<DistryConfigVersion> {
  const code = codeDistryDefinition();
  let current = await currentDistryVersion(database);
  if (!current) {
    current = await saveDistryVersion(database, code, { editedBy: SEED_EDITOR, note: "Version 1: Distry as the code defined it at ship." });
    console.log(`[chat-service] Distry config: version 1 seeded from code (${code.provider}/${code.model}, ${code.enabledTools.length} tools)`);
    return current;
  }
  const differs = !sameDefinition(definitionOf(current), code);
  if (differs && current.editedBy === SEED_EDITOR) {
    current = await saveDistryVersion(database, code, { editedBy: SEED_EDITOR, note: "The code moved: seeded from code." });
    console.log(`[chat-service] Distry config: version ${current.version} seeded from code`);
    return current;
  }
  if (current.enabledTools.includes(RETIRED_ENGINES_ENTRY)) {
    // A staff save is never overwritten: the new version keeps every value, the retired entry read as its replacement.
    current = await saveDistryVersion(database, definitionOf(current), {
      editedBy: ENGINES_FOLD_EDITOR,
      note: "Engines: the per-Engine campaign tools became find_outcome, get_units and ask_engine (read held Units, ask an Engine for one new Unit).",
    });
    console.log(`[chat-service] Distry config: version ${current.version} moved the engines entry to the Outcome tools`);
    return current;
  }
  if (differs) {
    console.log(`[chat-service] Distry config: version ${current.version} (saved by ${current.editedBy}) kept; the code's definition differs and is not applied`);
  }
  await materialize(database, definitionOf(current), current.version);
  return current;
}

export function toDistryVersionBody(v: DistryConfigVersion) {
  return {
    version: v.version,
    systemPrompt: v.systemPrompt,
    enabledTools: v.enabledTools,
    provider: v.provider,
    model: v.model,
    effort: v.effort ?? null,
    prompt: resolveStoredPrompt(v.promptParts ?? null),
    editedBy: v.editedBy,
    note: v.note ?? null,
    restoredFrom: v.restoredFrom ?? null,
    createdAt: v.createdAt.toISOString(),
  };
}

// --- Mentions (DISTRY-SKILL-MENTIONS-1122) -----------------------------------

/** Who wrote the one-time move from the stored tree to mentions. */
export const MENTIONS_FOLD_EDITOR = "fold DISTRY-SKILL-MENTIONS-1122";

/** Tools a text may mention: every tool Distry can turn on. */
export function mentionableTools(): string[] {
  return availableDistryTools().map((t) => t.name);
}

/**
 * The one-time move from the stored tree to mentions, at boot, after the skill
 * seed. Runs while Distry's current Prompt mentions no skill (once folded, it
 * does): each live skill that had live sub-skills gains a mention of each
 * (a seed skill already carries them from the seed), then a new Distry version
 * carries `index` + `client-comms` in its Prompt and mentions what `index`
 * mapped. Staff texts are kept and extended, never replaced. Fails loud.
 */
export async function foldTreeIntoMentions(database: Database): Promise<{ promptVersion: number | null; skills: string[] }> {
  const current = await currentDistryVersion(database);
  if (!current) throw new Error("[distry] foldTreeIntoMentions: no Distry version yet (seedDistryConfig runs first)");
  if (mentionedSkillSlugs(current.systemPrompt).length > 0) return { promptVersion: null, skills: [] };
  const live = await listSkills(database);
  const folded: string[] = [];
  for (const skill of live) {
    const content = foldChildrenIntoSkill(skill, live);
    if (content === null) continue;
    await writeSkill(database, skill.slug, { content, editedBy: MENTIONS_FOLD_EDITOR });
    folded.push(skill.slug);
  }
  const def = definitionOf(current);
  const saved = await saveDistryVersion(
    database,
    { ...def, systemPrompt: foldAlwaysReadIntoPrompt(def.systemPrompt, live) },
    { editedBy: MENTIONS_FOLD_EDITOR, note: "Skills are linked by mentions: the index and the voice moved into the Prompt, which mentions the skills the index listed." },
  );
  return { promptVersion: saved.version, skills: folded };
}

/** The mention graph over the live skills, rooted at Distry's current Prompt. */
export async function skillMentionGraph(database: Database): Promise<{ graph: MentionGraph; prompt: string; live: SkillText[] }> {
  const current = await currentDistryVersion(database);
  const prompt = current?.systemPrompt ?? codeDistryDefinition().systemPrompt;
  const live = await listSkills(database);
  return { graph: buildMentionGraph(prompt, live, mentionableTools(), (s) => resolveSkillSlug(live, s)), prompt, live };
}

/** One skill's links in that graph (a deleted skill: what it mentions, who still mentions it). */
export function linksOf(view: { graph: MentionGraph; prompt: string; live: SkillText[] }, skill: { slug: string; content: string }): SkillLinks {
  return (
    view.graph.skills.get(skill.slug) ??
    linksOfOffGraph(skill, view.prompt, view.live, mentionableTools(), (s) => resolveSkillSlug(view.live, s))
  );
}

/** Who wrote the move of old-style references (backticks, bare names) to mention tokens. */
export const MENTION_REFS_EDITOR = "refs DISTRY-SKILL-MENTIONS-1122";

/**
 * At boot, after the seed and the fold: every reference to a live skill or a mentionable tool still
 * written the old way (backticks, bare names) in Distry's Prompt and in the skills staff edited
 * becomes its mention token (owner 2026-11-22 « Je ne vois pas de @<> tag stylisé dans les textes »).
 * Seed-owned rows are converted by the seed itself (seedsAsRead) and keep refreshing. Idempotent:
 * a converted text converts to itself, so a later boot writes nothing. A Prompt change is a new
 * Distry version. Returns how many references were converted, for the boot log.
 */
export async function convertStoredReferences(database: Database): Promise<{ prompt: number; skills: Record<string, number> }> {
  const live = await listSkills(database);
  const slugs = new Set(live.map((s) => s.slug));
  const tools = new Set(mentionableTools());
  const skillCounts: Record<string, number> = {};
  for (const skill of live) {
    if (skill.updatedBy === SEED_EDITOR) continue;
    const { text, converted } = convertReferencesToMentions(skill.content, slugs, tools);
    if (converted === 0) continue;
    await writeSkill(database, skill.slug, { content: text, editedBy: MENTION_REFS_EDITOR });
    skillCounts[skill.slug] = converted;
  }
  const current = await currentDistryVersion(database);
  if (!current) throw new Error("[distry] convertStoredReferences: no Distry version yet");
  const { text, converted } = convertReferencesToMentions(current.systemPrompt, slugs, tools);
  if (converted > 0) {
    await saveDistryVersion(
      database,
      { ...definitionOf(current), systemPrompt: text },
      { editedBy: MENTION_REFS_EDITOR, note: `${converted} references to a skill or a tool written as mentions (@skill: / @tool:).` },
    );
  }
  return { prompt: converted, skills: skillCounts };
}

/** Read-only: how many old-style references each live text holds now (Prompt + every skill), for the boot log. */
export async function countPendingReferences(database: Database): Promise<{ prompt: number; skills: number }> {
  const live = await listSkills(database);
  const slugs = new Set(live.map((s) => s.slug));
  const tools = new Set(mentionableTools());
  const current = await currentDistryVersion(database);
  const skills = live.reduce((n, s) => n + convertReferencesToMentions(s.content, slugs, tools).converted, 0);
  return { prompt: current ? convertReferencesToMentions(current.systemPrompt, slugs, tools).converted : 0, skills };
}
