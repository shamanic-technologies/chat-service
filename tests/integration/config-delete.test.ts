import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, like } from "drizzle-orm";
import * as schema from "../../src/db/schema.js";

process.env.NODE_ENV = "test";
process.env.KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "test-key-svc-key";
process.env.ADMIN_DISTRIBUTE_API_KEY = process.env.ADMIN_DISTRIBUTE_API_KEY || "test-api-svc-key";
process.env.RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "test-runs-key";

const RUN = Date.now().toString(36);
const ORG_A = `org-${RUN}-cfgdel-a`;
const ORG_B = `org-${RUN}-cfgdel-b`;
const auth = (orgId: string) => ({ "x-api-key": "k", "x-org-id": orgId, "x-user-id": "u-1", "x-run-id": "r-1" });

describe("DELETE /config/:key", { timeout: 30000 }, () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    const url = process.env.CHAT_SERVICE_DATABASE_URL;
    if (!url) throw new Error("CHAT_SERVICE_DATABASE_URL required for integration tests");
    client = postgres(url);
    db = drizzle(client, { schema });
    for (const orgId of [ORG_A, ORG_B]) {
      await db.insert(schema.appConfigs).values({ orgId, key: "probe", systemPrompt: "p", allowedTools: [] });
    }
  });

  afterAll(async () => {
    await db.delete(schema.appConfigs).where(like(schema.appConfigs.orgId, `org-${RUN}%`));
    await client?.end();
  });

  it("deletes only the calling org's config, and is idempotent", async () => {
    const app = (await import("../../src/index.js")).default;
    const first = await request(app).delete("/config/probe").set(auth(ORG_A));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ orgId: ORG_A, key: "probe", deleted: true });

    const again = await request(app).delete("/config/probe").set(auth(ORG_A));
    expect(again.body.deleted).toBe(false);

    const otherOrg = await db
      .select()
      .from(schema.appConfigs)
      .where(and(eq(schema.appConfigs.orgId, ORG_B), eq(schema.appConfigs.key, "probe")));
    expect(otherOrg).toHaveLength(1);
  });

  it("requires the org identity", async () => {
    const app = (await import("../../src/index.js")).default;
    const res = await request(app).delete("/config/probe").set({ "x-api-key": "k" });
    expect(res.status).toBe(400);
  });
});
