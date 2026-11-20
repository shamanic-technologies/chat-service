// ---------------------------------------------------------------------------
// Distry's definition, versioned and editable (DISTRY-PRINCIPAL-1119, owner
// 2026-11-19: « Add an editor for Distry, which is OUR agent »).
//
// What Distry is (prompt, the tools it may call, the skills it reads, its
// model) used to live in code only (sophie.ts). It is now a row per save in
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
import { distryConfigVersions, platformConfigs, skills, type DistryConfigVersion } from "../db/schema.js";
import { ANTHROPIC_EFFORTS, CHAT_CONFIG_PROVIDERS, type AnthropicEffort } from "../schemas.js";
import { resolveModel, TOOL_REGISTRY, type Provider } from "../lib/anthropic.js";
import { SEED_EDITOR } from "../lib/skills.js";
import { SOPHIE_CONFIG } from "../lib/seed-platform-configs.js";
import { PRINCIPAL_TOOL_DESCRIPTIONS, ENGINES_TOOL_FAMILY } from "./principal-tools.js";

type Database = typeof db;

export type DistryProvider = (typeof CHAT_CONFIG_PROVIDERS)[number];

/** What a version holds: everything Distry is, nothing about who saved it. */
export interface DistryDefinition {
  systemPrompt: string;
  enabledTools: string[];
  /** null = every skill of the tree. */
  skillSlugs: string[] | null;
  provider: DistryProvider;
  model: string;
  /** Anthropic `output_config.effort`; null on another provider (or the model's default). */
  effort: AnthropicEffort | null;
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
    systemPrompt: SOPHIE_CONFIG.systemPrompt,
    enabledTools: [...SOPHIE_CONFIG.allowedTools],
    skillSlugs: null,
    provider: SOPHIE_CONFIG.provider,
    model: SOPHIE_CONFIG.model,
    effort: SOPHIE_CONFIG.effort,
  };
}

export function definitionOf(v: DistryConfigVersion): DistryDefinition {
  return {
    systemPrompt: v.systemPrompt,
    enabledTools: [...v.enabledTools],
    skillSlugs: v.skillSlugs ? [...v.skillSlugs] : null,
    provider: v.provider,
    model: v.model,
    effort: v.effort ?? null,
  };
}

export function sameDefinition(a: DistryDefinition, b: DistryDefinition): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Every tool a version may turn on, with what it does: the tool registry, plus
 * Distry's principal tools (`engines` = one tool per callable Engine, built at
 * run time). Served to the editor (each description whole, as the model reads it), and the check a save passes.
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

/** Refuses a definition /chat could not run. Pure (the skill slugs are passed in). */
export function validateDistryDefinition(def: DistryDefinition, knownSkillSlugs: readonly string[]): void {
  if (typeof def.systemPrompt !== "string" || def.systemPrompt.trim() === "") throw new DistryConfigError("systemPrompt is empty.");
  const known = new Set(availableDistryTools().map((t) => t.name));
  const unknown = def.enabledTools.filter((t) => !known.has(t));
  if (unknown.length > 0) throw new DistryConfigError(`Unknown tools: ${unknown.join(", ")}. See availableTools.`);
  if (new Set(def.enabledTools).size !== def.enabledTools.length) throw new DistryConfigError("enabledTools lists a tool twice.");
  if (def.skillSlugs) {
    const skillSet = new Set(knownSkillSlugs);
    const missing = def.skillSlugs.filter((s) => !skillSet.has(s));
    if (missing.length > 0) throw new DistryConfigError(`Unknown skills: ${missing.join(", ")}.`);
  }
  if (!(CHAT_CONFIG_PROVIDERS as readonly string[]).includes(def.provider)) {
    throw new DistryConfigError(`provider must be one of ${CHAT_CONFIG_PROVIDERS.join(", ")}.`);
  }
  try {
    resolveModel(def.provider as Provider, def.model as never);
  } catch (err) {
    throw new DistryConfigError(err instanceof Error ? err.message : String(err));
  }
  if (def.effort !== null) {
    if (def.provider !== "anthropic") throw new DistryConfigError("effort is an Anthropic setting: set it to null on another provider.");
    if (!(ANTHROPIC_EFFORTS as readonly string[]).includes(def.effort)) throw new DistryConfigError(`effort must be one of ${ANTHROPIC_EFFORTS.join(", ")}.`);
  }
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
 * The current version's skill set, held in memory (one chat-service process: every save goes
 * through it). Set at boot and on each save; /chat reads it with no query per turn.
 */
let currentSkillSet: string[] | null = null;
export function distrySkillSet(): string[] | null {
  return currentSkillSet;
}

/** Write a version's values onto the `copilot` platform config: what the next /chat turn reads. */
async function materialize(database: Database, def: DistryDefinition): Promise<void> {
  const row = {
    systemPrompt: def.systemPrompt,
    allowedTools: [...def.enabledTools],
    provider: def.provider,
    model: def.model,
    effort: def.effort,
    thinkingLevel: null,
    supportKind: SOPHIE_CONFIG.supportKind,
  };
  await database
    .insert(platformConfigs)
    .values({ key: SOPHIE_CONFIG.key, ...row })
    .onConflictDoUpdate({ target: [platformConfigs.key], set: { ...row, updatedAt: new Date() } });
  currentSkillSet = def.skillSlugs ? [...def.skillSlugs] : null;
}

async function knownSkillSlugs(database: Database): Promise<string[]> {
  const rows = await database.select({ slug: skills.slug }).from(skills);
  return rows.map((r) => r.slug);
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
  validateDistryDefinition(def, await knownSkillSlugs(database));
  try {
    return await database.transaction(async (tx) => {
      const [latest] = await tx.select({ version: distryConfigVersions.version }).from(distryConfigVersions).orderBy(desc(distryConfigVersions.version)).limit(1);
      const [row] = await tx
        .insert(distryConfigVersions)
        .values({
          version: (latest?.version ?? 0) + 1,
          systemPrompt: def.systemPrompt,
          enabledTools: [...def.enabledTools],
          skillSlugs: def.skillSlugs ? [...def.skillSlugs] : null,
          provider: def.provider,
          model: def.model,
          effort: def.effort,
          editedBy: meta.editedBy,
          note: meta.note ?? null,
          restoredFrom: meta.restoredFrom ?? null,
        })
        .returning();
      await materialize(tx as unknown as Database, def);
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
  if (differs) {
    console.log(`[chat-service] Distry config: version ${current.version} (saved by ${current.editedBy}) kept; the code's definition differs and is not applied`);
  }
  await materialize(database, definitionOf(current));
  return current;
}

export function toDistryVersionBody(v: DistryConfigVersion) {
  return {
    version: v.version,
    systemPrompt: v.systemPrompt,
    enabledTools: v.enabledTools,
    skillSlugs: v.skillSlugs ?? null,
    provider: v.provider,
    model: v.model,
    effort: v.effort ?? null,
    editedBy: v.editedBy,
    note: v.note ?? null,
    restoredFrom: v.restoredFrom ?? null,
    createdAt: v.createdAt.toISOString(),
  };
}

export { ENGINES_TOOL_FAMILY };
