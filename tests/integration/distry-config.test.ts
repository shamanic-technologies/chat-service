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
import { SEED_EDITOR } from "../../src/lib/skills.js";

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
});
