import { describe, it, expect, vi, afterEach } from "vitest";
import {
  LEAD_ANSWER_TOOL_NAME,
  buildLeadAnswerTool,
  buildLeadTurnBlock,
  leadTurnBilling,
  leadTurnToolNames,
  parseLeadTurnStream,
  limitNoticeAnswer,
  processLeadTurn,
  resolveLeadAccount,
  type LeadTurnDeps,
  type LeadTurnFrame,
} from "../../src/lib/lead-turn.js";
import { LeadTurnRequestSchema, type LeadTurnRequest } from "../../src/schemas.js";
import { CLIENT_UI_TOOL_NAMES } from "../../src/lib/ui-tools.js";
import { AFTER_SIGN_IN_LINE } from "../../src/lib/channel-copilot.js";
import { REACH_ELSEWHERE_TOOL_NAME, leadTurnCaller } from "../../src/lib/lead-contact.js";
import { endToolFinalNote, endToolNudgeNote } from "../../src/lib/tool-budget.js";
import { DISTRY_LIMIT_NOTICE_GUEST, DISTRY_LIMIT_SUBJECT, type DistryGate, type DistryPerson } from "../../src/lib/distry-spend.js";

/** Distry's limits never reached here (their own tests: distry-spend-pg, and the capped door tests). */
const PASS_GATE: DistryGate = { gate: async (person) => ({ run: true, tracked: false, person }), record: async () => {} };

const BRAND = "22222222-2222-4222-8222-222222222222";
const SCHEMA = { type: "object", properties: { decision: { type: "string" }, message: { type: "string" } }, required: ["decision", "message"] };
const PAYLOAD: LeadTurnRequest = {
  idempotencyKey: "occ-1",
  brandId: BRAND,
  medium: "whatsapp",
  recipient: { email: "a@b.co", phone: "+33600000001", name: "Aakash" },
  assistant: { name: "Sophie", role: "Assistant", instructions: "warm" },
  systemPrompt: "THE GAME",
  message: "THE THREAD",
  responseSchema: SCHEMA,
  messageField: "message",
};
const frame = (over: Partial<LeadTurnFrame> = {}): LeadTurnFrame => ({ payload: PAYLOAD, ownBrand: true, guest: false, phoneBound: true, afterSignIn: false, ...over });
const sse = (...events: unknown[]) => events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");

afterEach(() => {
  delete process.env.COPILOT_FOLLOWUP_BRAND_ID;
});

describe("LeadTurnRequestSchema", () => {
  it("accepts the writer's call and refuses a messageField that is not a string property, or no recipient id", () => {
    expect(LeadTurnRequestSchema.safeParse(PAYLOAD).success).toBe(true);
    expect(LeadTurnRequestSchema.safeParse({ ...PAYLOAD, messageField: "nope" }).success).toBe(false);
    expect(LeadTurnRequestSchema.safeParse({ ...PAYLOAD, recipient: { email: null, phone: null, name: "x" } }).success).toBe(false);
  });
});

describe("leadTurnToolNames / buildLeadAnswerTool", () => {
  it("drops the client-UI tools (no screen) and always ends on answer_person", () => {
    expect(leadTurnToolNames(["list_campaigns", "present_choices", "open_page", "request_user_input"], CLIENT_UI_TOOL_NAMES)).toEqual(["list_campaigns", REACH_ELSEWHERE_TOOL_NAME, LEAD_ANSWER_TOOL_NAME]);
    // Any brand's lead can ask to be reached elsewhere (CONTACT-REDIRECT-1101).
    expect(leadTurnToolNames([], CLIENT_UI_TOOL_NAMES)).toEqual([REACH_ELSEWHERE_TOOL_NAME, LEAD_ANSWER_TOOL_NAME]);
  });
  it("the answer tool's input IS the writer's schema and names the message field", () => {
    const tool = buildLeadAnswerTool(SCHEMA, "message");
    expect(tool.input_schema).toBe(SCHEMA);
    expect(tool.description).toContain("`message`");
  });
  it("the tool-budget notes name the tool to call, never tools-off", () => {
    expect(endToolFinalNote("answer_person")).toContain("call answer_person now");
    expect(endToolNudgeNote("answer_person")).toContain("call answer_person now");
  });
});

describe("buildLeadTurnBlock", () => {
  it("our brand on WhatsApp: the same channel block as Sophie's line, then the game and the thread", () => {
    const block = buildLeadTurnBlock(frame());
    expect(block).toContain("## Channel: WhatsApp");
    expect(block).toContain("as Sophie, Assistant");
    expect(block).toContain("answer_person ONCE");
    expect(block.indexOf("THE GAME")).toBeLessThan(block.indexOf("THE THREAD"));
    expect(block).not.toContain("not as distribute.you");
  });
  it("states today's date before the campaign's facts (a lead was promised a Sunday send, 2026-11-01)", () => {
    const block = buildLeadTurnBlock(frame({ now: new Date("2026-11-01T12:00:00Z") }));
    expect(block).toContain("Today: Sunday 1 November 2026 (UTC).");
    expect(block.indexOf("Today:")).toBeLessThan(block.indexOf("### What the campaign knows"));
  });
  it("another brand: never speaks as distribute.you, no channel block of ours", () => {
    const block = buildLeadTurnBlock(frame({ ownBrand: false, guest: true, phoneBound: false }));
    expect(block).not.toContain("## Channel: WhatsApp");
    expect(block).toContain("not as distribute.you");
    expect(block).toContain("How you speak here: warm");
  });
  it("email: written as an email reply, in the format of the field the writer reads (bodyHtml = HTML)", () => {
    const schema = { type: "object", properties: { bodyHtml: { type: "string" } } };
    const block = buildLeadTurnBlock(frame({ payload: { ...PAYLOAD, medium: "email", responseSchema: schema, messageField: "bodyHtml" }, phoneBound: false }));
    expect(block).toContain("email reply");
    expect(block).toContain("`bodyHtml`");
    expect(block).not.toContain("plain text");
  });
  it("after a sign-in: ONE line, the same as every channel's, said once (nothing before reached them)", () => {
    const count = (b: string) => b.split(AFTER_SIGN_IN_LINE).length - 1;
    expect(AFTER_SIGN_IN_LINE).toContain("this answer is the ONE message they read");
    expect(count(buildLeadTurnBlock(frame({ afterSignIn: true })))).toBe(1);
    expect(count(buildLeadTurnBlock(frame({ afterSignIn: true, phoneBound: false, guest: true })))).toBe(1);
    expect(count(buildLeadTurnBlock(frame()))).toBe(0);
  });
});

describe("parseLeadTurnStream", () => {
  it("reads the answer, an error and out of credits", () => {
    expect(parseLeadTurnStream(sse({ type: "token", content: "x" }, { type: "lead_answer", answer: { message: "hi" }, model: "m" }, "[DONE]"))).toMatchObject({ answer: { message: "hi" }, model: "m" });
    expect(parseLeadTurnStream(sse({ type: "error", message: "boom" })).error).toBe("boom");
    expect(parseLeadTurnStream(sse({ type: "credits_required", message: "out" })).creditsRequired).toBe(true);
  });
});

// A scripted db: each select answers the next scripted rows; updates are recorded.
function fakeDb(selects: unknown[][], inserts: unknown[][] = []) {
  const updates: Array<Record<string, unknown>> = [];
  const chain = (rows: unknown) => {
    const p = Promise.resolve(rows) as Promise<unknown> & { orderBy: () => unknown; limit: () => Promise<unknown> };
    p.orderBy = () => ({ limit: () => Promise.resolve(rows) });
    p.limit = () => Promise.resolve(rows);
    return p;
  };
  const db = {
    select: () => ({ from: () => ({ where: () => chain(selects.shift() ?? []) }) }),
    update: () => ({ set: (s: Record<string, unknown>) => ({ where: () => { updates.push(s); return Promise.resolve(); } }) }),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve(inserts.shift() ?? []) }) }),
  };
  return { db: db as unknown as LeadTurnDeps["db"], updates };
}

const CALLER = { orgId: "org-ours", userId: "user-line", runId: "run-writer", trackingHeaders: { "x-campaign-id": "camp-1" } };
const ROW = { id: "row-1", idempotencyKey: "occ-1", orgId: CALLER.orgId, payload: PAYLOAD };

describe("processLeadTurn", () => {
  it("a guest who signs in during the turn: the account writes the whole answer, in its own run", async () => {
    process.env.COPILOT_FOLLOWUP_BRAND_ID = BRAND;
    const answered = { id: "row-1", status: "answered", answer: { decision: "write", message: "You're in. Your balance is $3." }, model: "m", sessionId: "sess-g", accountOrgId: "org-person", accountUserId: "user-person", signedIn: true };
    const { db, updates } = fakeDb(
      // ROW, no account bound to the number, the guest session, the session after sign-in, the stored answer.
      [[ROW], [], [{ id: "sess-g", orgId: CALLER.orgId, userId: CALLER.userId }], [{ orgId: "org-person", userId: "user-person", guest: false }], [answered]],
    );
    const runChat = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: sse({ type: "lead_answer", answer: { decision: "write", message: "You're in." } }) })
      .mockResolvedValueOnce({ status: 200, body: sse({ type: "lead_answer", answer: answered.answer, model: "m" }) });
    const createRootRun = vi.fn().mockResolvedValue("run-person");
    const createCallerRun = vi.fn().mockResolvedValue("run-bill");
    const out = await processLeadTurn(
      { db, resolvePhone: async () => null, resolveEmail: async () => null, listBrandIds: async () => [], createRootRun, createCallerRun, runChat, spend: PASS_GATE },
      "row-1",
      CALLER,
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ json: answered.answer, signedIn: true, account: { orgId: "org-person", userId: "user-person" } });
    // First turn: the guest session under our org, child of the writer's run.
    expect(runChat.mock.calls[0][0]).toMatchObject({ orgId: CALLER.orgId, runId: "run-writer", sessionId: "sess-g", trackingHeaders: CALLER.trackingHeaders });
    // Second turn: as the person, in their own run (never a cross-org child), no caller attribution.
    expect(runChat.mock.calls[1][0]).toMatchObject({ orgId: "org-person", userId: "user-person", runId: "run-person", trackingHeaders: {} });
    expect(updates.some((u) => u.signedIn === true)).toBe(true);
    // Its model spend: one run under the writer's run, in the caller's org (MODEL-TAG-EVERY-AI-MESSAGE-1126).
    expect(createCallerRun).toHaveBeenCalledTimes(1);
    expect(createCallerRun).toHaveBeenCalledWith(CALLER);
  });

  // MODEL-TAG-EVERY-AI-MESSAGE-1126: an account in another org bills its model calls on a run under the
  // caller's run (the writer's run tree names the model); a turn in the caller's org opens none.
  it("an account in another org: /chat bills on a run under the writer's run, set only while it runs; the spend record names it", async () => {
    process.env.COPILOT_FOLLOWUP_BRAND_ID = BRAND;
    const answered = { id: "row-1", status: "answered", answer: { decision: "write", message: "Hi" }, model: "m", sessionId: "sess-a", accountOrgId: "org-person", accountUserId: "user-person", signedIn: false };
    // ROW, their lead thread, the stored answer.
    const { db } = fakeDb([[ROW], [{ id: "sess-a", brandIds: [BRAND] }], [answered]]);
    const seen: unknown[] = [];
    const runChat = vi.fn(async (args: { leadTurnId: string }) => {
      seen.push(leadTurnBilling(args.leadTurnId));
      return { status: 200, body: sse({ type: "lead_answer", answer: answered.answer, model: "m" }) };
    });
    const createCallerRun = vi.fn().mockResolvedValue("run-bill");
    const verdict = { run: true as const, tracked: true, person: { key: "org:org-person", surface: "whatsapp", guest: false, turnOrgId: "org-person", planOrgId: null } as DistryPerson };
    const record = vi.fn(async () => {});
    const out = await processLeadTurn(
      {
        db,
        resolvePhone: async () => ({ orgId: "org-person", userId: "user-person" }),
        resolveEmail: async () => null,
        listBrandIds: async () => [],
        createRootRun: vi.fn().mockResolvedValue("run-person"),
        createCallerRun,
        runChat,
        spend: { gate: async () => verdict, record },
      },
      "row-1",
      CALLER,
    );
    expect(out.status).toBe(200);
    expect(runChat.mock.calls[0][0]).toMatchObject({ orgId: "org-person", runId: "run-person" });
    expect(seen).toEqual([{ orgId: CALLER.orgId, userId: CALLER.userId, runId: "run-bill", trackingHeaders: CALLER.trackingHeaders }]);
    expect(createCallerRun).toHaveBeenCalledWith(CALLER);
    expect(record).toHaveBeenCalledWith(verdict, "run-bill", null, CALLER.orgId);
    expect(leadTurnBilling("row-1")).toBeNull();
  });

  it("a turn in the caller's org opens no billing run: it is the caller's run already", async () => {
    const { db } = fakeDb([[ROW], [{ id: "sess-new" }]], [[{ id: "sess-new" }]]);
    const createCallerRun = vi.fn();
    const runChat = vi.fn(async (args: { leadTurnId: string }) => {
      expect(leadTurnBilling(args.leadTurnId)).toBeNull();
      return { status: 200, body: sse({ type: "lead_answer", answer: { decision: "write", message: "Hi" } }) };
    });
    await processLeadTurn({ db, resolvePhone: async () => null, resolveEmail: async () => null, listBrandIds: async () => [], createRootRun: vi.fn(), createCallerRun, runChat, spend: PASS_GATE }, "row-1", CALLER);
    expect(runChat).toHaveBeenCalledTimes(1);
    expect(runChat.mock.calls[0][0]).toMatchObject({ orgId: CALLER.orgId, runId: "run-writer" });
    expect(createCallerRun).not.toHaveBeenCalled();
  });

  it("a turn with no answer is a named failure (502), stored failed", async () => {
    const { db, updates } = fakeDb([[ROW]], [[{ id: "sess-new" }]]);
    const out = await processLeadTurn(
      {
        db,
        resolvePhone: async () => null,
        resolveEmail: async () => null,
        listBrandIds: async () => [],
        createRootRun: vi.fn(),
      spend: PASS_GATE,
        spend: PASS_GATE,
        runChat: async () => ({ status: 200, body: sse({ type: "error", message: "The turn ended without answer_person." }) }),
      },
      "row-1",
      CALLER,
    );
    expect(out.status).toBe(502);
    expect(updates.at(-1)).toMatchObject({ status: "failed" });
  });

  it("out of credits is a 402, never an answer", async () => {
    const { db } = fakeDb([[ROW]], [[{ id: "sess-new" }]]);
    const out = await processLeadTurn(
      { db, resolvePhone: async () => null, resolveEmail: async () => null, listBrandIds: async () => [], createRootRun: vi.fn(), spend: PASS_GATE, runChat: async () => ({ status: 200, body: sse({ type: "credits_required", message: "out" }) }) },
      "row-1",
      CALLER,
    );
    expect(out.status).toBe(402);
    expect(out.body).toMatchObject({ error: "out_of_credits" });
  });
});

describe("CONTACT-REDIRECT-1101: the person moved to another number", () => {
  it("a number no account holds finds the account whose conversation is bound to it", async () => {
    const { db } = fakeDb([[{ orgId: "org-person", userId: "user-person" }]]);
    const moved = { ...PAYLOAD, recipient: { email: null, phone: "+8801952666418", name: null } };
    const account = await resolveLeadAccount({ db, resolvePhone: async () => null, resolveEmail: async () => null }, moved, true);
    expect(account).toEqual({ orgId: "org-person", userId: "user-person" });
    // Another brand's lead never reads an account of ours.
    expect(await resolveLeadAccount({ db, resolvePhone: async () => null, resolveEmail: async () => null }, moved, false)).toBeNull();
  });

  it("the turn's tools know the caller while it runs, never after", async () => {
    const { db } = fakeDb([[ROW]], [[{ id: "sess-new" }]]);
    let seen: unknown = null;
    await processLeadTurn(
      {
        db,
        resolvePhone: async () => null,
        resolveEmail: async () => null,
        listBrandIds: async () => [],
        createRootRun: vi.fn(),
      spend: PASS_GATE,
        spend: PASS_GATE,
        runChat: async () => {
          seen = leadTurnCaller("row-1");
          return { status: 200, body: sse({ type: "lead_answer", answer: { decision: "write", message: "hi" } }) };
        },
      },
      "row-1",
      CALLER,
    );
    expect(seen).toEqual({ orgId: CALLER.orgId, userId: CALLER.userId, runId: CALLER.runId });
    expect(leadTurnCaller("row-1")).toBeNull();
  });
});

describe("Distry's limits on a lead turn of our own brand (DISTRY-GUEST-CAPS-1119)", () => {
  const WRITER = {
    type: "object",
    properties: {
      decision: { enum: ["write", "later", "stop", "cannot_write", "escalate"], type: "string" },
      subject: { type: "string", description: "Email only: the subject line." },
      bodyHtml: { type: "string", description: "Email only: the body as simple HTML paragraphs." },
      message: { type: "string", description: "WhatsApp only: the plain text message." },
      nextFollowUpAt: { type: "string" },
      nextFollowUpWhy: { type: "string" },
      reason: { type: "string" },
      question: { type: "string" },
    },
    required: ["decision", "subject", "bodyHtml", "message", "nextFollowUpAt", "nextFollowUpWhy", "reason", "question"],
  };
  const NOW = new Date("2026-11-19T15:00:00Z");

  it("the notice in the writer's own schema: WhatsApp gets it as the message, a write decision, the next look tomorrow", () => {
    const a = limitNoticeAnswer({ responseSchema: WRITER, messageField: "message", medium: "whatsapp" }, DISTRY_LIMIT_NOTICE_GUEST, NOW);
    expect(a).toEqual({
      decision: "write",
      subject: "",
      bodyHtml: "",
      message: DISTRY_LIMIT_NOTICE_GUEST,
      nextFollowUpAt: "2026-11-20T09:00:00.000Z",
      nextFollowUpWhy: expect.stringContaining("opens again tomorrow"),
      reason: expect.stringContaining("Automatic limit notice"),
      question: "",
    });
  });

  it("email: a subject and the notice as HTML paragraphs with live links", () => {
    const a = limitNoticeAnswer({ responseSchema: WRITER, messageField: "bodyHtml", medium: "email" }, DISTRY_LIMIT_NOTICE_GUEST, NOW);
    expect(a.subject).toBe(DISTRY_LIMIT_SUBJECT);
    expect(a.message).toBe("");
    expect(a.bodyHtml).toContain('<p>Thanks for talking with Distry!');
    expect(a.bodyHtml).toContain('<a href="https://dashboard.distribute.you/sign-up">https://dashboard.distribute.you/sign-up</a>');
    expect(a.bodyHtml).toContain('<a href="https://wa.me/33680478702">');
  });

  it("a guest past the limit: the notice is the answer, no model runs, the row says why", async () => {
    process.env.COPILOT_FOLLOWUP_BRAND_ID = BRAND;
    const payload = { ...PAYLOAD, responseSchema: WRITER };
    const stored = { id: "row-1", status: "answered", answer: { decision: "write", message: DISTRY_LIMIT_NOTICE_GUEST }, model: "distry-limit-notice", sessionId: "sess-g", accountOrgId: null, accountUserId: null, signedIn: false };
    // ROW, no account bound to the number, the guest session (with its plan org), the stored answer.
    const { db, updates } = fakeDb([[{ ...ROW, payload }], [], [{ id: "sess-g", orgId: CALLER.orgId, userId: CALLER.userId, planOrgId: "org-plan-7" }], [stored]]);
    const runChat = vi.fn();
    const gate = vi.fn(async (person: DistryPerson) => ({ run: false as const, reason: "person_cap" as const, notice: DISTRY_LIMIT_NOTICE_GUEST, person }));
    const out = await processLeadTurn(
      { db, resolvePhone: async () => null, resolveEmail: async () => null, listBrandIds: async () => [], createRootRun: vi.fn(), runChat, spend: { gate, record: vi.fn() } },
      "row-1",
      CALLER,
    );
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ json: stored.answer, model: "distry-limit-notice" });
    expect(runChat).not.toHaveBeenCalled();
    expect(gate).toHaveBeenCalledWith({ key: "phone:+33600000001", surface: "whatsapp", guest: true, turnOrgId: CALLER.orgId, planOrgId: "org-plan-7" });
    expect(updates.at(-1)).toMatchObject({ status: "answered", model: "distry-limit-notice", error: "distry_limit:person_cap" });
    expect((updates.at(-1)!.answer as Record<string, unknown>).message).toBe(DISTRY_LIMIT_NOTICE_GUEST);
  });

  it("another brand's lead is never gated: its turn runs on that brand's own org", async () => {
    process.env.COPILOT_FOLLOWUP_BRAND_ID = "99999999-9999-4999-8999-999999999999";
    const { db } = fakeDb([[ROW]], [[{ id: "sess-new" }]]);
    const gate = vi.fn();
    const runChat = vi.fn(async () => ({ status: 200, body: sse({ type: "lead_answer", answer: { decision: "write", message: "hi" } }) }));
    await processLeadTurn({ db, resolvePhone: async () => null, resolveEmail: async () => null, listBrandIds: async () => [], createRootRun: vi.fn(), runChat, spend: { gate, record: vi.fn() } }, "row-1", CALLER);
    expect(gate).not.toHaveBeenCalled();
    expect(runChat).toHaveBeenCalledTimes(1);
  });
});
