import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, like } from "drizzle-orm";
import * as schema from "../../src/db/schema.js";
import { submitStaffRequest, type StaffRequestDeps } from "../../src/lib/staff-requests.js";
import { declareLeg } from "../../src/lib/declarations-client.js";

const connectionString = process.env.CHAT_SERVICE_DATABASE_URL;
const RUN = Date.now().toString(36);
const originalEnv = { ...process.env };

const deps: StaffRequestDeps = {
  fetchRequesterEmail: async () => "client@example.com",
  openGithubIssue: async () => ({ url: "https://github.com/shamanic-technologies/campaign-service/issues/9", number: 9 }),
  sendStaffTelegram: async () => ({ ok: true as const }),
};

const res = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  text: () => Promise.resolve(JSON.stringify(body)),
});

describe("declarations → staff requests", { timeout: 30000 }, () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(() => {
    if (!connectionString) throw new Error("CHAT_SERVICE_DATABASE_URL required for integration tests");
    client = postgres(connectionString);
    db = drizzle(client, { schema });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await db.delete(schema.staffRequests).where(like(schema.staffRequests.orgId, `org-${RUN}%`));
    await client?.end();
  });

  it("a leg on a trigger nothing fires is RECORDED as a staff request for its detector", async () => {
    process.env.FEATURES_SERVICE_URL = "http://features.test";
    process.env.FEATURES_SERVICE_API_KEY = "k";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(res(409, { error: "not fired", reason: "trigger_not_fired" }))
        .mockResolvedValueOnce(res(200, { id: "no_reply_3d", kind: "delay", coded: false, params: { afterStep: "lead_found", days: 3 } })),
    );
    const orgId = `org-${RUN}-a`;
    const ctx = { orgId, userId: "user-1" };
    const result = (await declareLeg(
      { channelSlug: "whatsapp", fromStep: "lead_found", toStep: "positive_reply", mode: "reactive", triggerId: "no_reply_3d", userRequest: "WhatsApp 3 days later if no reply" },
      ctx,
      (input) => submitStaffRequest(db, { ...ctx, brandId: null, sessionId: null }, input, deps),
    )) as { status: string };
    expect(result.status).toBe("on_hold");

    const rows = await db.select().from(schema.staffRequests).where(eq(schema.staffRequests.orgId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      repo: "campaign-service",
      kind: "feature",
      pieceKey: "delay-trigger-detector",
      userRequest: "WhatsApp 3 days later if no reply",
      issueNumber: 9,
    });
  });
});
