import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
import * as schema from "../../src/db/schema.js";
import {
  SEED_EDITOR,
  SKILL_VERSION_COALESCE_MS,
  getSkill,
  listSkillVersions,
  seedSkills,
  writeSkill,
  SkillValidationError,
} from "../../src/lib/skills.js";
import type { SeedSkill } from "../../src/lib/skill-seed.js";

const connectionString = process.env.CHAT_SERVICE_DATABASE_URL;
const RUN = Date.now().toString(36);
const root = `t-${RUN}-root`;
const child = `t-${RUN}-child`;

function seeds(rootContent: string, childContent: string): SeedSkill[] {
  return [
    { slug: root, parentSlug: null, title: "Root", description: "root", position: 0, content: rootContent },
    { slug: child, parentSlug: root, title: "Child", description: "child", position: 1, content: childContent },
  ];
}

describe("skill tree store", { timeout: 30000 }, () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(() => {
    if (!connectionString) throw new Error("CHAT_SERVICE_DATABASE_URL required for integration tests");
    client = postgres(connectionString);
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    await db.delete(schema.skills).where(inArray(schema.skills.slug, [root, child, `t-${RUN}-new`, `t-${RUN}-old`, `t-${RUN}-kept`]));
    await client?.end();
  });

  it("seeds absent skills, then refreshes ONLY rows still holding seed content", async () => {
    const first = await seedSkills(db as never, seeds("root v1", "child v1"));
    expect(first.inserted).toEqual([root, child]);

    // A human edits the child.
    await writeSkill(db as never, child, { content: "child edited by Kevin", editedBy: "kevin@distribute.you" });

    // Redeploy with new seed content for both.
    const second = await seedSkills(db as never, seeds("root v2", "child v2"));
    expect(second.refreshed).toEqual([root]);
    expect(second.keptHumanEdit).toEqual([child]);

    expect((await getSkill(db as never, root)).content).toBe("root v2");
    const edited = await getSkill(db as never, child);
    expect(edited.content).toBe("child edited by Kevin");
    expect(edited.updatedBy).toBe("kevin@distribute.you");

    // Same seed again: nothing to do.
    const third = await seedSkills(db as never, seeds("root v2", "child v2"));
    expect(third.inserted).toEqual([]);
    expect(third.refreshed).toEqual([]);
  });

  it("coalesces an autosave burst by the same editor into one version, keeps history", async () => {
    const t0 = new Date("2030-01-01T10:00:00Z");
    const a = await writeSkill(db as never, root, { content: "draft 1", editedBy: "kevin@distribute.you" }, t0);
    expect(a.versionAdded).toBe(true);
    const v = a.skill.version;

    const b = await writeSkill(db as never, root, { content: "draft 2", editedBy: "kevin@distribute.you" }, new Date(t0.getTime() + 5_000));
    expect(b.versionAdded).toBe(false);
    expect(b.skill.version).toBe(v);

    const c = await writeSkill(
      db as never,
      root,
      { content: "draft 3", editedBy: "kevin@distribute.you" },
      new Date(t0.getTime() + SKILL_VERSION_COALESCE_MS + 1),
    );
    expect(c.versionAdded).toBe(true);
    expect(c.skill.version).toBe(v + 1);

    const noop = await writeSkill(db as never, root, { content: "draft 3", editedBy: "kevin@distribute.you" });
    expect(noop.versionAdded).toBe(false);

    const versions = await listSkillVersions(db as never, root);
    expect(versions[0].content).toBe("draft 3");
    expect(versions[1].content).toBe("draft 2"); // the burst's last save
    expect(versions.map((x) => x.version)).toEqual([...versions.map((x) => x.version)].sort((x, y) => y - x));
    expect(versions.at(-1)!.editedBy).toBe(SEED_EDITOR); // the seed is recoverable
  });

  it("creates a new skill only with title, description and an existing parent", async () => {
    const slug = `t-${RUN}-new`;
    await expect(writeSkill(db as never, slug, { content: "x", editedBy: "k" })).rejects.toBeInstanceOf(SkillValidationError);
    await expect(
      writeSkill(db as never, slug, { content: "x", title: "T", description: "D", parentSlug: "nope-nope", editedBy: "k" }),
    ).rejects.toThrow(/does not exist/);
    const created = await writeSkill(db as never, slug, { content: "x", title: "T", description: "D", parentSlug: root, editedBy: "k" });
    expect(created.created).toBe(true);
    const [row] = await db.select().from(schema.skills).where(eq(schema.skills.slug, slug));
    expect(row.parentSlug).toBe(root);
  });

  it("refuses the reserved seed editor", async () => {
    await expect(writeSkill(db as never, root, { content: "y", editedBy: SEED_EDITOR })).rejects.toThrow(/reserved/);
  });

  it("a merged slug: the seed drops its seed row, keeps a human-edited one, and a read of it answers the merged skill", async () => {
    const old = `t-${RUN}-old`;
    const kept = `t-${RUN}-kept`;
    const merged = { [old]: root, [kept]: root };
    // Both exist as seed rows first; then a human edits `kept`.
    await seedSkills(db as never, [
      ...seeds("root v2", "child v2"),
      { slug: old, parentSlug: root, title: "Old", description: "old", position: 2, content: "old" },
      { slug: kept, parentSlug: root, title: "Kept", description: "kept", position: 3, content: "kept" },
    ], {});
    await writeSkill(db as never, kept, { content: "kept, edited by Kevin", editedBy: "kevin@distribute.you" });

    const r = await seedSkills(db as never, seeds("root v2", "child v2"), merged);
    expect(r.removedMerged).toEqual([old]);
    expect(r.keptHumanEdit).toContain(kept);
    const [gone] = await db.select().from(schema.skills).where(eq(schema.skills.slug, old));
    expect(gone).toBeUndefined();

    // The old slug never 404s: it answers the skill it was merged into.
    const read = await getSkill(db as never, old, merged);
    expect(read.slug).toBe(root);
    // A human-edited row still answers itself.
    expect((await getSkill(db as never, kept, merged)).slug).toBe(kept);
  });

  it("refuses to re-create a slug merged into another skill", async () => {
    await expect(writeSkill(db as never, "channels", { content: "x", title: "T", description: "D", parentSlug: root, editedBy: "k" })).rejects.toThrow(
      /merged into "catalogue-channels"/,
    );
  });
});
