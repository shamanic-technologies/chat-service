import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema.js";
import {
  seedDistryConfig,
  saveDistryVersion,
  restoreDistryVersion,
  currentDistryVersion,
  codeDistryDefinition,
  listDistryVersions,
  DistryConfigError,
} from "../../src/agent/distry-config.js";
import { SEED_EDITOR, buildSkillIndexPieces, deleteSkill, listSkills, readSkillForModel, writeSkill } from "../../src/lib/skills.js";
import { DistrySaveRequestSchema } from "../../src/schemas.js";
import { definitionFromSaveRequest, definitionOf, foldTreeIntoMentions, skillMentionGraph, MENTIONS_FOLD_EDITOR } from "../../src/agent/distry-config.js";
import { SkillNotFoundError, getSkill } from "../../src/lib/skills.js";
import { SOPHIE_SYSTEM_PROMPT } from "../../src/agent/sophie.js";

const connectionString = process.env.CHAT_SERVICE_DATABASE_URL;

// The table is global (one Distry): this suite runs on CI's throwaway database only.
describe("Distry's versioned definition (DISTRY-PRINCIPAL-1119)", { timeout: 30000 }, () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(() => {
    if (!connectionString) throw new Error("CHAT_SERVICE_DATABASE_URL required for integration tests");
    client = postgres(connectionString);
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    await client?.end();
  });

  const copilotRow = async () => (await db.select().from(schema.platformConfigs).where(eq(schema.platformConfigs.key, "copilot")))[0];

  it("boot seeds version 1 from the code and writes it onto the copilot config", async () => {
    await db.delete(schema.distryConfigVersions);
    const v1 = await seedDistryConfig(db as never);
    expect(v1.version).toBe(1);
    expect(v1.editedBy).toBe(SEED_EDITOR);
    const code = codeDistryDefinition();
    const row = await copilotRow();
    expect(row.systemPrompt).toBe(code.systemPrompt);
    expect(row.allowedTools).toEqual(code.enabledTools);
    expect(`${row.provider}/${row.model}/${row.effort}`).toBe(`${code.provider}/${code.model}/${code.effort}`);
    // A second boot with the same code adds nothing.
    expect((await seedDistryConfig(db as never)).version).toBe(1);
  });

  it("a staff save is a new version, live on the copilot config (the next turn reads it)", async () => {
    const code = codeDistryDefinition();
    const v2 = await saveDistryVersion(db as never, { ...code, systemPrompt: `${code.systemPrompt}\nEdited.` }, { editedBy: "kevin@distribute.you", note: "test" });
    expect(v2.version).toBe(2);
    expect((await copilotRow()).systemPrompt.endsWith("Edited.")).toBe(true);
    // A deploy never overwrites a staff save.
    expect((await seedDistryConfig(db as never)).version).toBe(2);
    expect((await copilotRow()).systemPrompt.endsWith("Edited.")).toBe(true);
  });

  it("restore = a new version carrying the old one's values", async () => {
    const v3 = await restoreDistryVersion(db as never, 1, "kevin@distribute.you");
    expect(v3).toMatchObject({ version: 3, restoredFrom: 1 });
    expect((await copilotRow()).systemPrompt).toBe(codeDistryDefinition().systemPrompt);
    expect((await listDistryVersions(db as never)).map((v) => v.version)).toEqual([3, 2, 1]);
    await expect(restoreDistryVersion(db as never, 99, "kevin@distribute.you")).rejects.toThrow(DistryConfigError);
  });

  it("an invalid save writes nothing", async () => {
    const before = await currentDistryVersion(db as never);
    await expect(saveDistryVersion(db as never, { ...codeDistryDefinition(), enabledTools: ["nope"] }, { editedBy: "kevin@distribute.you" })).rejects.toThrow(/Unknown tools/);
    expect((await currentDistryVersion(db as never))?.version).toBe(before?.version);
  });

  it("Distry reads every live skill even when a stored version picked a narrower list (DISTRY-NO-SKILL-PICKS-1122)", async () => {
    const tag = Date.now().toString(36);
    const picked = `distry-picked-${tag}`;
    const unpicked = `distry-unpicked-${tag}`;
    const gone = `distry-gone-${tag}`;
    if (!(await listSkills(db as never)).some((s) => s.slug === "index")) {
      await writeSkill(db as never, "index", { content: "root", title: "Index", description: "root", parentSlug: null, editedBy: "k" });
    }
    if (!(await listSkills(db as never)).some((s) => s.slug === "client-comms")) {
      await writeSkill(db as never, "client-comms", { content: "voice", title: "Voice", description: "voice", parentSlug: "index", editedBy: "k" });
    }
    for (const slug of [picked, unpicked, gone]) {
      await writeSkill(db as never, slug, { content: `content of ${slug}`, title: `T ${slug}`, description: `D ${slug}`, parentSlug: "index", editedBy: "k" });
    }
    // A version saved by the old editor, holding an explicit narrower list (history).
    const latest = await currentDistryVersion(db as never);
    const code = codeDistryDefinition();
    const [old] = await db
      .insert(schema.distryConfigVersions)
      .values({
        version: (latest?.version ?? 0) + 1,
        // The Prompt mentions both; the stored list picked one (DISTRY-SKILL-MENTIONS-1122: mentions decide).
        systemPrompt: `${code.systemPrompt}\n@skill:${picked} @skill:${unpicked} @skill:${gone}`,
        enabledTools: code.enabledTools,
        skillSlugs: [picked],
        provider: code.provider,
        model: code.model,
        effort: code.effort,
        promptParts: code.prompt,
        editedBy: "kevin@distribute.you",
      })
      .returning();
    // Boot keeps that staff version as current.
    expect((await seedDistryConfig(db as never)).version).toBe(old.version);
    expect("skillSlugs" in definitionOf(old)).toBe(false);
    await deleteSkill(db as never, gone, "kevin@distribute.you");

    // The turn's skill index (what /chat puts in Distry's prompt) lists every live skill.
    const pieces = await buildSkillIndexPieces(db as never, old.systemPrompt);
    expect(pieces.skills).toContain(`\`${picked}\``);
    expect(pieces.skills).toContain(`\`${unpicked}\``);
    expect(pieces.skills).not.toContain(`\`${gone}\``);
    // read_skill reaches a skill outside the old list.
    expect(JSON.stringify(await readSkillForModel(db as never, unpicked, old.systemPrompt))).toContain(`content of ${unpicked}`);

    // A save from the old editor (still sending the pick-list) succeeds and stores no list.
    const parsed = DistrySaveRequestSchema.parse({
      systemPrompt: `${code.systemPrompt}\nOld editor save.`,
      enabledTools: code.enabledTools,
      skillSlugs: [picked],
      provider: code.provider,
      model: code.model,
      effort: code.effort,
      editedBy: "kevin@distribute.you",
    });
    const saved = await saveDistryVersion(db as never, definitionFromSaveRequest(parsed, definitionOf(old).prompt), { editedBy: parsed.editedBy });
    expect(saved.skillSlugs).toBeNull();
    // A restore of the old version keeps reading everything (its list is history only).
    const restored = await restoreDistryVersion(db as never, old.version, "kevin@distribute.you");
    expect(restored.skillSlugs).toBeNull();
    expect((await buildSkillIndexPieces(db as never, restored.systemPrompt)).skills).toContain(`\`${unpicked}\``);

    await db.delete(schema.skills).where(eq(schema.skills.slug, picked));
    await db.delete(schema.skills).where(eq(schema.skills.slug, unpicked));
    await db.delete(schema.skills).where(eq(schema.skills.slug, gone));
  });

  // DISTRY-SKILL-MENTIONS-1122 ------------------------------------------------
  const ensureSkill = async (slug: string, parentSlug: string | null, content: string) => {
    if (!(await listSkills(db as never)).some((s) => s.slug === slug)) {
      await writeSkill(db as never, slug, { content, title: `T ${slug}`, description: `D ${slug}`, parentSlug, editedBy: "k" });
    }
  };

  it("a Distry turn reads the Prompt and only the skills reachable by mentions from it", async () => {
    const tag = Date.now().toString(36);
    const [first, second, third, alone] = ["first", "second", "third", "alone"].map((n) => `men-${n}-${tag}`);
    await writeSkill(db as never, first, { content: `Then @skill:${second} and @tool:read_skill.`, title: "First", description: "first", editedBy: "k" });
    await writeSkill(db as never, second, { content: `Then @skill:${third}.`, title: "Second", description: "second", editedBy: "k" });
    await writeSkill(db as never, third, { content: "Leaf.", title: "Third", description: "third", editedBy: "k" });
    await writeSkill(db as never, alone, { content: "Nobody mentions me.", title: "Alone", description: "alone", editedBy: "k" });
    const code = codeDistryDefinition();
    const saved = await saveDistryVersion(db as never, { ...code, systemPrompt: `${code.systemPrompt}\nStart with @skill:${first}.` }, { editedBy: "kevin@distribute.you" });
    // The copilot config /chat reads carries that Prompt: it is the turn's always-read text.
    const prompt = (await copilotRow()).systemPrompt;
    expect(prompt).toBe(saved.systemPrompt);

    const pieces = await buildSkillIndexPieces(db as never, prompt);
    expect(pieces.skills).toContain(`\`${first}\`: First. first`);
    expect(pieces.skills).not.toContain(second);
    expect((await readSkillForModel(db as never, first, prompt)).mentions).toEqual([{ skill: second, title: "Second", description: "second" }, { tool: "read_skill" }]);
    expect((await readSkillForModel(db as never, third, prompt)).slug).toBe(third);
    await expect(readSkillForModel(db as never, alone, prompt)).rejects.toBeInstanceOf(SkillNotFoundError);

    // The served graph: mentions in text order, who mentions whom, never-mentioned.
    const { graph } = await skillMentionGraph(db as never);
    expect(graph.prompt.mentions.at(-1)).toEqual({ kind: "skill", ref: first, known: true });
    expect(graph.skills.get(first)).toMatchObject({
      mentions: [{ kind: "skill", ref: second, known: true }, { kind: "tool", ref: "read_skill", known: true }],
      mentionedBy: { prompt: true, skills: [] },
      neverMentioned: false,
      reachable: true,
    });
    expect(graph.skills.get(third)).toMatchObject({ mentionedBy: { prompt: false, skills: [second] }, reachable: true });
    expect(graph.skills.get(alone)).toMatchObject({ neverMentioned: true, reachable: false });

    for (const slug of [first, second, third, alone]) await db.delete(schema.skills).where(eq(schema.skills.slug, slug));
  });

  it("once, the stored tree becomes mentions: index + voice join the Prompt, a parent mentions its sub-skills", async () => {
    const tag = Date.now().toString(36);
    const parent = `fold-parent-${tag}`;
    const child = `fold-child-${tag}`;
    await ensureSkill("index", null, "# Method\nThe map.");
    await ensureSkill("client-comms", "index", "# How we talk to a person");
    await writeSkill(db as never, parent, { content: "Parent text.", title: "P", description: "p", parentSlug: "index", editedBy: "k" });
    await writeSkill(db as never, child, { content: "Child text.", title: "C", description: "c", parentSlug: parent, editedBy: "k" });
    // A staff version from before mentions: its Prompt mentions no skill.
    const latest = await currentDistryVersion(db as never);
    const code = codeDistryDefinition();
    await db.insert(schema.distryConfigVersions).values({
      version: (latest?.version ?? 0) + 1,
      systemPrompt: SOPHIE_SYSTEM_PROMPT,
      enabledTools: code.enabledTools,
      provider: code.provider,
      model: code.model,
      effort: code.effort,
      promptParts: code.prompt,
      editedBy: "kevin@distribute.you",
    });

    const fold = await foldTreeIntoMentions(db as never);
    expect(fold.skills).toContain(parent);
    const current = (await currentDistryVersion(db as never))!;
    expect(current.version).toBe(fold.promptVersion);
    expect(current.editedBy).toBe(MENTIONS_FOLD_EDITOR);
    const index = await getSkill(db as never, "index");
    const voice = await getSkill(db as never, "client-comms");
    expect(current.systemPrompt.startsWith(SOPHIE_SYSTEM_PROMPT)).toBe(true);
    expect(current.systemPrompt).toContain(index.content.trim());
    expect(current.systemPrompt).toContain(voice.content.trim());
    expect(current.systemPrompt).toContain(`- @skill:${parent}`);
    expect(current.systemPrompt).not.toContain("@skill:client-comms");
    expect((await getSkill(db as never, parent)).content).toBe(`Parent text.\n\n## Read next\n- @skill:${child}`);
    // Reachable through the chain: Prompt -> parent -> child. The old index is never mentioned now, and can go.
    expect((await readSkillForModel(db as never, child, current.systemPrompt)).slug).toBe(child);
    const { graph } = await skillMentionGraph(db as never);
    expect(graph.skills.get("index")?.neverMentioned).toBe(true);
    // A second boot does nothing.
    expect(await foldTreeIntoMentions(db as never)).toEqual({ promptVersion: null, skills: [] });

    for (const slug of [parent, child]) await db.delete(schema.skills).where(eq(schema.skills.slug, slug));
  });
});
