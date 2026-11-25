import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema.js";
import {
  NoPhoneError,
  handoffBody,
  markCampaignStarted,
  sayHello,
  upsertHandoff,
  waitingCampaignId,
  type HelloDeps,
} from "../../src/lib/copilot-handoff.js";

// DISTRY-CHANNEL-HANDOFF-1125 on a real Postgres (CI's throwaway container, migrated
// from the journal): the waiting campaign starts once, a hello goes out once per
// channel, a WhatsApp hello without a number is refused by name.

const connectionString = process.env.CHAT_SERVICE_DATABASE_URL;
const ORG = `org-handoff-pg-${Date.now()}`;
const CAMPAIGN = "11111111-2222-4333-8444-555555555555";

describe("copilot handoff on Postgres", { timeout: 30_000 }, () => {
  let client: ReturnType<typeof postgres>;
  let db: HelloDeps["db"];

  beforeAll(() => {
    if (!connectionString) throw new Error("CHAT_SERVICE_DATABASE_URL is required");
    client = postgres(connectionString, { max: 4 });
    db = drizzle(client, { schema }) as unknown as HelloDeps["db"];
  });
  afterAll(async () => {
    await db.delete(schema.copilotHandoffs).where(eq(schema.copilotHandoffs.orgId, ORG));
    await db.delete(schema.copilotProactiveTurns).where(eq(schema.copilotProactiveTurns.orgId, ORG));
    await db.delete(schema.sessions).where(eq(schema.sessions.orgId, ORG));
    await client.end();
  });

  const deps = (over: Partial<HelloDeps> = {}): HelloDeps => ({
    db,
    fetchUser: async () => ({ email: "staff@distribute.you", phone: null, onboardingPhone: "+33600000000" }),
    createSupportRun: async () => "run-1",
    startProactiveTurn: vi.fn(),
    conversation: async () => [],
    handOverByEmail: vi.fn(async () => ({ status: "pending" })),
    ...over,
  });

  it("the waiting campaign is read until started, and starts once", async () => {
    const row = await upsertHandoff(db, { orgId: ORG, userId: "u-start", campaignId: CAMPAIGN });
    expect(handoffBody(row).campaignWaiting).toBe(true);
    expect(await waitingCampaignId(db, ORG, "u-start")).toBe(CAMPAIGN);
    await markCampaignStarted(db, { orgId: ORG, userId: "u-start", campaignId: CAMPAIGN, via: "whatsapp" });
    await markCampaignStarted(db, { orgId: ORG, userId: "u-start", campaignId: CAMPAIGN, via: "email" });
    expect(await waitingCampaignId(db, ORG, "u-start")).toBeNull();
    const again = await upsertHandoff(db, { orgId: ORG, userId: "u-start", campaignId: CAMPAIGN });
    expect(again.campaignStartedVia).toBe("whatsapp");
  });

  it("a WhatsApp hello writes from our line once, to the number typed at signup", async () => {
    const d = deps();
    const row = await upsertHandoff(db, { orgId: ORG, userId: "u-wa", campaignId: CAMPAIGN });
    const after = await sayHello(d, row, "whatsapp");
    expect(handoffBody(after).hellos.whatsapp?.status).toBe("processing");
    expect(d.startProactiveTurn).toHaveBeenCalledTimes(1);
    const [rowId, recipient] = (d.startProactiveTurn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(recipient.whatsapp).toEqual({ phone: "+33600000000" });
    const [turn] = await db.select().from(schema.copilotProactiveTurns).where(eq(schema.copilotProactiveTurns.id, rowId));
    expect(turn).toMatchObject({ kind: "hello", brandId: null, delivery: "whatsapp", recipientUserId: "u-wa", payload: { kind: "hello", campaignWaiting: true } });
    await sayHello(d, after, "whatsapp");
    expect(d.startProactiveTurn).toHaveBeenCalledTimes(1);
  });

  it("a WhatsApp hello for an account with no number is refused by name", async () => {
    const d = deps({ fetchUser: async () => ({ email: "staff@distribute.you", phone: null, onboardingPhone: null }) });
    const row = await upsertHandoff(db, { orgId: ORG, userId: "u-nophone", campaignId: null });
    await expect(sayHello(d, row, "whatsapp")).rejects.toBeInstanceOf(NoPhoneError);
    expect(d.startProactiveTurn).not.toHaveBeenCalled();
  });

  it("an email hello files their act through the Lead event hand-off, once", async () => {
    const d = deps();
    const row = await upsertHandoff(db, { orgId: ORG, userId: "u-mail", campaignId: CAMPAIGN });
    const after = await sayHello(d, row, "email");
    expect(handoffBody(after).hellos.email?.status).toBe("on_its_way");
    const body = (d.handOverByEmail as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body).toMatchObject({ email: "staff@distribute.you", phone: "+33600000000" });
    expect(body.messages.at(-1).text).toMatch(/continue with Distry by email/);
    await sayHello(d, after, "email");
    expect(d.handOverByEmail).toHaveBeenCalledTimes(1);
  });
});
