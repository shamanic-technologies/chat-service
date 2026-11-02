import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { leadTurnStoredText, pickLeadSession } from "../../src/lib/lead-turn.js";
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
