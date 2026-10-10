import { and, asc, desc, eq } from "drizzle-orm";
import type { db as Db } from "../db/index.js";
import { skills, skillVersions, type Skill, type SkillVersion } from "../db/schema.js";
import { SEED_SKILLS, type SeedSkill } from "./skill-seed.js";

// ---------------------------------------------------------------------------
// Copilot SKILL TREE store.
//
// The Copilot's knowledge of the platform is a tree of markdown skills: an
// INDEX (always in the prompt) and one sub-skill per topic, loaded on demand
// with the `read_skill` tool. Staff edit the content live from the dashboard
// (autosave), so this table, not the code, is the source of truth once a human
// has touched a row.
//
// Seeding rule (NEVER clobber a human edit): at boot, a seed skill absent from
// the table is inserted; a row whose current content was written by the seed
// (`updated_by = "seed"`) is refreshed to the code's content when it differs;
// a row any human edited is left exactly as it is, forever.
// ---------------------------------------------------------------------------

export const SEED_EDITOR = "seed";
export const INDEX_SKILL_SLUG = "index";

/** A typing burst by one editor inside this window is ONE version. */
export const SKILL_VERSION_COALESCE_MS = 10 * 60_000;

export const SKILL_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class SkillNotFoundError extends Error {
  constructor(public readonly slug: string) {
    super(`No skill "${slug}". Call read_skill with a slug listed in the skill index.`);
    this.name = "SkillNotFoundError";
  }
}

export class SkillValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillValidationError";
  }
}

type Database = typeof Db;

export interface SkillSummary {
  slug: string;
  parentSlug: string | null;
  title: string;
  description: string;
  position: number;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

export function toSkillSummary(s: Skill): SkillSummary {
  return {
    slug: s.slug,
    parentSlug: s.parentSlug,
    title: s.title,
    description: s.description,
    position: s.position,
    version: s.version,
    updatedBy: s.updatedBy,
    updatedAt: s.updatedAt.toISOString(),
  };
}

export function toSkillBody(s: Skill) {
  return { ...toSkillSummary(s), content: s.content, createdAt: s.createdAt.toISOString() };
}

export function toSkillVersionBody(v: SkillVersion) {
  return {
    version: v.version,
    title: v.title,
    description: v.description,
    content: v.content,
    editedBy: v.editedBy,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

export async function listSkills(database: Database): Promise<Skill[]> {
  return database.select().from(skills).orderBy(asc(skills.position), asc(skills.slug));
}

export async function getSkill(database: Database, slug: string): Promise<Skill> {
  const [row] = await database.select().from(skills).where(eq(skills.slug, slug));
  if (!row) throw new SkillNotFoundError(slug);
  return row;
}

export async function listSkillVersions(database: Database, slug: string): Promise<SkillVersion[]> {
  const skill = await getSkill(database, slug);
  return database
    .select()
    .from(skillVersions)
    .where(eq(skillVersions.skillId, skill.id))
    .orderBy(desc(skillVersions.version));
}

export interface SkillWrite {
  content: string;
  title?: string;
  description?: string;
  parentSlug?: string | null;
  position?: number;
  editedBy: string;
}

/**
 * Create or update one skill and record the version. Creating needs `title`,
 * `description` and an existing `parentSlug`. An update by the same editor
 * within SKILL_VERSION_COALESCE_MS of the latest version rewrites that version
 * (autosave); otherwise it appends version N+1. Identical content is a no-op.
 */
export async function writeSkill(
  database: Database,
  slug: string,
  write: SkillWrite,
  now: Date = new Date(),
): Promise<{ skill: Skill; created: boolean; versionAdded: boolean }> {
  if (!SKILL_SLUG_RE.test(slug)) {
    throw new SkillValidationError(`Invalid slug "${slug}": lowercase letters, digits and single hyphens only.`);
  }
  if (write.editedBy === SEED_EDITOR) {
    throw new SkillValidationError(`editedBy "${SEED_EDITOR}" is reserved for the boot seed.`);
  }

  return database.transaction(async (tx) => {
    const [existing] = await tx.select().from(skills).where(eq(skills.slug, slug)).for("update");

    if (write.parentSlug !== undefined && write.parentSlug !== null) {
      if (write.parentSlug === slug) throw new SkillValidationError("A skill cannot be its own parent.");
      const [parent] = await tx.select({ id: skills.id }).from(skills).where(eq(skills.slug, write.parentSlug));
      if (!parent) throw new SkillValidationError(`Parent skill "${write.parentSlug}" does not exist.`);
    }

    if (!existing) {
      if (!write.title || !write.description) {
        throw new SkillValidationError(`Skill "${slug}" does not exist: creating it needs a title and a description.`);
      }
      if (slug !== INDEX_SKILL_SLUG && !write.parentSlug) {
        throw new SkillValidationError(`Skill "${slug}" does not exist: creating it needs a parentSlug.`);
      }
      const [created] = await tx
        .insert(skills)
        .values({
          slug,
          parentSlug: write.parentSlug ?? null,
          title: write.title,
          description: write.description,
          content: write.content,
          position: write.position ?? 0,
          version: 1,
          updatedBy: write.editedBy,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await tx.insert(skillVersions).values({
        skillId: created.id,
        version: 1,
        title: created.title,
        description: created.description,
        content: created.content,
        editedBy: write.editedBy,
        createdAt: now,
        updatedAt: now,
      });
      return { skill: created, created: true, versionAdded: true };
    }

    const next = {
      title: write.title ?? existing.title,
      description: write.description ?? existing.description,
      content: write.content,
      parentSlug: write.parentSlug === undefined ? existing.parentSlug : write.parentSlug,
      position: write.position ?? existing.position,
    };
    const unchanged =
      next.title === existing.title &&
      next.description === existing.description &&
      next.content === existing.content &&
      next.parentSlug === existing.parentSlug &&
      next.position === existing.position;
    if (unchanged) return { skill: existing, created: false, versionAdded: false };

    const [latest] = await tx
      .select()
      .from(skillVersions)
      .where(and(eq(skillVersions.skillId, existing.id), eq(skillVersions.version, existing.version)));
    const coalesce =
      latest !== undefined &&
      latest.editedBy === write.editedBy &&
      now.getTime() - latest.createdAt.getTime() < SKILL_VERSION_COALESCE_MS;

    const version = coalesce ? existing.version : existing.version + 1;
    if (coalesce) {
      await tx
        .update(skillVersions)
        .set({ title: next.title, description: next.description, content: next.content, updatedAt: now })
        .where(eq(skillVersions.id, latest.id));
    } else {
      await tx.insert(skillVersions).values({
        skillId: existing.id,
        version,
        title: next.title,
        description: next.description,
        content: next.content,
        editedBy: write.editedBy,
        createdAt: now,
        updatedAt: now,
      });
    }
    const [updated] = await tx
      .update(skills)
      .set({ ...next, version, updatedBy: write.editedBy, updatedAt: now })
      .where(eq(skills.id, existing.id))
      .returning();
    return { skill: updated, created: false, versionAdded: !coalesce };
  });
}

/**
 * Boot seed. Inserts every absent seed skill; refreshes a row ONLY while its
 * content is still the seed's (`updated_by = "seed"`); never touches a row a
 * human edited. Returns what it did per slug, for the boot log and tests.
 */
export async function seedSkills(
  database: Database,
  seeds: readonly SeedSkill[] = SEED_SKILLS,
): Promise<{ inserted: string[]; refreshed: string[]; keptHumanEdit: string[] }> {
  const inserted: string[] = [];
  const refreshed: string[] = [];
  const keptHumanEdit: string[] = [];
  const now = new Date();

  for (const seed of seeds) {
    await database.transaction(async (tx) => {
      const [row] = await tx.select().from(skills).where(eq(skills.slug, seed.slug)).for("update");
      if (!row) {
        const [created] = await tx
          .insert(skills)
          .values({
            slug: seed.slug,
            parentSlug: seed.parentSlug,
            title: seed.title,
            description: seed.description,
            content: seed.content,
            position: seed.position,
            version: 1,
            updatedBy: SEED_EDITOR,
          })
          .onConflictDoNothing({ target: skills.slug })
          .returning();
        if (!created) return; // a concurrent boot inserted it first
        await tx.insert(skillVersions).values({
          skillId: created.id,
          version: 1,
          title: seed.title,
          description: seed.description,
          content: seed.content,
          editedBy: SEED_EDITOR,
        });
        inserted.push(seed.slug);
        return;
      }
      if (row.updatedBy !== SEED_EDITOR) {
        keptHumanEdit.push(seed.slug);
        return;
      }
      const same =
        row.title === seed.title &&
        row.description === seed.description &&
        row.content === seed.content &&
        row.parentSlug === seed.parentSlug &&
        row.position === seed.position;
      if (same) return;
      const version = row.version + 1;
      await tx.insert(skillVersions).values({
        skillId: row.id,
        version,
        title: seed.title,
        description: seed.description,
        content: seed.content,
        editedBy: SEED_EDITOR,
      });
      await tx
        .update(skills)
        .set({
          title: seed.title,
          description: seed.description,
          content: seed.content,
          parentSlug: seed.parentSlug,
          position: seed.position,
          version,
          updatedBy: SEED_EDITOR,
          updatedAt: now,
        })
        .where(eq(skills.id, row.id));
      refreshed.push(seed.slug);
    });
  }
  return { inserted, refreshed, keptHumanEdit };
}

/**
 * The block appended to a chat's system prompt when its config allows
 * `read_skill`: the INDEX skill's content plus its DIRECT sub-skills (slug +
 * one line each). Deeper skills are listed by read_skill on their parent, so
 * the prompt stays small however deep the tree grows (owner 2026-10-10).
 */
export async function buildSkillIndexBlock(database: Database): Promise<string> {
  const all = await listSkills(database);
  const index = all.find((s) => s.slug === INDEX_SKILL_SLUG);
  if (!index) throw new SkillNotFoundError(INDEX_SKILL_SLUG);
  const children = all.filter((s) => s.parentSlug === INDEX_SKILL_SLUG);
  const lines = children.map((s) => `- \`${s.slug}\`: ${s.title}. ${s.description}`);
  return [
    `\n\n---\n## Skills (platform knowledge)`,
    index.content.trim(),
    ``,
    `### Sub-skills you can load with read_skill`,
    `(A skill lists its own sub-skills when you load it.)`,
    ...lines,
  ].join("\n");
}

/** What `read_skill` returns to the model: the skill, plus its direct children. */
export async function readSkillForModel(database: Database, slug: unknown) {
  if (typeof slug !== "string" || slug.trim() === "") {
    throw new SkillValidationError("read_skill needs a slug (see the skill index).");
  }
  const all = await listSkills(database);
  const skill = all.find((s) => s.slug === slug.trim());
  if (!skill) throw new SkillNotFoundError(slug.trim());
  return {
    slug: skill.slug,
    title: skill.title,
    content: skill.content,
    subSkills: all
      .filter((s) => s.parentSlug === skill.slug)
      .map((s) => ({ slug: s.slug, title: s.title, description: s.description })),
  };
}
