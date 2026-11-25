import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { buildLeadTurnBlock, leadTurnStoredText, pickLeadSession } from "../../src/lib/lead-turn.js";
import type { LeadTurnRequest } from "../../src/schemas.js";

// SOPHIE-JCURVE-1102, prod 2026-11-01: four Lead event turns about Jcurve's CMO
// ran in his own dashboard chat; one left an HTML email body there, three left
// empty replies. A lead turn now runs in its own thread, never the web one.
const dialect = new PgDialect();
const sqlOf = (w: unknown) => dialect.sqlToQuery(w as SQL).sql;

function fakeDb(existing: Array<Record<string, unknown>>) {
  const wheres: string[] = [];
  const inserts: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({
      from: () => ({
        where: (w: unknown) => {
          wheres.push(sqlOf(w));
          return { orderBy: () => ({ limit: () => Promise.resolve(existing) }) };
        },
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserts.push(v);
        return { returning: () => Promise.resolve([{ id: "new-lead-thread" }]) };
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  };
  return { db, wheres, inserts };
}

const payload = {
  brandId: "brand-ours",
  medium: "email",
  recipient: { email: "james@jcurve.example", phone: null },
  messageField: "message",
} as unknown as LeadTurnRequest;
const caller = { orgId: "org-ours", userId: "u-ours", runId: "run-1", trackingHeaders: {} };

describe("lead turns run in a lead thread, never the person's web chat", () => {
  it("an account holder with no lead thread yet gets a new one (never their latest web session)", async () => {
    const { db, wheres, inserts } = fakeDb([]);
    const picked = await pickLeadSession(
      { db: db as never, listBrandIds: async () => ["brand-jcurve"] },
      { payload, ownBrand: true, account: { orgId: "org-jcurve", userId: "u-james" }, caller, runId: "run-1" },
    );
    expect(wheres[0]).toContain('"lead_thread" = $');
    expect(inserts).toEqual([expect.objectContaining({ orgId: "org-jcurve", userId: "u-james", leadThread: true, guest: false })]);
    expect(picked.sessionId).toBe("new-lead-thread");
  });

  it("a fresh session under the caller is a lead thread too", async () => {
    const { db, inserts } = fakeDb([]);
    await pickLeadSession({ db: db as never, listBrandIds: async () => [] }, { payload, ownBrand: false, account: null, caller, runId: "run-1" });
    expect(inserts[0]).toMatchObject({ leadThread: true, guest: true });
  });

  it("stores the text sent, or the decision when nothing goes out: never an empty message", () => {
    expect(leadTurnStoredText({ decision: "write", message: "Hi James" }, "message")).toBe("Hi James");
    expect(leadTurnStoredText({ decision: "later", followUpAt: "2026-11-05", message: "" }, "message")).toBe(
      '(Nothing sent to them now. Decision: {"decision":"later","followUpAt":"2026-11-05"})',
    );
    expect(leadTurnStoredText({ message: "   " }, "message")).toBe("(Nothing sent to them now.)");
  });
});

// DISTRY-START-DOOR-1125: a stranger who writes to us by email talks with Distry in ONE
// conversation per address on our brand (as a WhatsApp number has), and signs up there.
describe("the email door: a stranger writing to our brand", () => {
  const stranger = { ...payload, recipient: { email: "Visitor@Example.com", phone: null } } as unknown as LeadTurnRequest;

  it("a first email opens a guest lead thread tied to the address they write from", async () => {
    const { db, inserts } = fakeDb([]);
    const picked = await pickLeadSession({ db: db as never, listBrandIds: async () => [] }, { payload: stranger, ownBrand: true, account: null, caller, runId: "run-1" });
    expect(inserts[0]).toMatchObject({ channelEmail: "visitor@example.com", guest: true, leadThread: true, orgId: "org-ours" });
    expect(picked).toMatchObject({ guest: true, phoneBound: false });
  });

  it("their next email continues that same conversation (its plan and sign-up carry)", async () => {
    const { db, wheres, inserts } = fakeDb([{ id: "s-email", orgId: "org-ours", userId: "u-ours", guest: true, planOrgId: "plan-1" }]);
    const picked = await pickLeadSession({ db: db as never, listBrandIds: async () => [] }, { payload: stranger, ownBrand: true, account: null, caller, runId: "run-1" });
    expect(wheres[0]).toContain('"channel_email" = $');
    expect(wheres[0]).toContain('"web_visitor_id" is null');
    expect(inserts).toHaveLength(0);
    expect(picked).toMatchObject({ sessionId: "s-email", guest: true, planOrgId: "plan-1" });
  });

  it("another brand's lead is never tied to an address of ours", async () => {
    const { db, inserts } = fakeDb([]);
    await pickLeadSession({ db: db as never, listBrandIds: async () => [] }, { payload: stranger, ownBrand: false, account: null, caller, runId: "run-1" });
    expect(inserts[0]).toMatchObject({ channelEmail: null });
  });

  it("the turn tells Distry they sign up right in the thread, with the address they write from", () => {
    const frame = {
      payload: { ...stranger, systemPrompt: "Decide.", message: "Thread.", recipient: { email: "visitor@example.com", phone: null } } as unknown as LeadTurnRequest,
      ownBrand: true,
      guest: true,
      phoneBound: false,
      emailBound: true,
      afterSignIn: false,
      now: new Date("2026-11-25T10:00:00Z"),
    };
    const block = buildLeadTurnBlock(frame);
    expect(block).toContain("They write to us from visitor@example.com");
    expect(block).toContain("start_sign_in");
    expect(block).not.toContain("We host no account for this person");
    expect(buildLeadTurnBlock({ ...frame, emailBound: false })).toContain("We host no account for this person");
    const after = buildLeadTurnBlock({ ...frame, guest: false, afterSignIn: true });
    expect(after.match(/They signed in a moment ago/g)).toHaveLength(1);
  });
});
