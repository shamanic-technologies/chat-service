import { describe, it, expect, vi, afterEach } from "vitest";
import {
  LEAD_ANSWER_TOOL_NAME,
  buildLeadAnswerTool,
  buildLeadTurnBlock,
  leadTurnToolNames,
  parseLeadTurnStream,
  processLeadTurn,
  type LeadTurnDeps,
  type LeadTurnFrame,
} from "../../src/lib/lead-turn.js";
import { LeadTurnRequestSchema, type LeadTurnRequest } from "../../src/schemas.js";
import { CLIENT_UI_TOOL_NAMES } from "../../src/lib/ui-tools.js";
import { endToolFinalNote, endToolNudgeNote } from "../../src/lib/tool-budget.js";

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
    expect(leadTurnToolNames(["list_campaigns", "present_choices", "open_page", "request_user_input"], CLIENT_UI_TOOL_NAMES)).toEqual(["list_campaigns", LEAD_ANSWER_TOOL_NAME]);
    expect(leadTurnToolNames([], CLIENT_UI_TOOL_NAMES)).toEqual([LEAD_ANSWER_TOOL_NAME]);
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
  it("another brand: never speaks as distribute.you, no channel block of ours", () => {
    const block = buildLeadTurnBlock(frame({ ownBrand: false, guest: true, phoneBound: false }));
    expect(block).not.toContain("## Channel: WhatsApp");
    expect(block).toContain("not as distribute.you");
    expect(block).toContain("How you speak here: warm");
  });
  it("email: written as an email reply", () => {
    expect(buildLeadTurnBlock(frame({ payload: { ...PAYLOAD, medium: "email" }, phoneBound: false }))).toContain("email reply");
  });
  it("after a sign-in: the whole message, nothing before reached them", () => {
    expect(buildLeadTurnBlock(frame({ afterSignIn: true }))).toContain("write the WHOLE message now");
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
      [[ROW], [{ id: "sess-g", orgId: CALLER.orgId, userId: CALLER.userId }], [{ orgId: "org-person", userId: "user-person", guest: false }], [answered]],
    );
    const runChat = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: sse({ type: "lead_answer", answer: { decision: "write", message: "You're in." } }) })
      .mockResolvedValueOnce({ status: 200, body: sse({ type: "lead_answer", answer: answered.answer, model: "m" }) });
    const createRootRun = vi.fn().mockResolvedValue("run-person");
    const out = await processLeadTurn(
      { db, resolvePhone: async () => null, resolveEmail: async () => null, listBrandIds: async () => [], createRootRun, runChat },
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
      { db, resolvePhone: async () => null, resolveEmail: async () => null, listBrandIds: async () => [], createRootRun: vi.fn(), runChat: async () => ({ status: 200, body: sse({ type: "credits_required", message: "out" }) }) },
      "row-1",
      CALLER,
    );
    expect(out.status).toBe(402);
    expect(out.body).toMatchObject({ error: "out_of_credits" });
  });
});
