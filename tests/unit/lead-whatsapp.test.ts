import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";
import {
  REPLY_TO_EVENT_ID_FIELD,
  REPLY_TO_FIELD,
  labelLines,
  leadTurnMoment,
  readWhatsappMoment,
  theirLatest,
  whatsappLinesFromItem,
  whatsappLinesOf,
  whatsappMomentBlock,
  withReplyToEventId,
  type WhatsappLine,
  type WhatsappMoment,
} from "../../src/lib/lead-whatsapp.js";
import { buildLeadAnswerTool, buildLeadTurnBlock, processLeadTurn, type LeadTurnDeps, type LeadTurnFrame } from "../../src/lib/lead-turn.js";
import { AMBIGUITY_LINE, QUOTE_AND_PHOTO_LINES, buildChannelBlock } from "../../src/lib/channel-copilot.js";
import { buildVendorTurnMessages, streamVendorChat } from "../../src/lib/vendor-chat.js";
import { estimateRequestTokensWithImages, imageDataUrl, prepareTurnImage, type TurnImage } from "../../src/lib/turn-images.js";
import type { LeadTurnRequest } from "../../src/schemas.js";

// SOPHIE-WA-HUMAN-1106 (prod 2026-11-04 « lui » after four lead proposals; owner
// 2026-11-06: see what I quote, see my photos, quote back, show typing).

const BRAND = "22222222-2222-4222-8222-222222222222";
const SCHEMA = { type: "object", properties: { decision: { type: "string" }, message: { type: "string" } }, required: ["decision", "message"], additionalProperties: false };
const PAYLOAD: LeadTurnRequest = {
  idempotencyKey: "occ-1",
  brandId: BRAND,
  medium: "whatsapp",
  recipient: { email: null, phone: "+33600000001", name: "Paul" },
  assistant: { name: "Sophie", role: "Assistant", instructions: null },
  systemPrompt: "THE GAME",
  message: "THE THREAD",
  responseSchema: SCHEMA,
  messageField: "message",
};

/** crm `GET /orgs/people/timeline` items, as crm-service serves them (TimelineItem). */
const ITEMS = [
  { at: "2026-11-04T08:56:00.000Z", source: "gmail", channel: "email", kind: "message", direction: "inbound", text: "Re: 1-month project", ref: { messageId: "g1" } },
  { at: "2026-11-04T11:45:00.000Z", source: "matrix", channel: "whatsapp", kind: "message", direction: "outbound", text: "Lead: Arjun, launch at $5 a day?", ref: { eventId: "$a" } },
  { at: "2026-11-04T11:47:00.000Z", source: "matrix", channel: "whatsapp", kind: "message", direction: "outbound", text: "Lead: Nimal, launch at $5 a day?", ref: { eventId: "$n" } },
  {
    at: "2026-11-04T13:42:00.000Z",
    source: "matrix",
    channel: "whatsapp",
    kind: "message",
    direction: "inbound",
    text: "tu veux dire lui écrire ?",
    ref: { eventId: "$q" },
    quote: { eventId: "$n", direction: "outbound", at: "2026-11-04T11:47:00.000Z", text: "Lead: Nimal, launch at $5 a day?" },
  },
  { at: "2026-11-04T13:43:00.000Z", source: "matrix", channel: "whatsapp", kind: "message", direction: "inbound", text: "📷 Photo", ref: { eventId: "$p" }, photo: { kind: "image", eventId: "$p", caption: null } },
];

async function pngBase64(): Promise<string> {
  const buf = await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 0, g: 128, b: 0 } } }).png().toBuffer();
  return buf.toString("base64");
}

describe("whatsappLinesOf / theirLatest", () => {
  it("keeps WhatsApp messages only, with their id, the message they quote and whether they are a photo", () => {
    const lines = whatsappLinesOf(ITEMS);
    expect(lines.map((l) => l.eventId)).toEqual(["$a", "$n", "$q", "$p"]);
    expect(lines[2].quote).toEqual({ eventId: "$n", direction: "outbound", at: "2026-11-04T11:47:00.000Z", text: "Lead: Nimal, launch at $5 a day?" });
    expect(lines[3].photo).toEqual({ caption: null });
    expect(lines[0].quote).toBeNull();
  });
  it("their latest = their messages since our last one", () => {
    expect(theirLatest(whatsappLinesOf(ITEMS)).map((l) => l.eventId)).toEqual(["$q", "$p"]);
  });
});

describe("whatsappMomentBlock", () => {
  const shown = labelLines(whatsappLinesOf(ITEMS));
  it("labels every message, shows what a message replies to (with its label) and how to quote back", () => {
    const block = whatsappMomentBlock({ shown, images: [], unreadablePhotos: [] }, REPLY_TO_FIELD);
    expect(block).toContain("m2 | 2026-11-04 11:47 UTC | us: Lead: Nimal");
    expect(block).toContain('m3 | 2026-11-04 13:42 UTC | them [replying to m2, us 2026-11-04 11:47 UTC: "Lead: Nimal, launch at $5 a day?"]: tu veux dire lui écrire ?');
    expect(block).toContain("`replyTo`");
  });
  it("says a photo is attached, and names a photo it could not load", () => {
    const img = { mimeType: "image/png", base64: "x", width: 10, height: 10 } as TurnImage;
    const block = whatsappMomentBlock({ shown, images: [img], unreadablePhotos: ["$z"] }, REPLY_TO_FIELD);
    expect(block).toContain("attached to this turn as image");
    expect(block).toContain("could not be loaded");
  });
  it("nothing to show = no block", () => {
    expect(whatsappMomentBlock({ shown: [], images: [], unreadablePhotos: [] }, REPLY_TO_FIELD)).toBe("");
  });
});

describe("withReplyToEventId", () => {
  const labels = new Map([["m2", "$n"]]);
  it("the label she quotes becomes the message's event id, the label field is dropped", () => {
    expect(withReplyToEventId({ decision: "write", message: "hi", [REPLY_TO_FIELD]: "M2" }, labels)).toEqual({ decision: "write", message: "hi", [REPLY_TO_EVENT_ID_FIELD]: "$n" });
  });
  it("no label or an unknown one quotes nothing", () => {
    expect(withReplyToEventId({ message: "hi" }, labels)[REPLY_TO_EVENT_ID_FIELD]).toBeNull();
    expect(withReplyToEventId({ message: "hi", [REPLY_TO_FIELD]: "m9" }, labels)[REPLY_TO_EVENT_ID_FIELD]).toBeNull();
  });
});

/** crm-service's Lead event record for a WhatsApp burst (`item.thread[]` + `item.messages[]`, PR #256). */
const ITEM = {
  kind: "reply",
  source: "matrix",
  thread: [
    { at: "2026-11-04T11:45:00.000Z", direction: "outbound", kind: "message", text: "Lead: Arjun, launch at $5 a day?", eventId: "$a" },
    { at: "2026-11-04T11:46:00.000Z", direction: "outbound", kind: "call", text: "Missed voice call", eventId: "$c" },
    { at: "2026-11-04T11:47:00.000Z", direction: "outbound", kind: "message", text: "Lead: Nimal, launch at $5 a day?", eventId: "$n" },
  ],
  messages: [
    { eventId: "$q", at: "2026-11-04T13:42:00.000Z", text: "tu veux dire lui écrire ?", quote: { eventId: "$n", direction: "outbound", at: "2026-11-04T11:47:00.000Z", text: "Lead: Nimal, launch at $5 a day?" } },
    { eventId: "$p", at: "2026-11-04T13:43:00.000Z", text: "📷 Photo", photo: { kind: "image", eventId: "$p", mimeType: "image/jpeg", sizeBytes: 1, width: 1, height: 1, caption: null } },
  ],
};

describe("whatsappLinesFromItem (the Lead event's own record)", () => {
  it("the thread then their burst, oldest first, with ids, quotes and photos; a call is not a message", () => {
    const lines = whatsappLinesFromItem(ITEM);
    expect(lines.map((l) => `${l.direction}:${l.eventId}`)).toEqual(["outbound:$a", "outbound:$n", "inbound:$q", "inbound:$p"]);
    expect(lines[2].quote?.eventId).toBe("$n");
    expect(lines[3].photo).toEqual({ caption: null });
  });
  it("an email event, or no record, has no WhatsApp lines", () => {
    expect(whatsappLinesFromItem({ kind: "reply", source: "gmail", subject: "x" })).toEqual([]);
    expect(whatsappLinesFromItem(null)).toEqual([]);
  });
});

describe("readWhatsappMoment", () => {
  const caller = { orgId: "o", userId: "u", runId: "r" };
  it("loads the photos of their latest messages only, fitted for the model", async () => {
    const readPhoto = vi.fn().mockResolvedValue({ base64: await pngBase64(), mimeType: "image/png", sentAt: null, caption: null });
    const m = await readWhatsappMoment({ caller, brandId: BRAND, item: ITEM }, { readPhoto });
    expect(readPhoto).toHaveBeenCalledTimes(1);
    expect(readPhoto.mock.calls[0][0]).toMatchObject({ eventId: "$p", brandId: BRAND, caller });
    expect(m.images).toHaveLength(1);
    expect(m.images[0]).toMatchObject({ mimeType: "image/png", width: 300, height: 300, at: "2026-11-04T13:43:00.000Z" });
    expect(m.labels.get("m4")).toBe("$p");
  });
  it("a photo crm cannot serve is named, never silently dropped", async () => {
    const m = await readWhatsappMoment({ caller, brandId: BRAND, item: ITEM }, { readPhoto: async () => { throw new Error("502"); } });
    expect(m.images).toEqual([]);
    expect(m.unreadablePhotos).toEqual(["$p"]);
  });
});

describe("the answer and the turn block", () => {
  const moment: WhatsappMoment = { shown: labelLines(whatsappLinesOf(ITEMS)), labels: new Map(), images: [], unreadablePhotos: [] };
  const frame = (over: Partial<LeadTurnFrame> = {}): LeadTurnFrame => ({ payload: PAYLOAD, ownBrand: true, guest: false, phoneBound: true, afterSignIn: false, ...over });
  it("a WhatsApp turn that lists the conversation can quote: replyTo joins the writer's schema", () => {
    const tool = buildLeadAnswerTool(SCHEMA, "message", { replyTo: true });
    expect(Object.keys((tool.input_schema as { properties: object }).properties)).toEqual(["decision", "message", REPLY_TO_FIELD]);
    expect(buildLeadAnswerTool(SCHEMA, "message").input_schema).toBe(SCHEMA);
  });
  it("the conversation as WhatsApp shows it comes after the campaign's facts", () => {
    const block = buildLeadTurnBlock(frame({ whatsapp: moment }));
    expect(block.indexOf("### What the campaign knows")).toBeLessThan(block.indexOf("[replying to m2"));
    expect(buildLeadTurnBlock(frame({ payload: { ...PAYLOAD, medium: "email" }, whatsapp: moment }))).not.toContain("[replying to");
  });
  it("the ambiguity, quote and photo strategy reaches every WhatsApp turn: our line's block, and another brand's lead", () => {
    const ours = buildLeadTurnBlock(frame());
    const theirs = buildLeadTurnBlock(frame({ ownBrand: false, guest: true, phoneBound: false }));
    for (const block of [ours, theirs]) {
      expect(block).toContain(AMBIGUITY_LINE);
      for (const l of QUOTE_AND_PHOTO_LINES) expect(block).toContain(l);
    }
    expect(ours.split(AMBIGUITY_LINE).length).toBe(2);
    const web = buildChannelBlock({ kind: "whatsapp", assistant: { name: "Sophie", role: null, instructions: null }, sender: { phone: "+1" }, thread: [] }, false);
    expect(web).toContain(AMBIGUITY_LINE);
  });
});

// A scripted db for processLeadTurn (each select answers the next rows).
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

const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const CALLER = { orgId: "org-ours", userId: "user-line", runId: "run-writer", trackingHeaders: {} };
const ROW = { id: "row-wa", idempotencyKey: "occ-1", orgId: CALLER.orgId, payload: PAYLOAD };

describe("processLeadTurn on WhatsApp: typing and the conversation", () => {
  function deps(answer: Record<string, unknown> | null, log: string[]) {
    const moment: WhatsappMoment = { shown: [], labels: new Map(), images: [], unreadablePhotos: [] };
    // ROW, the session after the turn (still the guest's), the stored answer.
    const { db } = fakeDb([[ROW], [{ orgId: CALLER.orgId, userId: CALLER.userId, guest: true }], [{ id: "row-wa", status: "answered", answer, model: "m", sessionId: "s", accountOrgId: null, accountUserId: null, signedIn: false }]], [[{ id: "sess-new" }]]);
    return {
      db,
      resolvePhone: async () => null,
      resolveEmail: async () => null,
      listBrandIds: async () => [],
      createRootRun: vi.fn(),
      setWhatsappTyping: vi.fn(async (a: { state: string; caller: unknown; phone: string }) => {
        log.push(`typing:${a.state}`);
        expect(a.caller).toEqual({ orgId: CALLER.orgId, userId: CALLER.userId, runId: CALLER.runId });
        expect(a.phone).toBe("+33600000001");
      }),
      readWhatsappMoment: vi.fn(async () => {
        log.push("read");
        return moment;
      }),
      runChat: vi.fn(async () => {
        log.push(leadTurnMoment("row-wa") === moment ? "chat:moment" : "chat:none");
        return answer ? { status: 200, body: sse({ type: "lead_answer", answer }) } : { status: 200, body: sse({ type: "error", message: "boom" }) };
      }),
    } satisfies LeadTurnDeps;
  }

  it("typing starts before the turn, the turn reads the conversation, and a sent answer leaves the stop to the send", async () => {
    const log: string[] = [];
    const out = await processLeadTurn(deps({ decision: "write", message: "Tu parles de Nimal ?" }, log), "row-wa", CALLER);
    expect(out.status).toBe(200);
    expect(log).toEqual(["typing:start", "read", "chat:moment"]);
    expect(leadTurnMoment("row-wa")).toBeNull();
  });

  it("nothing to send now: typing stops", async () => {
    const log: string[] = [];
    await processLeadTurn(deps({ decision: "later", message: "" }, log), "row-wa", CALLER);
    expect(log).toEqual(["typing:start", "read", "chat:moment", "typing:stop"]);
  });

  it("a failed turn stops typing too", async () => {
    const log: string[] = [];
    const out = await processLeadTurn(deps(null, log), "row-wa", CALLER);
    expect(out.status).toBe(502);
    expect(log.at(-1)).toBe("typing:stop");
  });

  it("a crm failure never blocks the answer", async () => {
    const log: string[] = [];
    const d = deps({ decision: "write", message: "hi" }, log);
    d.setWhatsappTyping.mockRejectedValueOnce(new Error("crm 500"));
    d.readWhatsappMoment.mockRejectedValueOnce(new Error("crm 500"));
    const out = await processLeadTurn(d, "row-wa", CALLER);
    expect(out.status).toBe(200);
    expect(log).toContain("chat:none");
  });
});

describe("photos reach the model as images", () => {
  it("they ride on this turn's user message, after its words, introduced by one line", async () => {
    const img = await prepareTurnImage(Buffer.from(await pngBase64(), "base64"), { at: "2026-11-04T13:43:00.000Z", caption: null });
    const messages = buildVendorTurnMessages({ systemPrompt: "SYS", history: [], userMessage: "TRIGGER", turnContext: "CTX", images: [img] });
    const user = messages[1] as { role: string; content: Array<{ type: string; text?: string; image_url?: { url: string } }> };
    expect(user.role).toBe("user");
    expect(user.content[0]).toEqual({ type: "text", text: "TRIGGER" });
    expect(user.content[1].text).toContain("Photo 1 sent 2026-11-04T13:43:00.000Z with no words.");
    expect(user.content[2]).toEqual({ type: "image_url", image_url: { url: imageDataUrl(img) } });
    expect(messages[2]).toEqual({ role: "system", content: "CTX" });
  });

  it("a vendor never probed for images refuses them loud", async () => {
    const img = { mimeType: "image/png", base64: "x", width: 10, height: 10 } as TurnImage;
    await expect(
      streamVendorChat({
        vendor: "moonshot",
        apiKey: "k",
        model: "kimi-k2.6",
        costPrefix: "moonshot-kimi-k2.6",
        systemPrompt: "S",
        turnContext: "",
        history: [],
        userMessage: "hi",
        images: [img],
        tools: [],
        res: {} as never,
        sendSSE: () => undefined,
        executeTool: vi.fn(),
        signal: new AbortController().signal,
        beforeProviderCall: async () => undefined,
      }),
    ).rejects.toThrow("does not take image input");
  });

  it("the cost hold counts an image by its pixels, never by its base64 length", () => {
    const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(2_000_000)}` } }] }] };
    const tokens = estimateRequestTokensWithImages(body, [{ width: 1568, height: 882 }]);
    expect(tokens).toBeLessThan(6_000);
    expect(tokens).toBeGreaterThan(4_000);
  });
});

describe("the eval scenario lines follow crm's shape", () => {
  it("labels newest last", () => {
    const lines: WhatsappLine[] = whatsappLinesOf(ITEMS);
    expect(labelLines(lines, 2).map((l) => l.label + l.eventId)).toEqual(["m1$q", "m2$p"]);
  });
});
