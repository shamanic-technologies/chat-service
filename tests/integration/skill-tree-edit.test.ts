import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray, like } from "drizzle-orm";
import * as schema from "../../src/db/schema.js";
import {
  CLIENT_COMMS_SKILL_SLUG,
  INDEX_SKILL_SLUG,
  SkillConflictError,
  SkillNotFoundError,
  SkillValidationError,
  deleteSkill,
  getSkill,
  listDeletedSkills,
  listSkillVersions,
  listSkills,
  moveSkill,
  readSkillFrom,
  seedSkills,
  writeSkill,
} from "../../src/lib/skills.js";
import type { SeedSkill } from "../../src/lib/skill-seed.js";

// SKILL-TREE-EDIT-1122: staff delete and drag-and-drop skills from the dashboard.
const connectionString = process.env.CHAT_SERVICE_DATABASE_URL;
const RUN = Date.now().toString(36);
const P = `te-${RUN}`;
const root = `${P}-root`;
const a = `${P}-a`;
const b = `${P}-b`;
const c = `${P}-c`;
const leaf = `${P}-leaf`;
const ED = "kevin@distribute.you";

const seeds = (content = "v1"): SeedSkill[] => [
  { slug: root, parentSlug: null, title: "Root", description: "root", position: 0, content },
  { slug: a, parentSlug: root, title: "A", description: "a", position: 10, content },
  { slug: b, parentSlug: root, title: "B", description: "b", position: 20, content },
  { slug: c, parentSlug: root, title: "C", description: "c", position: 30, content },
  { slug: leaf, parentSlug: a, title: "Leaf", description: "leaf", position: 0, content },
];

async function childrenOf(db: ReturnType<typeof drizzle<typeof schema>>, parent: string) {
  return (await listSkills(db as never)).filter((s) => s.parentSlug === parent).map((s) => [s.slug, s.position]);
}

describe("skill tree edit: delete + move", { timeout: 30000 }, () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    if (!connectionString) throw new Error("CHAT_SERVICE_DATABASE_URL required for integration tests");
    client = postgres(connectionString);
    db = drizzle(client, { schema });
    await seedSkills(db as never, seeds(), {});
  });

  afterAll(async () => {
    await db.delete(schema.skills).where(like(schema.skills.slug, `${P}-%`));
    await client?.end();
  });

  it("move: under a new parent at a place, siblings renumbered 0..n-1 on both sides, no version added", async () => {
    const before = (await getSkill(db as never, c)).version;
    const r = await moveSkill(db as never, c, { parentSlug: a, position: 0, editedBy: ED });
    expect(r.siblings).toEqual([
      { slug: c, position: 0 },
      { slug: leaf, position: 1 },
    ]);
    expect(await childrenOf(db, a)).toEqual([
      [c, 0],
      [leaf, 1],
    ]);
    expect(await childrenOf(db, root)).toEqual([
      [a, 0],
      [b, 1],
    ]);
    expect(r.skill.version).toBe(before);
    expect(r.skill.placedBy).toBe(ED);
    // Same parent, past the end = last.
    await moveSkill(db as never, c, { parentSlug: a, position: 99, editedBy: ED });
    expect(await childrenOf(db, a)).toEqual([
      [leaf, 0],
      [c, 1],
    ]);
    // Back to root between a and b.
    await moveSkill(db as never, c, { parentSlug: root, position: 1, editedBy: ED });
    expect(await childrenOf(db, root)).toEqual([
      [a, 0],
      [c, 1],
      [b, 2],
    ]);
  });

  it("move: refuses a cycle, self, an absent parent and the root", async () => {
    await expect(moveSkill(db as never, a, { parentSlug: leaf, position: 0, editedBy: ED })).rejects.toThrow(/is inside/);
    await expect(moveSkill(db as never, a, { parentSlug: a, position: 0, editedBy: ED })).rejects.toBeInstanceOf(SkillValidationError);
    await expect(moveSkill(db as never, a, { parentSlug: `${P}-nope`, position: 0, editedBy: ED })).rejects.toThrow(/does not exist/);
    await expect(moveSkill(db as never, INDEX_SKILL_SLUG, { parentSlug: a, position: 0, editedBy: ED })).rejects.toBeInstanceOf(SkillConflictError);
    // PUT with a parentSlug change runs the same cycle check.
    await expect(writeSkill(db as never, a, { content: "v1", parentSlug: leaf, editedBy: ED })).rejects.toThrow(/is inside/);
  });

  it("seed: keeps a moved skill's place but still refreshes its text", async () => {
    await seedSkills(db as never, seeds("v2"), {});
    const moved = await getSkill(db as never, c);
    expect(moved.content).toBe("v2");
    expect(moved.parentSlug).toBe(root);
    expect(moved.position).toBe(1); // not the seed's 30
  });

  it("delete: refused while it has sub-skills, naming them", async () => {
    await expect(deleteSkill(db as never, a, ED)).rejects.toThrow(new RegExp(`has 1 sub-skill \\(${leaf}\\)`));
  });

  it("delete: refuses the root and the one voice", async () => {
    await expect(deleteSkill(db as never, INDEX_SKILL_SLUG, ED)).rejects.toBeInstanceOf(SkillConflictError);
    await expect(deleteSkill(db as never, CLIENT_COMMS_SKILL_SLUG, ED)).rejects.toBeInstanceOf(SkillConflictError);
  });

  it("delete: no agent reads it, history kept, siblings closed up, the seed never re-creates it, a PUT brings it back", async () => {
    await writeSkill(db as never, b, { content: "b edited", editedBy: ED });
    const versionsBefore = (await listSkillVersions(db as never, b)).length;
    const r = await deleteSkill(db as never, b, ED);
    expect(r.versionsKept).toBe(versionsBefore);
    expect(r.skill.deletedBy).toBe(ED);

    const live = await listSkills(db as never);
    expect(live.map((s) => s.slug)).not.toContain(b);
    await expect(getSkill(db as never, b)).rejects.toBeInstanceOf(SkillNotFoundError);
    expect(() => readSkillFrom(live, b)).toThrow(SkillNotFoundError);
    expect((await listDeletedSkills(db as never)).map((s) => s.slug)).toContain(b);
    expect((await listSkillVersions(db as never, b)).length).toBe(versionsBefore);
    expect(await childrenOf(db, root)).toEqual([
      [a, 0],
      [c, 1],
    ]);
    await expect(deleteSkill(db as never, b, ED)).rejects.toBeInstanceOf(SkillNotFoundError);

    // Nothing can go under a deleted skill.
    await expect(moveSkill(db as never, c, { parentSlug: b, position: 0, editedBy: ED })).rejects.toThrow(/was deleted/);

    const seeded = await seedSkills(db as never, seeds("v3"), {});
    expect(seeded.inserted).not.toContain(b);
    expect((await listSkills(db as never)).map((s) => s.slug)).not.toContain(b);

    await expect(writeSkill(db as never, b, { content: "back", editedBy: ED })).rejects.toThrow(/was deleted/);
    const back = await writeSkill(db as never, b, { content: "back", title: "B", description: "b", parentSlug: root, position: 2, editedBy: ED });
    expect(back.created).toBe(true);
    expect(back.skill.deletedAt).toBeNull();
    expect(back.skill.version).toBe(versionsBefore + 1);
    expect((await listSkillVersions(db as never, b)).length).toBe(versionsBefore + 1);
  });

  it("delete: a leaf goes, then its emptied parent can go", async () => {
    await deleteSkill(db as never, leaf, ED);
    await deleteSkill(db as never, a, ED);
    const [row] = await db.select().from(schema.skills).where(eq(schema.skills.slug, a));
    expect(row.deletedAt).not.toBeNull();
    const versions = await db.select().from(schema.skillVersions).where(inArray(schema.skillVersions.skillId, [row.id]));
    expect(versions.length).toBeGreaterThan(0);
  });
});
