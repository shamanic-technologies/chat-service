import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { like } from "drizzle-orm";
import * as schema from "../../src/db/schema.js";
import { submitStaffRequest, type StaffRequestInput, type StaffRequestDeps } from "../../src/lib/staff-requests.js";
import { fileContactHuman, fileSkillUpgrade } from "../../src/lib/agent-requests.js";

const connectionString = process.env.CHAT_SERVICE_DATABASE_URL;
const RUN = Date.now().toString(36);

const input: StaffRequestInput = {
  kind: "feature",
  repo: "campaign-service",
  pieceKey: "whatsapp-follow-up-if-no-reply",
  title: "WhatsApp follow-up 3 days after an unanswered email",
  userRequest: "WhatsApp them 3 days later if no reply",
  missingPiece: "A reactive leg that fires when an email got no reply after 3 days.",
  decomposition: [
    { piece: "LinkedIn engagement source", outcome: "exists" },
    { piece: "WhatsApp 3 days later if no reply", outcome: "needs_code" },
  ],
};

function deps(email: string | null, issue: "ok" | "fail" = "ok") {
  const d = {
    fetchRequesterEmail: vi.fn(async () => email),
    openGithubIssue: vi.fn(async () => {
      if (issue === "fail") throw new Error("GITHUB_ISSUES_TOKEN not configured");
      return { url: "https://github.com/shamanic-technologies/campaign-service/issues/1", number: 1 };
    }),
    sendStaffTelegram: vi.fn(async () => ({ ok: true as const })),
  };
  return d as typeof d & StaffRequestDeps;
}

describe("staff requests", { timeout: 30000 }, () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(() => {
    if (!connectionString) throw new Error("CHAT_SERVICE_DATABASE_URL required for integration tests");
    client = postgres(connectionString);
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    await db.delete(schema.staffRequests).where(like(schema.staffRequests.orgId, `org-${RUN}%`));
    await client?.end();
  });

  it("records, opens one issue, pings staff once; a repeat is deduped", async () => {
    const ctx = { orgId: `org-${RUN}-a`, userId: "u-1", brandId: "b-1", sessionId: null };
    const d = deps("client@acme.com");
    const first = await submitStaffRequest(db as never, ctx, input, d);
    expect(first.duplicate).toBe(false);
    expect(first.issueUrl).toContain("/issues/1");
    expect(first.staffPinged).toBe(true);
    expect(d.openGithubIssue).toHaveBeenCalledTimes(1);
    expect(d.openGithubIssue.mock.calls[0][0]).toBe("campaign-service");
    expect(d.sendStaffTelegram).toHaveBeenCalledTimes(1);

    const again = await submitStaffRequest(db as never, ctx, input, d);
    expect(again.duplicate).toBe(true);
    expect(again.requestId).toBe(first.requestId);
    expect(again.requestCount).toBe(2);
    expect(d.openGithubIssue).toHaveBeenCalledTimes(1);
    expect(d.sendStaffTelegram).toHaveBeenCalledTimes(1);
  });

  it("a staff requester gets the record and the issue, never the Telegram ping", async () => {
    const d = deps("kevin+test@distribute.you");
    const r = await submitStaffRequest(db as never, { orgId: `org-${RUN}-b`, userId: "u-2", brandId: null, sessionId: null }, input, d);
    expect(r.issueUrl).not.toBeNull();
    expect(r.staffPinged).toBe(false);
    expect(r.telegramSkippedReason).toBe("requester_is_staff");
    expect(d.sendStaffTelegram).not.toHaveBeenCalled();
  });

  it("keeps the request when the issue cannot be opened, and retries the issue on a repeat", async () => {
    const ctx = { orgId: `org-${RUN}-c`, userId: "u-3", brandId: null, sessionId: null };
    const failed = await submitStaffRequest(db as never, ctx, input, deps("a@b.com", "fail"));
    expect(failed.issueUrl).toBeNull();
    expect(failed.issueError).toMatch(/GITHUB_ISSUES_TOKEN/);

    const retried = await submitStaffRequest(db as never, ctx, input, deps("a@b.com"));
    expect(retried.duplicate).toBe(true);
    expect(retried.issueUrl).toContain("/issues/1");
    expect(retried.issueError).toBeNull();
  });

  it("dedupes per org: another org's same request is its own row", async () => {
    const a = await submitStaffRequest(db as never, { orgId: `org-${RUN}-d1`, userId: "u", brandId: null, sessionId: null }, input, deps("x@y.com"));
    const b = await submitStaffRequest(db as never, { orgId: `org-${RUN}-d2`, userId: "u", brandId: null, sessionId: null }, input, deps("x@y.com"));
    expect(a.requestId).not.toBe(b.requestId);
    expect(b.duplicate).toBe(false);
  });
});

describe("agent requests: skill upgrade and contact a human", { timeout: 30000 }, () => {
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(() => {
    if (!connectionString) throw new Error("CHAT_SERVICE_DATABASE_URL required for integration tests");
    client = postgres(connectionString);
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    await db.delete(schema.staffRequests).where(like(schema.staffRequests.orgId, `org-${RUN}%`));
    await client?.end();
  });

  it("contact_human: no issue, an immediate Telegram ping, then one ping per org per window", async () => {
    const ctx = { orgId: `org-${RUN}-h`, userId: "u-h", brandId: null, sessionId: null };
    const d = deps("client@acme.com");
    const first = await fileContactHuman(db as never, ctx, { reason: "Wants a call", message: "Call me please" }, d);
    expect(first.kind).toBe("contact_human");
    expect(first.issueUrl).toBeNull();
    expect(first.staffPinged).toBe(true);
    expect(d.openGithubIssue).not.toHaveBeenCalled();
    expect(d.sendStaffTelegram).toHaveBeenCalledTimes(1);

    const second = await fileContactHuman(db as never, ctx, { reason: "Another thing", message: "Still waiting" }, d);
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.staffPinged).toBe(false);
    expect(second.telegramSkippedReason).toBe("recent_contact_already_pinged");
    expect(d.sendStaffTelegram).toHaveBeenCalledTimes(1);
  });

  it("skill_upgrade on an unknown skill is refused; on a service doc it opens the issue in that repo", async () => {
    const ctx = { orgId: `org-${RUN}-s`, userId: "u-s", brandId: null, sessionId: null };
    const d = deps("client@acme.com");
    await expect(
      fileSkillUpgrade(db as never, ctx, { skillSlug: `nope-${RUN}`, title: "t", problem: "p", proposedChange: "c" }, d),
    ).rejects.toThrow(/No skill/);
    const r = await fileSkillUpgrade(db as never, ctx, { repo: "features-service", title: "Doc gap", problem: "p", proposedChange: "c" }, d);
    expect(r.kind).toBe("skill_upgrade");
    expect(d.openGithubIssue.mock.calls[0][0]).toBe("features-service");
    expect(d.openGithubIssue.mock.calls[0][1]).toMatch(/^\[Copilot skill upgrade\]/);
  });
});
