import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { db as Db } from "../db/index.js";
import { skills, skillVersions, type Skill, type SkillVersion } from "../db/schema.js";
import { fillTemplate } from "./prompt-template.js";
import { MERGED_SKILL_SLUGS, SEED_SKILLS, type SeedSkill } from "./skill-seed.js";

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
/** The one voice of every message a person reads from us (owner 2026-10-18), always loaded with the index. */
export const CLIENT_COMMS_SKILL_SLUG = "client-comms";

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

/** A tree edit refused because of the tree's state (sub-skills, a skill the code reads by slug). */
export class SkillConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillConflictError";
  }
}

/**
 * Skills the code reads BY SLUG on every chat turn (skillIndexPiecesFrom): the
 * root and the one voice. Deleting one would stop every chat, so delete refuses
 * them; the root also never moves (it has no parent).
 */
export const UNDELETABLE_SKILL_SLUGS: readonly string[] = [INDEX_SKILL_SLUG, CLIENT_COMMS_SKILL_SLUG];

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
  deletedAt: string | null;
  deletedBy: string | null;
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
    deletedAt: s.deletedAt ? s.deletedAt.toISOString() : null,
    deletedBy: s.deletedBy ?? null,
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

/**
 * Every skill an agent may read. A slug merged into another skill is never
 * served, even while a staff-edited row of it is kept (seedSkills removes only
 * seed rows): prod 2026-11-03, Sophie read `catalogue-plays` and hunted the
 * removed plays for 50 s (SOPHIE-TURN-LOST-1103).
 */
export async function listSkills(
  database: Database,
  merged: Readonly<Record<string, string>> = MERGED_SKILL_SLUGS,
): Promise<Skill[]> {
  const rows = await database
    .select()
    .from(skills)
    .where(isNull(skills.deletedAt))
    .orderBy(asc(skills.position), asc(skills.slug));
  return rows.filter((s) => !(s.slug in merged));
}

/** Skills staff deleted from the tree (SKILL-TREE-EDIT-1122): kept with every version, read by no agent. */
export async function listDeletedSkills(database: Database): Promise<Skill[]> {
  const rows = await database.select().from(skills).orderBy(desc(skills.deletedAt));
  return rows.filter((s) => s.deletedAt !== null);
}

/**
 * One skill by slug. A slug merged into another skill (MERGED_SKILL_SLUGS)
 * answers the skill it was merged into, so a caller still asking for the old
 * slug never gets a 404 (its body carries the new slug), and never the old
 * row a person may have edited.
 */
export async function getSkill(
  database: Database,
  slug: string,
  merged: Readonly<Record<string, string>> = MERGED_SKILL_SLUGS,
): Promise<Skill> {
  const mergedInto = merged[slug];
  if (mergedInto) {
    const [target] = await database.select().from(skills).where(and(eq(skills.slug, mergedInto), isNull(skills.deletedAt)));
    if (target) return target;
  }
  const [row] = await database.select().from(skills).where(and(eq(skills.slug, slug), isNull(skills.deletedAt)));
  if (row) return row;
  throw new SkillNotFoundError(slug);
}

/** A skill's history, also once it is deleted (SKILL-TREE-EDIT-1122: deleting never loses a version). */
export async function listSkillVersions(database: Database, slug: string): Promise<SkillVersion[]> {
  const [deleted] = await database.select().from(skills).where(eq(skills.slug, slug));
  const skill = deleted?.deletedAt ? deleted : await getSkill(database, slug);
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
      if (existing && !existing.deletedAt && existing.parentSlug !== write.parentSlug) {
        await assertCanPlaceUnder(tx, slug, write.parentSlug);
      } else {
        if (write.parentSlug === slug) throw new SkillValidationError("A skill cannot be its own parent.");
        await requireLiveParent(tx, write.parentSlug);
      }
    }

    if (existing?.deletedAt) {
      // Writing a deleted slug brings it back, like a create (versions continue from its history).
      if (!write.title || !write.description) {
        throw new SkillValidationError(`Skill "${slug}" was deleted: bringing it back needs a title and a description.`);
      }
      if (!write.parentSlug) {
        throw new SkillValidationError(`Skill "${slug}" was deleted: bringing it back needs a parentSlug.`);
      }
      const version = existing.version + 1;
      await tx.insert(skillVersions).values({
        skillId: existing.id,
        version,
        title: write.title,
        description: write.description,
        content: write.content,
        editedBy: write.editedBy,
        createdAt: now,
        updatedAt: now,
      });
      const [restored] = await tx
        .update(skills)
        .set({
          title: write.title,
          description: write.description,
          content: write.content,
          parentSlug: write.parentSlug,
          position: write.position ?? existing.position,
          placedBy: write.editedBy,
          version,
          updatedBy: write.editedBy,
          updatedAt: now,
          deletedAt: null,
          deletedBy: null,
        })
        .where(eq(skills.id, existing.id))
        .returning();
      return { skill: restored, created: true, versionAdded: true };
    }

    if (!existing) {
      const mergedInto = MERGED_SKILL_SLUGS[slug];
      if (mergedInto) {
        throw new SkillValidationError(`Skill "${slug}" was merged into "${mergedInto}": edit that one.`);
      }
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
          placedBy: write.editedBy,
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
    const moved = next.parentSlug !== existing.parentSlug || next.position !== existing.position;
    const [updated] = await tx
      .update(skills)
      .set({ ...next, version, updatedBy: write.editedBy, updatedAt: now, ...(moved ? { placedBy: write.editedBy } : {}) })
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
  merged: Readonly<Record<string, string>> = MERGED_SKILL_SLUGS,
): Promise<{ inserted: string[]; refreshed: string[]; keptHumanEdit: string[]; removedMerged: string[] }> {
  const inserted: string[] = [];
  const refreshed: string[] = [];
  const keptHumanEdit: string[] = [];
  const removedMerged: string[] = [];
  const now = new Date();

  // A slug merged into another skill: its row goes while it still holds seed
  // content (reads of the old slug answer the merged skill). A human-edited
  // row is kept, like every human edit.
  for (const slug of Object.keys(merged)) {
    const [row] = await database.select().from(skills).where(eq(skills.slug, slug));
    if (!row) continue;
    if (row.updatedBy !== SEED_EDITOR || row.deletedAt) {
      keptHumanEdit.push(slug);
      continue;
    }
    await database.delete(skills).where(and(eq(skills.id, row.id), eq(skills.updatedBy, SEED_EDITOR)));
    removedMerged.push(slug);
  }

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
      // A skill staff deleted stays deleted; one a human edited keeps its text.
      if (row.updatedBy !== SEED_EDITOR || row.deletedAt) {
        keptHumanEdit.push(seed.slug);
        return;
      }
      // A skill staff MOVED keeps its place; the seed still refreshes its text.
      const parentSlug = row.placedBy ? row.parentSlug : seed.parentSlug;
      const position = row.placedBy ? row.position : seed.position;
      const same =
        row.title === seed.title &&
        row.description === seed.description &&
        row.content === seed.content &&
        row.parentSlug === parentSlug &&
        row.position === position;
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
          parentSlug,
          position,
          version,
          updatedBy: SEED_EDITOR,
          updatedAt: now,
        })
        .where(eq(skills.id, row.id));
      refreshed.push(seed.slug);
    });
  }
  return { inserted, refreshed, keptHumanEdit, removedMerged };
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function requireLiveParent(tx: Tx, parentSlug: string): Promise<void> {
  const [parent] = await tx.select({ deletedAt: skills.deletedAt }).from(skills).where(eq(skills.slug, parentSlug));
  if (!parent) throw new SkillValidationError(`Parent skill "${parentSlug}" does not exist.`);
  if (parent.deletedAt) throw new SkillValidationError(`Parent skill "${parentSlug}" was deleted.`);
}

/** Refuses a parent that is the skill itself, one of its descendants (a cycle), absent or deleted. */
async function assertCanPlaceUnder(tx: Tx, slug: string, parentSlug: string): Promise<void> {
  if (parentSlug === slug) throw new SkillValidationError("A skill cannot be its own parent.");
  await requireLiveParent(tx, parentSlug);
  const rows = await tx.select({ slug: skills.slug, parentSlug: skills.parentSlug }).from(skills);
  const parentOf = new Map(rows.map((r) => [r.slug, r.parentSlug]));
  const seen = new Set<string>();
  for (let cur: string | null | undefined = parentSlug; cur; cur = parentOf.get(cur)) {
    if (cur === slug) {
      throw new SkillValidationError(`Cannot move "${slug}" under "${parentSlug}": "${parentSlug}" is inside "${slug}".`);
    }
    if (seen.has(cur)) break;
    seen.add(cur);
  }
}

export interface SkillMove {
  parentSlug: string;
  /** 0-based place among the new parent's other live sub-skills; past the end = last. */
  position: number;
  editedBy: string;
}

export interface SkillMoveResult {
  skill: Skill;
  /** The new parent's sub-skills in order, positions 0..n-1. */
  siblings: { slug: string; position: number }[];
}

/**
 * Drag and drop (SKILL-TREE-EDIT-1122): put `slug` under `parentSlug` at
 * `position`, then renumber the new parent's live sub-skills 0..n-1 (and the
 * old parent's, when it changed), so no two siblings share a place. A cycle,
 * the root, or a deleted/absent skill is refused. Content is untouched: no
 * version is added; moved rows carry `placedBy` so the seed keeps their place.
 */
export async function moveSkill(database: Database, slug: string, move: SkillMove, now: Date = new Date()): Promise<SkillMoveResult> {
  if (move.editedBy === SEED_EDITOR) {
    throw new SkillValidationError(`editedBy "${SEED_EDITOR}" is reserved for the boot seed.`);
  }
  if (slug === INDEX_SKILL_SLUG) throw new SkillConflictError(`"${INDEX_SKILL_SLUG}" is the root of the tree: it cannot move.`);
  return database.transaction(async (tx) => {
    // One lock for every tree edit, so two drags at once cannot interleave their renumbering.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('skills-tree'))`);
    const [existing] = await tx.select().from(skills).where(eq(skills.slug, slug)).for("update");
    if (!existing || existing.deletedAt) throw new SkillNotFoundError(slug);
    await assertCanPlaceUnder(tx, slug, move.parentSlug);

    const oldParent = existing.parentSlug;
    const siblingsOf = async (parent: string) =>
      (await tx.select().from(skills).where(and(eq(skills.parentSlug, parent), isNull(skills.deletedAt))).orderBy(asc(skills.position), asc(skills.slug)))
        .filter((s) => s.id !== existing.id);

    const renumber = async (ordered: Skill[]) => {
      for (const [i, s] of ordered.entries()) {
        if (s.position === i && s.parentSlug === move.parentSlug && s.id !== existing.id) continue;
        await tx
          .update(skills)
          .set({ position: i, ...(s.id === existing.id ? { parentSlug: move.parentSlug } : {}), placedBy: move.editedBy, updatedAt: now })
          .where(eq(skills.id, s.id));
      }
    };

    const newSiblings = await siblingsOf(move.parentSlug);
    const at = Math.min(Math.max(0, move.position), newSiblings.length);
    newSiblings.splice(at, 0, existing);
    await renumber(newSiblings);

    if (oldParent && oldParent !== move.parentSlug) {
      const old = await siblingsOf(oldParent);
      for (const [i, s] of old.entries()) {
        if (s.position === i) continue;
        await tx.update(skills).set({ position: i, placedBy: move.editedBy, updatedAt: now }).where(eq(skills.id, s.id));
      }
    }

    const [skill] = await tx.select().from(skills).where(eq(skills.id, existing.id));
    return { skill, siblings: newSiblings.map((s, i) => ({ slug: s.slug, position: i })) };
  });
}

/**
 * Delete from the tree (SKILL-TREE-EDIT-1122). A soft delete: the row and every
 * version stay readable (`GET .../versions`), no agent reads it from now on,
 * the boot seed never re-creates it, and writing the slug again brings it back.
 * Refused: the root and the one voice (UNDELETABLE_SKILL_SLUGS), and a skill
 * that still has live sub-skills (move or delete them first), so a delete
 * always removes exactly one skill.
 */
export async function deleteSkill(
  database: Database,
  slug: string,
  editedBy: string,
  now: Date = new Date(),
): Promise<{ skill: Skill; versionsKept: number }> {
  if (editedBy === SEED_EDITOR) throw new SkillValidationError(`editedBy "${SEED_EDITOR}" is reserved for the boot seed.`);
  if (UNDELETABLE_SKILL_SLUGS.includes(slug)) {
    throw new SkillConflictError(`"${slug}" cannot be deleted: every chat reads it on every turn.`);
  }
  return database.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('skills-tree'))`);
    const [existing] = await tx.select().from(skills).where(eq(skills.slug, slug)).for("update");
    if (!existing || existing.deletedAt) throw new SkillNotFoundError(slug);
    const children = await tx
      .select({ slug: skills.slug })
      .from(skills)
      .where(and(eq(skills.parentSlug, slug), isNull(skills.deletedAt)))
      .orderBy(asc(skills.position), asc(skills.slug));
    if (children.length > 0) {
      throw new SkillConflictError(
        `"${slug}" has ${children.length} sub-skill${children.length === 1 ? "" : "s"} (${children.map((c) => c.slug).join(", ")}): move or delete them first.`,
      );
    }
    const [skill] = await tx
      .update(skills)
      .set({ deletedAt: now, deletedBy: editedBy, updatedAt: now })
      .where(eq(skills.id, existing.id))
      .returning();
    // Close the gap among the siblings it leaves.
    if (existing.parentSlug) {
      const rest = await tx
        .select()
        .from(skills)
        .where(and(eq(skills.parentSlug, existing.parentSlug), isNull(skills.deletedAt)))
        .orderBy(asc(skills.position), asc(skills.slug));
      for (const [i, s] of rest.entries()) {
        if (s.position === i) continue;
        await tx.update(skills).set({ position: i, placedBy: editedBy, updatedAt: now }).where(eq(skills.id, s.id));
      }
    }
    const versions = await tx.select({ id: skillVersions.id }).from(skillVersions).where(eq(skillVersions.skillId, existing.id));
    return { skill, versionsKept: versions.length };
  });
}

/**
 * The block appended to a chat's system prompt when its config allows
 * `read_skill`: the INDEX skill's content plus its DIRECT sub-skills (slug +
 * one line each). Deeper skills are listed by read_skill on their parent, so
 * the prompt stays small however deep the tree grows (owner 2026-10-10).
 */
export async function buildSkillIndexBlock(database: Database): Promise<string> {
  return skillIndexBlockFrom(await listSkills(database));
}

/** A skill as the prompt builders read it (a stored row, or a snapshot of one). */
export type SkillText = Pick<Skill, "slug" | "parentSlug" | "title" | "description" | "content">;

/**
 * How the skill index is introduced to the model (DISTRY-PROMPT-PARTS-1120): a
 * template Distry's editor can rewrite (part `skill-index`). Its data: the
 * `index` skill's content, the `client-comms` skill's content, and one line per
 * direct sub-skill of `index`.
 */
export const SKILL_INDEX_TEMPLATE = [
  `\n\n---\n## Skills (platform knowledge)`,
  `{{indexSkill}}`,
  ``,
  `{{voiceSkill}}`,
  ``,
  `### Sub-skills you can load with read_skill`,
  `(A skill lists its own sub-skills when you load it.)`,
  `{{subSkills}}`,
].join("\n");

/** The data the skill index template is filled with. */
export interface SkillIndexPieces {
  indexSkill: string;
  voiceSkill: string;
  subSkills: string;
}

export function skillIndexPiecesFrom(all: readonly SkillText[]): SkillIndexPieces {
  const index = all.find((s) => s.slug === INDEX_SKILL_SLUG);
  if (!index) throw new SkillNotFoundError(INDEX_SKILL_SLUG);
  const voice = all.find((s) => s.slug === CLIENT_COMMS_SKILL_SLUG);
  if (!voice) throw new SkillNotFoundError(CLIENT_COMMS_SKILL_SLUG);
  const children = all.filter((s) => s.parentSlug === INDEX_SKILL_SLUG && s.slug !== CLIENT_COMMS_SKILL_SLUG);
  return {
    indexSkill: index.content.trim(),
    voiceSkill: voice.content.trim(),
    subSkills: children.map((s) => `- \`${s.slug}\`: ${s.title}. ${s.description}`).join("\n"),
  };
}

export async function buildSkillIndexPieces(database: Database): Promise<SkillIndexPieces> {
  return skillIndexPiecesFrom(await listSkills(database));
}

/** `buildSkillIndexBlock` over rows already read (the eval harness replays a snapshot). */
export function skillIndexBlockFrom(all: readonly SkillText[], template: string = SKILL_INDEX_TEMPLATE): string {
  return fillTemplate(template, { ...skillIndexPiecesFrom(all) });
}

/** What `read_skill` returns to the model: the skill, plus its direct children. */
export async function readSkillForModel(database: Database, slug: unknown) {
  if (typeof slug !== "string" || slug.trim() === "") {
    throw new SkillValidationError("read_skill needs a slug (see the skill index).");
  }
  return readSkillFrom(await listSkills(database), slug);
}

export function readSkillFrom(all: readonly SkillText[], slug: unknown) {
  if (typeof slug !== "string" || slug.trim() === "") {
    throw new SkillValidationError("read_skill needs a slug (see the skill index).");
  }
  const wanted = slug.trim();
  const skill = all.find((s) => s.slug === (MERGED_SKILL_SLUGS[wanted] ?? wanted));
  if (!skill) throw new SkillNotFoundError(wanted);
  return {
    slug: skill.slug,
    title: skill.title,
    content: skill.content,
    subSkills: all
      .filter((s) => s.parentSlug === skill.slug)
      .map((s) => ({ slug: s.slug, title: s.title, description: s.description })),
  };
}
